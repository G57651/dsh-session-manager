// dsh-session-manager — host half.
//
// A cordis function plugin that serves the /dsh-session-manager RPC channel
// consumed by the web client half (client.js):
//
//   list      { view: 'all' | 'archived' | 'deleted' } -> rows + view counts
//   archive   { ids: SessionId[] }                     -> per-id results
//   unarchive { ids: SessionId[] }                     -> per-id results
//   delete    { ids: SessionId[] }  (soft, restorable) -> per-id results
//   restore   { ids: SessionId[] }                     -> per-id results
//   purge     { ids: SessionId[] }  (rm session dirs)  -> per-id results
//   config    {}                                       -> client-facing config
//
// Every handler returns `{ ok: true, value }` or `{ ok: false, error }`;
// batch endpoints take a single `ids` array so one RPC covers both the
// single-row quick actions and the batch toolbar.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import {
  archiveSessions,
  createManifestStore,
  createPurgeTracker,
  createTitleCache,
  listRows,
  loadHeaderMap,
  purgeSessions,
  restoreSessions,
  softDeleteSessions,
  unarchiveSessions,
} from './session-manage.js'

export const name = 'dsh-session-manager'
export const inject = ['connection']

/** RPC channel served by this plugin; consumed by client.js. */
export const CHANNEL = '/dsh-session-manager'

/**
 * @typedef {object} Config
 * @property {boolean} confirmPurge Ask before permanent deletion (client-side behavior).
 * @property {boolean} autoRefresh Refresh the list on live session events (client-side behavior).
 * @property {number} maxBatchSize Upper bound of ids accepted per batch request.
 * @property {number} titleFetchLimit Cold sessions whose titles are folded per list request.
 */

export const Config = Schema.object({
  confirmPurge: Schema.boolean().default(true),
  autoRefresh: Schema.boolean().default(true),
  maxBatchSize: Schema.number().default(200),
  titleFetchLimit: Schema.number().default(300),
})

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  return resolve(typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh'))
}

/**
 * Wire-format dispatcher: one endpoint table, strict `{ ok }` results, and
 * thrown errors normalized to `{ ok: false, error: { code, message } }`.
 */
function createDispatcher({ endpoints, logger }) {
  const registry = new Map(Object.entries(endpoints))
  return async (endpoint, payload) => {
    const definition = typeof endpoint === 'string' ? registry.get(endpoint) : undefined
    if (definition === undefined) return { ok: false, error: 'unknown-endpoint' }
    const input = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
    try {
      const result = await definition.handle(input, endpoint)
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return { ok: false, error: 'invalid-rpc-response' }
      }
      return result
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] ${endpoint} failed: ${error?.message ?? error}`)
      return { ok: false, error: { code: 'internal', message: error?.message ?? 'internal-error' } }
    }
  }
}

function withBatch(config, payload, run, logger) {
  const raw = Array.isArray(payload?.ids) ? payload.ids : []
  const ids = [...new Set(raw.filter(id => typeof id === 'string' && id !== ''))]
  if (ids.length === 0) return Promise.resolve({ ok: false, error: 'no-ids' })
  if (ids.length > config.maxBatchSize) return Promise.resolve({ ok: false, error: 'too-many-ids' })
  return run(ids).catch((error) => {
    logger?.warn?.(`[dsh-session-manager] batch failed: ${error?.message ?? error}`)
    return { ok: false, error: { code: 'internal', message: error?.message ?? 'internal-error' } }
  })
}

/**
 * Fallback seam used only when `connection.rpc.handle` refuses the channel:
 * serve the same JSON envelope directly on the web server, behind a loopback
 * fence (same degradation path @gehennawu/dsh-service uses).
 */
function registerDirectRpcWebRoute(ctx, webServer, channel, dispatch, logger) {
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const host = String(req.headers.host ?? '').split(':')[0]
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const body = await readRequestBody(req)
        const request = JSON.parse(body || '{}')
        const suffix = typeof req.url === 'string' ? req.url.split('?')[0].replace(/^.*\/dsh-session-manager\/?/, '') : ''
        const endpoint = suffix !== '' ? suffix : String(request.method ?? '')
        const result = await dispatch(endpoint, request.payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId ?? 'direct-rpc', result }))
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] direct rpc route failed: ${error?.message ?? error}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'direct-rpc', result: { ok: false, error: 'bad-request' } }))
      }
    },
  }
  ctx.effect(() => webServer.register(route), `dsh-session-manager: ${channel} direct rpc route`)
}

function readRequestBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 4 * 1024 * 1024) reject(new Error('payload-too-large'))
    })
    req.on('end', () => resolvePromise(data))
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  const logger = ctx.logger
  const dshHome = resolveDshHome()
  const manifest = createManifestStore(join(dshHome, 'dsh-session-manager-deleted.json'), logger)
  const titleCache = createTitleCache(join(dshHome, 'dsh-session-manager-titles.json'), logger)
  const purgeTracker = createPurgeTracker()

  // Live sessions announce titles and renames through the session/title
  // session-event; fold them into the cache so cold rows stay current.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'session/title') return
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    titleCache.set(id, {
      title: typeof event.data?.title === 'string' && event.data.title !== '' ? event.data.title : null,
      updatedAt: Number.isFinite(event?.time) ? event.time : Date.now(),
    })
  })

  const deps = { ctx, config, dshHome, manifest, titleCache, logger }

  const endpoints = {
    list: {
      handle: async (payload) => {
        const view = payload?.view === 'archived' || payload?.view === 'deleted' ? payload.view : 'all'
        try {
          const value = await listRows(ctx, { view, manifest, titleCache, config, logger, purgeTracker })
          return { ok: true, value: { view, ...value } }
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] list failed: ${error?.message ?? error}`)
          return { ok: false, error: 'list-failed' }
        }
      },
    },
    archive: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const outcome = await archiveSessions(ctx, ids, logger)
        if (outcome.unavailable) return { ok: false, error: 'workspace-unavailable' }
        return { ok: true, value: { results: outcome.results, archivedSessionIds: outcome.archivedSessionIds } }
      }, logger),
    },
    unarchive: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const outcome = await unarchiveSessions(ctx, ids, logger)
        if (outcome.unavailable) return { ok: false, error: 'workspace-unavailable' }
        return { ok: true, value: { results: outcome.results, archivedSessionIds: outcome.archivedSessionIds } }
      }, logger),
    },
    delete: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const headers = await loadHeaderMap(ctx, logger)
        const value = await softDeleteSessions(ctx, ids, { headers, manifest, titleCache, logger })
        return { ok: true, value }
      }, logger),
    },
    restore: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const value = await restoreSessions(ctx, ids, { manifest, logger })
        return { ok: true, value }
      }, logger),
    },
    purge: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const headers = await loadHeaderMap(ctx, logger)
        const value = await purgeSessions(ctx, ids, { headers, manifest, dshHome, logger, purgeTracker })
        return { ok: true, value }
      }, logger),
    },
    config: {
      handle: async () => ({
        ok: true,
        value: {
          confirmPurge: config.confirmPurge === true,
          autoRefresh: config.autoRefresh === true,
          maxBatchSize: config.maxBatchSize,
        },
      }),
    },
  }

  const dispatch = createDispatcher({ endpoints, logger })
  try {
    const dispose = ctx.connection?.rpc?.handle?.(CHANNEL, dispatch, { authority: 'loopback' })
    if (typeof dispose === 'function') {
      ctx.effect(() => dispose, 'dsh-session-manager: rpc channel')
    }
    logger?.info?.(`[dsh-session-manager] serving ${CHANNEL}`)
  } catch (error) {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      logger?.warn?.(`[dsh-session-manager] connection rpc handle failed (${error?.message ?? error}); falling back to a direct webServer route`)
      registerDirectRpcWebRoute(ctx, webServer, CHANNEL, dispatch, logger)
    } else {
      logger?.warn?.(`[dsh-session-manager] connection rpc handle failed and no webServer seam available: ${error?.message ?? error}`)
    }
  }

  ctx.effect(() => async () => {
    await manifest.flush()
    await titleCache.flush()
  }, 'dsh-session-manager: flush stores')
}
