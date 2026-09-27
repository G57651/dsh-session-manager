// dsh-session-manager — session domain helpers for the host half.
//
// Harness services are resolved lazily via `ctx.get(name)` at call time (the
// same defensive pattern @gehennawu/dsh-service uses): a missing service
// degrades the affected endpoint instead of keeping the whole plugin PENDING
// on an inject list.
//
// Soft delete model:
//   delete  = record the session in the trash manifest and archive it natively
//             (so it leaves the live sidebar); the session directory stays on
//             disk and the session can be restored.
//   restore = drop the manifest entry and undo the native archive unless the
//             session was already archived before it was deleted.
//   purge   = stop all session activity, remove the session directory from
//             $DSH_HOME/sessions, and drop the manifest entry.

import { dirname, join, resolve, sep } from 'node:path'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const MANIFEST_VERSION = 1
const TITLE_CACHE_VERSION = 1
const TITLE_FLUSH_DELAY_MS = 2000

async function safeList(ctx, serviceName, call, logger) {
  const service = ctx.get(serviceName)
  if (service === undefined || service === null) return undefined
  try {
    return await call(service)
  } catch (error) {
    logger?.warn?.(`[dsh-session-manager] ${serviceName} call failed: ${error?.message ?? error}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Trash manifest — $DSH_HOME/dsh-session-manager-deleted.json
// ---------------------------------------------------------------------------

export function createManifestStore(filePath, logger) {
  let data = { version: MANIFEST_VERSION, items: [] }
  let loaded
  let writeChain = Promise.resolve()

  const normalizeItem = (item) => ({
    id: String(item?.id ?? ''),
    title: typeof item?.title === 'string' && item.title !== '' ? item.title : null,
    cwd: typeof item?.cwd === 'string' ? item.cwd : undefined,
    deletedAt: Number.isFinite(item?.deletedAt) ? item.deletedAt : Date.now(),
    wasArchived: item?.wasArchived === true,
  })

  const load = () => {
    loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8'))
        if (raw?.version === MANIFEST_VERSION && Array.isArray(raw.items)) {
          data = { version: MANIFEST_VERSION, items: raw.items.map(normalizeItem).filter(item => item.id !== '') }
        } else {
          logger?.warn?.('[dsh-session-manager] manifest file has an unexpected shape; starting from an empty trash')
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger?.warn?.(`[dsh-session-manager] manifest load failed: ${error?.message ?? error}`)
        }
      }
    })()
    return loaded
  }

  const schedulePersist = () => {
    writeChain = writeChain
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.${randomUUID()}.tmp`
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        await rename(tmp, filePath)
      })
      .catch((error) => {
        logger?.warn?.(`[dsh-session-manager] manifest persist failed: ${error?.message ?? error}`)
      })
    return writeChain
  }

  return {
    async list() {
      await load()
      return data.items.map(item => ({ ...item }))
    },
    async has(id) {
      await load()
      return data.items.some(item => item.id === id)
    },
    async add(entry) {
      await load()
      const item = normalizeItem(entry)
      if (item.id === '') throw new Error('invalid-session-id')
      data.items = [item, ...data.items.filter(existing => existing.id !== item.id)]
      // The write is awaited: when the RPC returns, the trash state is durable.
      await schedulePersist()
      return { ...item }
    },
    async remove(id) {
      await load()
      const before = data.items.length
      data.items = data.items.filter(item => item.id !== id)
      const removed = data.items.length !== before
      if (removed) await schedulePersist()
      return removed
    },
    async flush() {
      await load()
      await writeChain
    },
  }
}

// ---------------------------------------------------------------------------
// Title cache — $DSH_HOME/dsh-session-manager-titles.json
//
// Titles are not part of SessionHeader. Live sessions announce them through
// `session/title` events; cold (non-live) sessions are folded from their event
// log by sessionQuery.readTitleSnapshots, which is expensive — hence the
// persistent cache with negative entries (`title: null`).
// ---------------------------------------------------------------------------

export function createTitleCache(filePath, logger) {
  let titles = new Map()
  let dirty = false
  let loaded
  let timer

  const load = () => {
    loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8'))
        if (raw?.version === TITLE_CACHE_VERSION && raw.titles !== null && typeof raw.titles === 'object') {
          titles = new Map(Object.entries(raw.titles).flatMap(([id, entry]) => {
            if (typeof id !== 'string' || id === '' || entry === null || typeof entry !== 'object') return []
            const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : null
            const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
            return [[id, { title, updatedAt }]]
          }))
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger?.warn?.(`[dsh-session-manager] title cache load failed: ${error?.message ?? error}`)
        }
      }
    })()
    return loaded
  }

  const persist = async () => {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify({ version: TITLE_CACHE_VERSION, titles: Object.fromEntries(titles) }, null, 2)}\n`, 'utf8')
    await rename(tmp, filePath)
  }

  const schedulePersist = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!dirty) return
      dirty = false
      void persist().catch((error) => {
        logger?.warn?.(`[dsh-session-manager] title cache persist failed: ${error?.message ?? error}`)
      })
    }, TITLE_FLUSH_DELAY_MS)
  }

  return {
    get(id) {
      return titles.get(id)
    },
    set(id, entry) {
      titles.set(String(id), entry)
      dirty = true
      schedulePersist()
    },
    delete(id) {
      if (titles.delete(id)) {
        dirty = true
        schedulePersist()
      }
    },
    async flush() {
      await load()
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (dirty) {
        dirty = false
        await persist().catch((error) => {
          logger?.warn?.(`[dsh-session-manager] title cache flush failed: ${error?.message ?? error}`)
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function archivedSessionIdSet(ctx, logger) {
  const registry = ctx.get('workspaceRegistry')
  const ids = registry?.archivedSessionIds
  if (!Array.isArray(ids)) return new Set()
  return new Set(ids.map(String))
}

/**
 * Process-lifetime memory of ids this plugin has permanently purged. The
 * sessionQuery corpus and the session controller keep purged sessions in
 * memory until restart (no removed event fires for a directory removal), and
 * those stale entries are indistinguishable from a real not-yet-flushed
 * session — so purged ids are filtered from every view explicitly.
 */
export function createPurgeTracker() {
  const ids = new Set()
  return {
    mark: id => ids.add(String(id)),
    has: id => ids.has(String(id)),
  }
}

async function fillTitles(ctx, titleCache, ids, logger) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.readTitleSnapshots !== 'function' || ids.length === 0) return
  try {
    const observations = await query.readTitleSnapshots(ids)
    for (const observation of observations ?? []) {
      const id = observation?.sessionId
      if (typeof id !== 'string' || id === '') continue
      if (observation.status === 'fulfilled') {
        const snapshot = observation.value?.title
        titleCache.set(id, { title: typeof snapshot?.title === 'string' ? snapshot.title : null, updatedAt: Number.isFinite(snapshot?.updatedAt) ? snapshot.updatedAt : 0 })
      } else {
        // Operational failure on one id: cache negatively so a hot list loop
        // cannot retry the same expensive fold forever.
        titleCache.set(id, { title: null, updatedAt: 0 })
      }
    }
  } catch (error) {
    logger?.warn?.(`[dsh-session-manager] title fill failed: ${error?.message ?? error}`)
  }
}

/**
 * Build display rows for one view.
 * @param view 'all' | 'archived' | 'deleted'
 * @returns rows for the view plus all-three-view counts for the tab labels.
 */
export async function listRows(ctx, { view, manifest, titleCache, config, logger, purgeTracker }) {
  const isPurged = (id) => purgeTracker?.has(id) === true
  const [controllerValue, records, snapshots, manifestItems] = await Promise.all([
    safeList(ctx, 'sessionController', controller => controller.list({}), logger),
    safeList(ctx, 'sessionQuery', query => query.listSessions(), logger),
    safeList(ctx, 'sessionPersistence', persistence => persistence.list(), logger),
    manifest.list(),
  ])

  const summaryById = new Map((controllerValue?.items ?? []).map(item => [String(item.sessionId), item]))
  const recordById = new Map((records ?? []).map(record => [String(record.header.id), record]))
  const snapshotById = new Map((snapshots ?? []).map(snapshot => [String(snapshot.header.id), snapshot]))
  const deletedIds = new Set(manifestItems.map(item => item.id))
  const archivedSet = await archivedSessionIdSet(ctx, logger)

  const ids = new Set([...summaryById.keys(), ...recordById.keys()])
  const missingTitles = [...ids].filter(id => titleCache.get(id) === undefined && !isPurged(id))
  if (missingTitles.length > 0) {
    await fillTitles(ctx, titleCache, missingTitles.slice(0, Math.max(0, config.titleFetchLimit)), logger)
  }

  const counts = {
    all: 0,
    archived: 0,
    deleted: manifestItems.length,
  }
  for (const id of ids) {
    if (deletedIds.has(id) || isPurged(id)) continue
    counts.all += 1
    if (archivedSet.has(id)) counts.archived += 1
  }

  if (view === 'deleted') {
    const rows = manifestItems.map((item) => ({
      id: item.id,
      title: item.title ?? titleCache.get(item.id)?.title ?? null,
      cwd: item.cwd,
      deletedAt: item.deletedAt,
      wasArchived: item.wasArchived,
      missing: !ids.has(item.id) || isPurged(item.id),
      deleted: true,
      archived: false,
    }))
    rows.sort((left, right) => right.deletedAt - left.deletedAt || left.id.localeCompare(right.id))
    return { rows, counts }
  }

  const rows = []
  for (const id of ids) {
    if (deletedIds.has(id) || isPurged(id)) continue
    const summary = summaryById.get(id)
    const record = recordById.get(id)
    const header = record?.header ?? snapshotById.get(id)?.header
    const snapshot = snapshotById.get(id)
    const archived = archivedSet.has(id)
    if (view === 'archived' && !archived) continue
    rows.push({
      id,
      title: titleCache.get(id)?.title ?? null,
      cwd: summary?.cwd ?? header?.cwd,
      createdAt: header?.createdAt,
      updatedAt: summary?.updatedAt ?? header?.createdAt ?? 0,
      sizeBytes: snapshot?.sizeBytes,
      eventCount: snapshot?.eventCount,
      live: record?.live ?? false,
      running: summary?.running ?? false,
      blank: summary?.blank ?? false,
      origin: summary?.origin ?? header?.origin,
      archived,
      deleted: false,
    })
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  return { rows, counts }
}

/** One header per corpus id, for delete/purge bookkeeping. */
export async function loadHeaderMap(ctx, logger) {
  const records = await safeList(ctx, 'sessionQuery', query => query.listSessions(), logger)
  return new Map((records ?? []).map(record => [String(record.header.id), record.header]))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function archiveSessions(ctx, ids, logger) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.archiveSession !== 'function') {
    return { unavailable: true }
  }
  const results = []
  for (const id of ids) {
    try {
      await registry.archiveSession(id, { stopActivity: true })
      results.push({ id, ok: true })
    } catch (error) {
      const code = error?.name === 'WorkspaceUnknownSessionError' ? 'session-not-found' : 'archive-failed'
      logger?.warn?.(`[dsh-session-manager] archive ${id} failed: ${error?.message ?? error}`)
      results.push({ id, ok: false, error: code })
    }
  }
  return {
    results,
    archivedSessionIds: Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : undefined,
  }
}

export async function unarchiveSessions(ctx, ids, logger) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.unarchiveSession !== 'function') {
    return { unavailable: true }
  }
  const results = []
  for (const id of ids) {
    try {
      await registry.unarchiveSession(id)
      results.push({ id, ok: true })
    } catch (error) {
      const code = error?.name === 'WorkspaceUnknownSessionError' ? 'session-not-found' : 'unarchive-failed'
      logger?.warn?.(`[dsh-session-manager] unarchive ${id} failed: ${error?.message ?? error}`)
      results.push({ id, ok: false, error: code })
    }
  }
  return {
    results,
    archivedSessionIds: Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : undefined,
  }
}

export async function softDeleteSessions(ctx, ids, { headers, manifest, titleCache, logger }) {
  const archivedSet = await archivedSessionIdSet(ctx, logger)
  const results = []
  for (const id of ids) {
    const header = headers.get(id)
    if (header === undefined) {
      results.push({ id, ok: false, error: 'session-not-found' })
      continue
    }
    const outcome = await archiveSessions(ctx, [id], logger)
    const result = outcome.results?.[0]
    if (outcome.unavailable || result === undefined || !result.ok) {
      results.push({ id, ok: false, error: result?.error ?? 'workspace-unavailable' })
      continue
    }
    try {
      await manifest.add({
        id,
        title: titleCache.get(id)?.title ?? null,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        deletedAt: Date.now(),
        wasArchived: archivedSet.has(id),
      })
      results.push({ id, ok: true })
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] manifest write for ${id} failed: ${error?.message ?? error}`)
      results.push({ id, ok: false, error: 'manifest-write-failed' })
    }
  }
  return { results }
}

export async function restoreSessions(ctx, ids, { manifest, logger }) {
  const registry = ctx.get('workspaceRegistry')
  const items = await manifest.list()
  const byId = new Map(items.map(item => [item.id, item]))
  const results = []
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry === undefined) {
      results.push({ id, ok: false, error: 'not-deleted' })
      continue
    }
    await manifest.remove(id)
    if (!entry.wasArchived && registry !== undefined && typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(id)
      } catch (error) {
        // The session may have vanished from disk while it sat in the trash;
        // dropping the manifest entry is still the correct restore outcome.
        if (error?.name !== 'WorkspaceUnknownSessionError') {
          logger?.warn?.(`[dsh-session-manager] unarchive on restore ${id} failed: ${error?.message ?? error}`)
          results.push({ id, ok: false, error: 'unarchive-failed' })
          continue
        }
      }
    }
    results.push({ id, ok: true })
  }
  return { results }
}

/**
 * Invalidate a permanently removed session in every host-side cache that a
 * directory removal alone cannot touch.
 *
 * `sessionQuery` reads `$DSH_HOME/sessions` into a process-lifetime corpus and
 * `sessionController` mirrors it; neither re-stats disk on write, so a purged
 * id stays listed until restart. `api-session/removed` is only ever emitted
 * from `session/disposed` (a live teardown), and removing a directory
 * disposes nothing — so the client never learns about it and the official
 * sidebar keeps the row. The workspace registry is worse: the pre-purge
 * `archiveSession` leaves the id in the global `archivedSessionIds` set and
 * every workspace keeps its `sessionIds` slot, so the ghost reappears under
 * Archived. All three are public, idempotent, no-op-safe calls:
 *   `detachSession`   — no-op when the workspace does not account the id
 *   `unarchiveSession` — no existence check; an entry whose session is gone
 *                        still resolves; no-op when the id is not archived
 *   `api-session/removed` — forwarded to the client, which drops the row
 */
export async function invalidateRemovedSession(ctx, id, logger) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    const entities = typeof registry.list === 'function' ? (registry.list() ?? []) : []
    for (const entity of entities) {
      const accounted = Array.isArray(entity?.sessionIds) ? entity.sessionIds : []
      if (!accounted.some(entry => String(entry) === String(id))) continue
      try {
        await entity.detachSession(id)
      } catch (error) {
        if (error?.name !== 'WorkspaceUnknownSessionError') {
          logger?.warn?.(`[dsh-session-manager] detach ${id} failed: ${error?.message ?? error}`)
        }
      }
    }
    if (typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(id)
      } catch (error) {
        if (error?.name !== 'WorkspaceUnknownSessionError') {
          logger?.warn?.(`[dsh-session-manager] unarchive ${id} failed: ${error?.message ?? error}`)
        }
      }
    }
  }
  ctx.emit?.('api-session/removed', id)
}

export async function purgeSessions(ctx, ids, { headers, manifest, dshHome, logger, purgeTracker }) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  const sessionsRoot = resolve(join(resolve(dshHome), 'sessions')) + sep
  const results = []
  for (const id of ids) {
    const header = headers.get(id)
    if (header === undefined) {
      // Not on disk and not live: clean up any trash entry, then clear the
      // registry residue that a previous purge left behind.
      await manifest.remove(id)
      await invalidateRemovedSession(ctx, id, logger)
      purgeTracker?.mark(id)
      results.push({ id, ok: true, freedBytes: 0 })
      continue
    }
    if (registry !== undefined && typeof registry.archiveSession === 'function') {
      try {
        await registry.archiveSession(id, { stopActivity: true })
      } catch (error) {
        if (error?.name !== 'WorkspaceUnknownSessionError') {
          logger?.warn?.(`[dsh-session-manager] pre-purge archive ${id} failed: ${error?.message ?? error}`)
          results.push({ id, ok: false, error: 'purge-failed' })
          continue
        }
      }
    }
    let located
    try {
      const location = persistence?.locate?.(header)
      if (typeof location?.path === 'string' && location.path !== '') located = location.path
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] locate ${id} failed: ${error?.message ?? error}`)
    }
    if (located === undefined) {
      results.push({ id, ok: false, error: 'cannot-locate' })
      continue
    }
    const target = resolve(located)
    let directory = target
    try {
      const info = await stat(target)
      if (!info.isDirectory()) directory = dirname(target)
    } catch {
      directory = dirname(target)
    }
    // Destructive op guard: only ever remove inside $DSH_HOME/sessions, in a
    // directory that names the session id.
    if (!directory.startsWith(sessionsRoot) || !directory.split(sep).pop()?.includes(id)) {
      logger?.warn?.(`[dsh-session-manager] refusing to remove ${directory}: outside the sessions root or mismatched id`)
      results.push({ id, ok: false, error: 'unsafe-path' })
      continue
    }
    let freedBytes = 0
    try {
      const snapshot = await persistence?.stat?.(id)
      freedBytes = Number.isFinite(snapshot?.sizeBytes) ? snapshot.sizeBytes : 0
    } catch { /* best-effort accounting */ }
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] rm ${directory} failed: ${error?.message ?? error}`)
      results.push({ id, ok: false, error: 'remove-failed' })
      continue
    }
    await manifest.remove(id)
    // The directory is gone but every host-side cache still holds the id;
    // without this the row survives in the sidebar's Archived view until the
    // client is restarted, when bootstrap prunes it by re-reading disk.
    await invalidateRemovedSession(ctx, id, logger)
    purgeTracker?.mark(id)
    results.push({ id, ok: true, freedBytes })
  }
  return { results }
}
