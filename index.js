// dsh-session-manager — host half.
//
// A cordis function plugin that serves the /dsh-session-manager RPC channel
// consumed by the web client half (client.js):
//
//   list          { view: 'all' | 'archived' | 'deleted' } -> rows + view counts
//   archive       { ids: SessionId[] }                     -> per-id results
//   unarchive     { ids: SessionId[] }                     -> per-id results
//   delete        { ids: SessionId[] }  (trash + rollback + rm dir) -> per-id results
//   restore       { ids: SessionId[] }                     -> per-id results
//   purge         { ids: SessionId[] }  (rollback + rm session dirs) -> per-id results
//   config        {}                                       -> client-facing config
//
//   -- resource lifecycle (v0.2.0) --
//   changes       { id, limit? }        -> the session's change journal tail
//   resources     { id }                -> baseline + journal-derived resource view
//   cleanupStatus { ids }               -> per-id cleanup state machine summary
//   cleanup       { ids, mode }         -> 'rollback-only' | 'resume' | 'full'
//   track         { ids }               -> run one diff pass now (ops/debug)
//   openResource  { id, path }          -> reveal in the OS file manager
//   deleteResources { id, paths }       -> copy into the plugin recycle bin,
//                                          then move to the OS wastebasket
//   recycleList    { id? }              -> plugin recycle bin entries
//   recycleRestore { entryId }          -> restore a bin entry to its original path
//
// Every handler returns `{ ok: true, value }` or `{ ok: false, error }`;
// batch endpoints take a single `ids` array so one RPC covers both the
// single-row quick actions and the batch toolbar.
//
// Error shape: rc.1's connection RPC contract is
// `{ code, message, details }` (packages/client/connection/src/rpc.ts:18-28),
// so every failure is built by `fail()` below. The client half still accepts a
// bare string for backwards compatibility.

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
import { createSessionResourceManager } from './lifecycle/manager.js'
import { createOpener } from './lifecycle/opener.js'
import { createTrash } from './lifecycle/trash.js'

export const name = 'dsh-session-manager'
// The endpoints resolve their services lazily via `ctx.get` at call time, but
// the inject list still has to name what the plugin actually needs so cordis
// orders its start after them (audit P7). `webServer` is intentionally absent:
// the direct web route is a fallback for when the RPC channel is refused, and
// injecting it would make this plugin PENDING on a service it may never use.
export const inject = ['connection', 'workspaceRegistry', 'sessionQuery']

/** RPC channel served by this plugin; consumed by client.js. */
export const CHANNEL = '/dsh-session-manager'

/**
 * @typedef {object} Config
 * @property {boolean} confirmPurge Ask before permanent deletion (client-side behavior).
 * @property {boolean} autoRefresh Refresh the list on live session events (client-side behavior).
 * @property {number} maxBatchSize Upper bound of ids accepted per batch request.
 * @property {number} titleFetchLimit Cold sessions whose titles are folded per list request.
 * @property {boolean} trackingEnabled Master switch for resource-lifecycle tracking.
 * @property {boolean} autoCleanup Run resource rollback on delete/purge (tracking must be on).
 * @property {boolean} autoResume Resume unfinished cleanups after a restart.
 * @property {number} trackingPollMs Periodic workspace diff; 0 disables (event-driven + final diff only).
 * @property {number} trackingIdleWindowMs Final-diff suspect threshold: records captured after this much session idle are preserved, not rolled back.
 * @property {number} trackingMaxFiles Baseline/diff walk cap per session workspace.
 * @property {number} trackingMaxDepth Baseline/diff depth cap per session workspace.
 * @property {number} trackingMaxSnapshotBytes Per-file before-content snapshot cap.
 * @property {string[]} trackingExclude Directory names excluded from tracking walks.
 * @property {string} conflictMode 'safe' skips conflicted resources; 'force' overwrites them.
 */

// `.volatile()` (vendor/schemastery/src/index.ts:480-482): changing one of these
// commits into the running fiber and dispatches `loader/volatile-update`
// (vendor/loader/src/index.ts:26-34) instead of remounting the plugin, which
// would drop the in-flight manifest/title-cache state and re-register the RPC
// channel. All fields are pure tuning knobs, so a remount is never warranted.
export const Config = Schema.object({
  confirmPurge: Schema.boolean().default(true).volatile(),
  autoRefresh: Schema.boolean().default(true).volatile(),
  maxBatchSize: Schema.number().default(200).volatile(),
  titleFetchLimit: Schema.number().default(300).volatile(),
  trackingEnabled: Schema.boolean().default(true).volatile(),
  autoCleanup: Schema.boolean().default(true).volatile(),
  autoResume: Schema.boolean().default(true).volatile(),
  trackingPollMs: Schema.number().default(0).volatile(),
  trackingIdleWindowMs: Schema.number().default(5 * 60 * 1000).volatile(),
  trackingMaxFiles: Schema.number().default(5000).volatile(),
  trackingMaxDepth: Schema.number().default(12).volatile(),
  trackingMaxSnapshotBytes: Schema.number().default(8 * 1024 * 1024).volatile(),
  trackingExclude: Schema.array(Schema.string()).default([]).volatile(),
  conflictMode: Schema.union(['safe', 'force']).default('safe').volatile(),
})

/**
 * Build a contract-shaped RPC failure. `details` is always present because the
 * client-side failure type requires it (rpc.ts:18-28).
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 */
function fail(code, message, details) {
  return { ok: false, error: { code, message: message ?? code, details: details ?? {} } }
}

/**
 * Read one config field, tolerating both shapes. Schemastery hands every
 * `.volatile()` field to `apply` as a stable `{ get() }` reference (develop
 * docs §3.5: volatile changes commit into the running fiber without a
 * remount), so the live value must be read through `.get()`; a plain value is
 * returned verbatim, which keeps this working for a non-volatile Config.
 * @param {{ get?: () => unknown } | unknown} field
 */
function configValue(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * Snapshot every volatile field into plain values, once per RPC operation.
 * Values are captured per request rather than cached in a closure so a
 * volatile update (no remount) is visible on the next call, while a single
 * request never observes two different values mid-flight.
 */
function readConfig(config) {
  return {
    confirmPurge: configValue(config.confirmPurge) === true,
    autoRefresh: configValue(config.autoRefresh) === true,
    maxBatchSize: configValue(config.maxBatchSize),
    titleFetchLimit: configValue(config.titleFetchLimit),
    trackingEnabled: configValue(config.trackingEnabled) !== false,
    autoCleanup: configValue(config.autoCleanup) !== false,
    autoResume: configValue(config.autoResume) !== false,
    trackingPollMs: configValue(config.trackingPollMs),
    trackingIdleWindowMs: configValue(config.trackingIdleWindowMs),
    trackingMaxFiles: configValue(config.trackingMaxFiles),
    trackingMaxDepth: configValue(config.trackingMaxDepth),
    trackingMaxSnapshotBytes: configValue(config.trackingMaxSnapshotBytes),
    trackingExclude: configValue(config.trackingExclude),
    conflictMode: configValue(config.conflictMode),
  }
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  return resolve(typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh'))
}

/**
 * Wire-format dispatcher: one endpoint table, strict `{ ok }` results, and
 * thrown errors normalized to the connection-RPC failure shape.
 */
function createDispatcher({ endpoints, logger }) {
  const registry = new Map(Object.entries(endpoints))
  return async (endpoint, payload) => {
    const definition = typeof endpoint === 'string' ? registry.get(endpoint) : undefined
    if (definition === undefined) return fail('unknown-endpoint', `unknown endpoint: ${String(endpoint)}`)
    const input = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
    try {
      const result = await definition.handle(input, endpoint)
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return fail('invalid-rpc-response', `handler for ${endpoint} did not return an { ok } result`)
      }
      if (result.ok === false) return { ok: false, error: normalizeFailure(result.error) }
      return result
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] ${endpoint} failed: ${error?.message ?? error}`)
      return fail('internal', error?.message ?? 'internal-error')
    }
  }
}

/**
 * Accept both a bare code string and a `{ code, message, details }` object from
 * a handler, and always hand the wire a contract-shaped failure.
 * @param {string | { code?: string, message?: string, details?: object }} error
 */
function normalizeFailure(error) {
  if (typeof error === 'string') return { code: error, message: error, details: {} }
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'internal'
    return {
      code,
      message: typeof error.message === 'string' && error.message !== '' ? error.message : code,
      details: error.details !== null && typeof error.details === 'object' ? error.details : {},
    }
  }
  return { code: 'internal', message: 'internal-error', details: {} }
}

async function withBatch(config, payload, run, logger) {
  const raw = Array.isArray(payload?.ids) ? payload.ids : []
  const ids = [...new Set(raw.filter(id => typeof id === 'string' && id !== ''))]
  const { maxBatchSize } = readConfig(config)
  if (ids.length === 0) return fail('no-ids', 'no session ids were supplied')
  if (ids.length > maxBatchSize) {
    return fail('too-many-ids', `at most ${maxBatchSize} ids are accepted per request`, { count: ids.length, maxBatchSize })
  }
  try {
    return await run(ids)
  } catch (error) {
    logger?.warn?.(`[dsh-session-manager] batch failed: ${error?.message ?? error}`)
    return fail('internal', error?.message ?? 'internal-error')
  }
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
      // 0.1.2 hardening: only JSON bodies are accepted. A cross-site "simple
      // request" (form POST) cannot set this media type, so forged requests
      // are rejected with 415 before they can reach the dispatcher.
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'direct-rpc', result: fail('unsupported-media-type', 'this endpoint accepts application/json only') }))
        return
      }
      try {
        const body = await readRequestBody(req, res)
        const request = JSON.parse(body || '{}')
        const suffix = typeof req.url === 'string' ? req.url.split('?')[0].replace(/^.*\/dsh-session-manager\/?/, '') : ''
        const endpoint = suffix !== '' ? suffix : String(request.method ?? '')
        const result = await dispatch(endpoint, request.payload)
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId ?? 'direct-rpc', result }))
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] direct rpc route failed: ${error?.message ?? error}`)
        // readRequestBody may have torn the socket down already (oversized
        // payload); writing to a destroyed response would throw.
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'direct-rpc', result: fail('bad-request', error?.message ?? 'bad-request') }))
      }
    },
  }
  ctx.effect(() => webServer.register(route), `dsh-session-manager: ${channel} direct rpc route`)
}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/**
 * Collect the request body, capped at MAX_REQUEST_BYTES.
 *
 * Audit P14: the old version called `reject` mid-stream and left the request
 * flowing, so the socket stayed open, the promise's later `resolve` was
 * swallowed, and the handler went on to write a second response onto a stream
 * it no longer owned ("write after end"). Now the oversized request is
 * destroyed once, the response is terminated with 413 immediately, and the
 * `settled` flag keeps every later event from touching either stream.
 */
function readRequestBody(req, res) {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    let data = ''
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      fn(value)
    }
    const onData = (chunk) => {
      if (settled) return
      data += chunk
      if (data.length > MAX_REQUEST_BYTES) {
        const error = new Error('payload-too-large')
        error.code = 'payload-too-large'
        if (res !== undefined && !res.writableEnded && !res.destroyed) {
          try {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'server-response', rpcId: 'direct-rpc', result: fail('payload-too-large', `request body exceeds ${MAX_REQUEST_BYTES} bytes`) }))
          } catch {
            // the socket is already going away; nothing left to answer
          }
        }
        req.destroy()
        finish(reject, error)
      }
    }
    const onEnd = () => finish(resolvePromise, data)
    const onError = error => finish(reject, error)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

// 0.1.2: per the host spec (10.1) `ctx.logger` is a logger service — calling
// it with a name returns a named logger. The previous code treated it as a
// plain `{ warn, info }` object, so every line was silently dropped when the
// host exposes the callable form. Try the spec shape first, fall back to the
// object shape, else null (all call sites use optional chaining).
function resolveLogger(ctx) {
  const raw = ctx?.logger
  if (typeof raw === 'function') {
    try {
      const named = raw('dsh-session-manager')
      if (named && typeof named.warn === 'function') return named
    } catch {
      // fall through to the object-shape fallback
    }
  }
  if (raw && (typeof raw.warn === 'function' || typeof raw.info === 'function')) return raw
  return null
}

export function apply(ctx, config) {
  const logger = resolveLogger(ctx)
  const dshHome = resolveDshHome()
  const manifest = createManifestStore(join(dshHome, 'dsh-session-manager-deleted.json'), logger)
  const titleCache = createTitleCache(join(dshHome, 'dsh-session-manager-titles.json'), logger)
  const purgeTracker = createPurgeTracker()
  const opener = createOpener()
  const trash = createTrash({ logger })
  const resourceManager = createSessionResourceManager({
    dshHome,
    ctx,
    manifest,
    opener,
    trash,
    getConfig: () => readConfig(config),
    logger,
  })

  // Live sessions announce titles and renames through the session/title
  // session-event; fold them into the cache so cold rows stay current.
  // Every other session-event feeds the resource lifecycle: tool/call carries
  // the command context (env mutations, spawns, download intents), tool/result
  // schedules the debounced workspace diff (requirement §六). session/created
  // baselines a brand-new session while its workspace is still pristine —
  // the earliest attribution anchor available.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'session/title') {
      const id = session?.id
      if (typeof id !== 'string' || id === '') return
      titleCache.set(id, {
        title: typeof event.data?.title === 'string' && event.data.title !== '' ? event.data.title : null,
        updatedAt: Number.isFinite(event?.time) ? event.time : Date.now(),
      })
      return
    }
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    void resourceManager.observeEvent(id, event)
  })

  ctx.on('session/created', (session) => {
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    void resourceManager.observeSessionCreated(id)
  })

  // Crash recovery: finish cleanups an earlier process left unfinished
  // (requirement §八), then baseline every session the host already knows —
  // a boot sweep that closes the "session existed before the plugin loaded"
  // attribution gap. Fire-and-forget: neither may block boot.
  void resourceManager.bootstrap().then(({ resumed, baselined }) => {
    if (resumed.length > 0) logger?.info?.(`[dsh-session-manager] resumed ${resumed.length} unfinished cleanup/resume task(s)`)
    if (baselined > 0) logger?.info?.(`[dsh-session-manager] baseline sweep started for ${baselined} known session(s)`)
  })

  // Optional periodic sweep (requirement §六 step 3): event-driven diffs plus
  // the pre-removal final diff already cover the common cases; the poll is
  // for deployments that mutate workspaces outside any observable event.
  ctx.effect(() => {
    let pollTimer
    const arm = () => {
      const { trackingPollMs } = readConfig(config)
      const interval = Number(trackingPollMs)
      if (!Number.isFinite(interval) || interval <= 0) return
      pollTimer = setInterval(() => {
        void sweepAllSessions()
      }, Math.max(1000, interval))
      if (typeof pollTimer.unref === 'function') pollTimer.unref()
    }
    const sweepAllSessions = () => resourceManager.sweepKnownSessions()
    arm()
    return () => {
      if (pollTimer !== undefined) clearInterval(pollTimer)
    }
  }, 'dsh-session-manager: tracking poll (when configured)')

  // archive and unarchive differ only in which domain call they make
  const archiveStateEndpoint = (action) => ({
    audit: true,
    handle: payload => withBatch(config, payload, async (ids) => {
      const outcome = action === 'archive' ? await archiveSessions(ctx, ids, logger) : await unarchiveSessions(ctx, ids, logger)
      if (outcome.unavailable) return fail('workspace-unavailable', 'the workspace registry service is not available')
      return { ok: true, value: { results: outcome.results, archivedSessionIds: outcome.archivedSessionIds } }
    }, logger),
  })

  const endpoints = {
    list: {
      handle: async (payload) => {
        const view = payload?.view === 'archived' || payload?.view === 'deleted' ? payload.view : 'all'
        try {
          const { titleFetchLimit } = readConfig(config)
          const value = await listRows(ctx, { view, manifest, titleCache, titleFetchLimit, logger, purgeTracker })
          // annotate rows with lifecycle tracking state (additive, old clients ignore it)
          await Promise.all(value.rows.map(async row => {
            row.tracked = await resourceManager.isTracked(row.id).catch(() => false)
            // self-heal: every list request re-arms baselines for rows that
            // lost theirs (plugin remount, host restart) so attribution starts
            // as early as possible; a no-op stat read when the baseline exists
            void resourceManager.ensureBaseline(row.id).catch(() => {})
          }))
          return { ok: true, value: { view, ...value } }
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] list failed: ${error?.message ?? error}`)
          return fail('list-failed', error?.message ?? 'list-failed')
        }
      },
    },
    archive: archiveStateEndpoint('archive'),
    unarchive: archiveStateEndpoint('unarchive'),
    delete: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const loaded = await loadHeaderMap(ctx, logger)
        // Distinguishable failure (audit P5): without a readable corpus every
        // id would otherwise be reported as 'session-not-found'.
        if (!loaded.ok) return fail(loaded.error, 'the host session corpus is unavailable')
        const value = await softDeleteSessions(ctx, ids, { headers: loaded.headers, manifest, titleCache, logger }, { dshHome, resourceManager })
        return { ok: true, value }
      }, logger),
    },
    restore: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const value = await restoreSessions(ctx, ids, { manifest, titleCache, logger, resourceManager })
        return { ok: true, value }
      }, logger),
    },
    purge: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        // No corpus lookup: a purged session is frequently absent from
        // sessionQuery already, and its directory still has to go (audit P2).
        const value = await purgeSessions(ctx, ids, { manifest, dshHome, titleCache, logger, purgeTracker, resourceManager })
        return { ok: true, value }
      }, logger),
    },
    // --- resource lifecycle endpoints (v0.2.0) ------------------------------
    changes: {
      handle: async (payload) => {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id === '') return fail('no-ids', 'a single session id is required')
        const limit = Number(payload?.limit)
        const value = await resourceManager.getChanges(id, { limit: Number.isFinite(limit) ? limit : 500 })
        return { ok: true, value }
      },
    },
    resources: {
      handle: async (payload) => {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id === '') return fail('no-ids', 'a single session id is required')
        try {
          const value = await resourceManager.getResources(id)
          return { ok: true, value }
        } catch (error) {
          return fail('resources-failed', error?.message ?? 'resources-failed')
        }
      },
    },
    cleanupStatus: {
      handle: async (payload) => {
        const ids = Array.isArray(payload?.ids) ? payload.ids.filter(id => typeof id === 'string' && id !== '')
          : typeof payload?.id === 'string' && payload.id !== '' ? [payload.id] : []
        if (ids.length === 0) return fail('no-ids', 'no session ids were supplied')
        const results = await Promise.all(ids.map(id => resourceManager.getCleanupStatus(id).catch(error => ({
          sessionId: id, tracked: false, legacy: true, cleanup: null, error: error?.message ?? 'status-failed',
        }))))
        return { ok: true, value: { results } }
      },
    },
    cleanup: {
      audit: true,
      handle: payload => withBatch(config, payload, async (ids) => {
        const mode = payload?.mode === 'full' || payload?.mode === 'resume' ? payload.mode : 'rollback-only'
        const results = []
        for (const id of ids) {
          try {
            const outcome = await resourceManager.cleanupSession(id, { mode })
            results.push({ id, ok: outcome.ok !== false, ...outcome })
          } catch (error) {
            logger?.warn?.(`[dsh-session-manager] cleanup ${id} failed: ${error?.message ?? error}`)
            results.push({ id, ok: false, error: error?.message ?? 'cleanup-failed' })
          }
        }
        return { ok: true, value: { results } }
      }, logger),
    },
    // open a resource in the OS file manager (the only open method)
    deleteResources: {
      audit: true,
      handle: async (payload) => {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id === '') return fail('no-ids', 'a single session id is required')
        const paths = Array.isArray(payload?.paths) ? payload.paths.filter(path => typeof path === 'string' && path !== '') : []
        if (paths.length === 0) return fail('no-paths', 'at least one resource path is required')
        try {
          const value = await resourceManager.deleteResources(id, paths)
          const failed = value.results.filter(result => result.ok !== true)
          if (failed.length > 0) {
            logger?.warn?.(`[dsh-session-manager] deleteResources: ${failed.length} of ${value.results.length} failed: ${failed[0]?.error?.code ?? 'unknown'}`)
          }
          return { ok: true, value }
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] deleteResources failed: ${error?.message ?? error}`)
          return fail('internal', error?.message ?? 'delete-resources-failed')
        }
      },
    },
    recycleList: {
      handle: async (payload) => {
        const id = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : null
        try {
          const entries = await resourceManager.recycleList(id)
          return { ok: true, value: { entries } }
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] recycleList failed: ${error?.message ?? error}`)
          return fail('internal', error?.message ?? 'recycle-list-failed')
        }
      },
    },
    recycleRestore: {
      audit: true,
      handle: async (payload) => {
        const entryId = typeof payload?.entryId === 'string' ? payload.entryId : ''
        if (entryId === '') return fail('no-entry-id', 'an entry id is required')
        try {
          const entry = await resourceManager.recycleRestore(entryId)
          return { ok: true, value: { entryId, originalPath: entry.originalPath, sessionId: entry.sessionId } }
        } catch (error) {
          const code = error?.code ?? 'restore-failed'
          logger?.warn?.(`[dsh-session-manager] recycleRestore ${entryId} failed: ${error?.message ?? error}`)
          return fail(code, error?.message ?? 'restore-failed')
        }
      },
    },
    openResource: {
      handle: async (payload) => {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id === '') return fail('no-ids', 'a single session id is required')
        try {
          const result = await resourceManager.openResource(id, payload?.path)
          if (result.ok === true) return result
          return fail(result.error?.code ?? 'open-failed', result.error?.message ?? 'open-failed')
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] openResource failed: ${error?.message ?? error}`)
          return fail('internal', error?.message ?? 'open-failed')
        }
      },
    },
    track: {
      handle: payload => withBatch(config, payload, async (ids) => {
        const results = []
        for (const id of ids) {
          try {
            results.push({ id, ok: true, ...(await resourceManager.diffSession(id)) })
          } catch (error) {
            results.push({ id, ok: false, error: error?.message ?? 'diff-failed' })
          }
        }
        return { ok: true, value: { results } }
      }, logger),
    },
    config: {
      handle: async () => ({ ok: true, value: readConfig(config) }),
    },
  }

  const dispatch = createDispatcher({ endpoints, logger })
  // rc.1 contract: `handle(channel, handler)` — two arguments
  // (packages/client/connection/src/rpc.ts:166-190). The previous third
  // `{ authority: 'loopback' }` argument was silently ignored by the host.
  // one degradation path for both "no rpc seam" and "rpc handle threw"
  const fallbackToDirectRoute = (reason) => {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      logger?.warn?.(`[dsh-session-manager] ${reason}; falling back to a direct webServer route`)
      registerDirectRpcWebRoute(ctx, webServer, CHANNEL, dispatch, logger)
    } else {
      logger?.warn?.(`[dsh-session-manager] ${reason} and no webServer seam is available`)
    }
  }

  const rpc = ctx.connection?.rpc
  if (rpc === undefined || typeof rpc.handle !== 'function') {
    fallbackToDirectRoute('connection.rpc.handle is unavailable')
    return
  }
  try {
    const dispose = rpc.handle(CHANNEL, dispatch)
    if (typeof dispose === 'function') {
      ctx.effect(() => dispose, 'dsh-session-manager: rpc channel')
    }
    logger?.info?.(`[dsh-session-manager] serving ${CHANNEL}`)
  } catch (error) {
    fallbackToDirectRoute(`connection rpc handle failed (${error?.message ?? error})`)
  }

  ctx.effect(() => async () => {
    await manifest.flush()
    await titleCache.flush()
    resourceManager.dispose()
  }, 'dsh-session-manager: flush stores')
}
