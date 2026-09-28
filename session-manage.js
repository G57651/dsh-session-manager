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

import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const MANIFEST_VERSION = 1
const TITLE_CACHE_VERSION = 1
const TITLE_FLUSH_DELAY_MS = 2000
const NEGATIVE_TITLE_TTL_MS = 5 * 60 * 1000

/**
 * Probe one host service. Never throws; on failure it also reports WHY
 * (missing service vs. a throwing call) so batch endpoints can hand the client
 * a distinguishable code instead of a silent downgrade (audit P5).
 */
async function probeService(ctx, serviceName, call, logger) {
  const service = ctx.get(serviceName)
  if (service === undefined || service === null) {
    return { ok: false, reason: 'service-missing', error: 'service-missing' }
  }
  try {
    return { ok: true, value: await call(service) }
  } catch (error) {
    logger?.warn?.(`[dsh-session-manager] ${serviceName} call failed: ${error?.message ?? error}`)
    return { ok: false, reason: 'service-failed', error: 'service-failed' }
  }
}

/**
 * Same probe, downgraded to "value or undefined" for call sites that only need
 * the value.
 */
async function safeList(ctx, serviceName, call, logger) {
  const probe = await probeService(ctx, serviceName, call, logger)
  return probe.ok ? probe.value : undefined
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
    // Permanently removed on disk. Persisted (not just an in-process set) so a
    // restart cannot resurrect a purged row out of the host's stale corpus.
    purged: item?.purged === true,
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
    /**
     * Keep the record but mark it permanently removed (audit P3). The row is
     * dropped from every view by the same filter that hides deleted ids, and
     * the flag survives a restart — which the old in-process purge tracker
     * could not, so a purged session came back in the official sidebar (and in
     * the plugin's own views) after a reload.
     */
    async markPurged(id) {
      await load()
      const existing = data.items.find(item => item.id === id)
      if (existing !== undefined) {
        existing.purged = true
        await schedulePersist()
        return { ...existing }
      }
      // Persist the flag even when no trash entry existed yet: purge never
      // ran through delete, so there is no prior record to flip (audit P3).
      return this.add({ id, deletedAt: Date.now(), purged: true })
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
 * Process-lifetime mirror of the manifest's `purged` flag, kept because the
 * manifest loads asynchronously: a synchronous filter is what lets one request
 * hide a row it just removed without awaiting a disk read.
 *
 * Since 0.2.0 the authoritative record is the persisted manifest flag — this
 * set is only a fast path (audit P3: the previous in-memory-only tracker lost
 * every purge on restart).
 */
export function createPurgeTracker() {
  const ids = new Set()
  return {
    mark: id => ids.add(String(id)),
    has: id => ids.has(String(id)),
  }
}

/**
 * Mirror of session-persistence-jsonl's `encodeSegment`
 * (packages/session/session-persistence-jsonl/src/format.ts:199-214): safe code
 * units [A-Za-z0-9._-] stay literal, every other code unit — including '~' and
 * the separators — becomes '~' + 4-digit uppercase hex, and the traversal
 * segments '.' / '..' are escaped whole. Operating per code unit (not per code
 * point) keeps lone surrogates round-trippable, exactly like the original.
 */
export function encodeSegment(input) {
  const text = String(input)
  if (text.length === 0) throw new Error('cannot encode an empty path segment')
  if (text === '.') return '~002E'
  if (text === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    out += /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : '~' + text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Mirror of session-persistence-jsonl's `projectKey`
 * (packages/session/session-persistence-jsonl/src/format.ts:225-245): '/',
 * backslash and ':' collapse into one '-' per run, other unsafe code units use
 * the same '~XXXX' escape, leading dashes are dropped and an empty result
 * becomes 'root'. The trailing '--' wrapper is added by the callers below.
 *
 * NOTE: whitespace is NOT a separator — format.ts:235 treats a space as an
 * unsafe code unit, so '/a/cool project' keys as '--a-cool~0020project--'.
 * Reading the separator set as "any unknown character" would locate nothing.
 */
export function projectKey(input) {
  const text = String(input)
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += '~' + text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Locate the on-disk directory of `id` without any official API (audit
 * P1/P2: rc.1 exposes no session locator — SessionPersistence has no `locate`,
 * and its jsonl implementation keeps one private at
 * session-persistence-jsonl/src/index.ts:299).
 *
 * <$DSH_HOME>/sessions/<project-slug>/<encoded-session-id> is the layout
 * written by session-persistence-jsonl (format.ts projectDir/sessionDir), but
 * the slug is derived from the session's cwd — exactly what is unknown here —
 * so every slug directory is scanned and only an EXACT name match on the
 * encoded id is accepted. Equality, never substring: an `includes` check would
 * match session `abc` inside `abc-extra` and delete the wrong session.
 */
export async function locateSessionDir(sessionsRoot, id) {
  const encoded = encodeSegment(id)
  let slugs = []
  try {
    slugs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? 'sessions-root-missing' : 'sessions-root-unreadable' }
  }
  const matches = []
  for (const entry of slugs) {
    if (entry.isDirectory() !== true) continue
    const candidate = join(sessionsRoot, entry.name, encoded)
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) matches.push(candidate)
    } catch {
      // not this slug
    }
  }
  if (matches.length === 0) return { ok: false, error: 'session-dir-not-found' }
  if (matches.length > 1) {
    // The same id under two slugs belongs to two different cwds; removing
    // either would be a guess.
    return { ok: false, error: 'session-dir-ambiguous', candidates: matches }
  }
  return { ok: true, directory: matches[0] }
}

/**
 * True when `directory` sits strictly BELOW `sessionsRoot` and its basename is
 * exactly the encoded `id`.
 *
 * The real layout is <sessionsRoot>/<project-slug>/<encoded-id>
 * (format.ts:254-268), so requiring sessionsRoot to be the direct parent — the
 * first version of this guard — rejected every genuine hit and turned both
 * delete and purge into 'unsafe-path'. The two properties that actually keep
 * the rm safe are kept: the match is on the WHOLE basename (never a substring,
 * so id 'abc' can never hit 'abc-extra'), and the path must stay inside
 * sessionsRoot.
 */
export function isSessionDir(directory, sessionsRoot, id) {
  const base = directory.slice(directory.lastIndexOf(sep) + 1)
  if (base !== encodeSegment(id)) return false
  const root = resolve(sessionsRoot)
  const target = resolve(directory)
  return target.startsWith(root + sep)
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
        // A real observation is authoritative, even when it reports "no title":
        // updatedAt carries it past the negative-entry TTL so the fold is not
        // repeated (audit P11).
        titleCache.set(id, { title: typeof snapshot?.title === 'string' ? snapshot.title : null, updatedAt: Date.now() })
      } else {
        // Operational failure on one id: cache negatively with a dated marker.
        // The entry is retried once its TTL expires; an undated 0 used to mean
        // "cached forever", so a transient read failure permanently pinned the
        // row to its fallback title (audit P11).
        titleCache.set(id, { title: null, updatedAt: Date.now() })
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
  const [controllerProbe, queryProbe, persistenceProbe, manifestItems] = await Promise.all([
    probeService(ctx, 'sessionController', controller => controller.list({}), logger),
    probeService(ctx, 'sessionQuery', query => query.listSessions(), logger),
    probeService(ctx, 'sessionPersistence', persistence => persistence.list(), logger),
    manifest.list(),
  ])
  const controllerValue = controllerProbe.ok ? controllerProbe.value : undefined
  const records = queryProbe.ok ? queryProbe.value : undefined
  const snapshots = persistenceProbe.ok ? persistenceProbe.value : undefined

  // Availability summary (audit P5): a partially degraded list still renders,
  // but the client must be able to say WHICH host service was missing rather
  // than showing an empty panel with no explanation.
  const sources = {
    available: true,
    degraded: false,
    sessionController: { ok: controllerProbe.ok, reason: controllerProbe.reason ?? null },
    sessionQuery: { ok: queryProbe.ok, reason: queryProbe.reason ?? null },
    sessionPersistence: { ok: persistenceProbe.ok, reason: persistenceProbe.reason ?? null },
    manifest: { ok: true, reason: null },
  }
  if (!controllerProbe.ok || !queryProbe.ok || !persistenceProbe.ok) {
    sources.available = false
    sources.degraded = controllerProbe.ok || queryProbe.ok
  }

  const summaryById = new Map((controllerValue?.items ?? []).map(item => [String(item.sessionId), item]))
  const recordById = new Map((records ?? []).map(record => [String(record.header.id), record]))
  const snapshotById = new Map((snapshots ?? []).map(snapshot => [String(snapshot.header.id), snapshot]))
  const deletedIds = new Set(manifestItems.map(item => item.id))
  // Permanently removed ids come from the PERSISTED manifest flag, not only the
  // in-process tracker (audit P3). The tracker is empty in a fresh process, so
  // filtering on it alone let every purged row — whose directory is already
  // gone — reappear under 'deleted' after a restart, where restore could only
  // answer 'purged'.
  const purgedIds = new Set(manifestItems.filter(item => item.purged === true).map(item => item.id))
  const isPurged = (id) => purgedIds.has(id) || purgeTracker?.has(id) === true
  const archivedSet = await archivedSessionIdSet(ctx, logger)

  const staleBefore = Date.now() - NEGATIVE_TITLE_TTL_MS
  const ids = new Set([...summaryById.keys(), ...recordById.keys()])
  const needsTitle = (id) => {
    const entry = titleCache.get(id)
    if (entry === undefined) return true
    // A title is a positive cache hit. A null title is a negative entry and is
    // only trusted for one TTL, after which the fold is retried (audit P11).
    return entry.title === null && !(Number.isFinite(entry.updatedAt) && entry.updatedAt > staleBefore)
  }
  const missingTitles = [...ids].filter(id => needsTitle(id) && !isPurged(id))
  if (missingTitles.length > 0) {
    await fillTitles(ctx, titleCache, missingTitles.slice(0, Math.max(0, config.titleFetchLimit)), logger)
  }

  // Purged records stay in the manifest as tombstones, so the tab count must
  // not include them (audit P3).
  const counts = {
    all: 0,
    archived: 0,
    deleted: manifestItems.reduce((total, item) => total + (item.purged === true ? 0 : 1), 0),
  }
  for (const id of ids) {
    if (deletedIds.has(id) || isPurged(id)) continue
    counts.all += 1
    if (archivedSet.has(id)) counts.archived += 1
  }

  if (view === 'deleted') {
    // A purged record is a tombstone, not a trashed session: the directory is
    // gone and restore can only refuse, so it is not offered as a row (P3).
    const rows = manifestItems.filter(item => isPurged(item.id) !== true).map((item) => ({
      id: item.id,
      title: item.title ?? titleCache.get(item.id)?.title ?? null,
      cwd: item.cwd,
      deletedAt: item.deletedAt,
      wasArchived: item.wasArchived,
      missing: !ids.has(item.id),
      deleted: true,
      archived: false,
    }))
    rows.sort((left, right) => right.deletedAt - left.deletedAt || left.id.localeCompare(right.id))
    return { rows, counts, sources }
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
  return { rows, counts, sources }
}

/**
 * One header per corpus id, for delete/purge bookkeeping (audit P5).
 *
 * Returns a distinguishable failure instead of an empty map: an empty map used
 * to make every id report 'session-not-found', which reads as "your session is
 * already gone" when the truth is "the host corpus could not be read".
 */
export async function loadHeaderMap(ctx, logger) {
  const probe = await probeService(ctx, 'sessionQuery', query => query.listSessions(), logger)
  if (!probe.ok) {
    return { ok: false, error: probe.error === 'service-missing' ? 'session-query-unavailable' : 'session-query-failed' }
  }
  return { ok: true, headers: new Map((probe.value ?? []).map(record => [String(record.header.id), record.header])) }
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

/**
 * Delete = move the session to the plugin trash AND take its directory off
 * disk (audit P1, report option A).
 *
 * The old implementation only wrote the trash manifest and called the native
 * `archiveSession`, which merely records the id in the in-memory
 * `archivedSessionIds` set — the directory stayed at
 * <$DSH_HOME>/sessions/<slug>/<id>, so the official sidebar re-derived the
 * session from disk and it reappeared on the next restart.
 *
 * The manifest entry is written BEFORE the directory is removed, so a failed
 * manifest write aborts the delete instead of losing the only record of what
 * was removed.
 */
export async function softDeleteSessions(ctx, ids, { headers, manifest, titleCache, logger, purgeTracker }, options = {}) {
  const sessionsRoot = resolve(join(resolve(options.dshHome ?? '.'), 'sessions'))
  const purge = options.purge === true
  const archivedSet = await archivedSessionIdSet(ctx, logger)
  const results = []
  for (const id of ids) {
    const header = headers.get(id)
    try {
      await manifest.add({
        id,
        title: titleCache.get(id)?.title ?? null,
        cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
        deletedAt: Date.now(),
        wasArchived: archivedSet.has(id),
        purged: false,
      })
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] manifest write for ${id} failed: ${error?.message ?? error}`)
      results.push({ id, ok: false, error: 'manifest-write-failed' })
      continue
    }

    // Stop the session's activity first: an open writer would recreate the
    // directory we are about to remove.
    const outcome = await archiveSessions(ctx, [id], logger)
    const result = outcome.results?.[0]
    if (outcome.unavailable || result === undefined || !result.ok) {
      if (result?.error !== 'session-not-found') {
        results.push({ id, ok: false, error: result?.error ?? 'workspace-unavailable' })
        continue
      }
    }

    if (purge) {
      results.push(await removeSessionDir(ctx, id, { manifest, sessionsRoot, titleCache, logger, purgeTracker }))
      continue
    }

    const located = await locateSessionDir(sessionsRoot, id)
    if (!located.ok) {
      // No directory (already gone, or the sessions root does not exist yet):
      // the trash entry alone is the correct state, and restore stays
      // available.
      results.push({ id, ok: true, removedDirectory: false })
      continue
    }
    if (!isSessionDir(located.directory, sessionsRoot, id)) {
      logger?.warn?.(`[dsh-session-manager] refusing to remove ${located.directory}: outside the sessions root or mismatched id`)
      results.push({ id, ok: false, error: 'unsafe-path' })
      continue
    }
    try {
      await rm(located.directory, { recursive: true, force: true })
      titleCache.delete(id)
      results.push({ id, ok: true, removedDirectory: true })
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] rm ${located.directory} failed: ${error?.message ?? error}`)
      results.push({ id, ok: false, error: 'remove-failed' })
    }
  }
  return { results }
}

/**
 * Remove one session directory and everything that mirrors it: the trash
 * record is marked `purged` (not dropped), the host-side caches are
 * invalidated, and the sticky in-process purge tracker is refreshed.
 *
 * Shared by `delete` (option A: delete means delete) and `purge`. It never
 * uses a host locator — rc.1 has none (audit P1/P2) — so it works for an id the
 * host no longer lists at all.
 */
async function removeSessionDir(ctx, id, { manifest, sessionsRoot, titleCache, logger, purgeTracker }) {
  const located = await locateSessionDir(sessionsRoot, id)
  if (!located.ok) {
    if (located.error !== 'session-dir-not-found' && located.error !== 'sessions-root-missing') {
      return { id, ok: false, error: located.error }
    }
    // Nothing on disk: still record the purge so a stale in-memory corpus
    // cannot bring the row back.
    await manifest.markPurged(id)
    await invalidateRemovedSession(ctx, id, logger)
    purgeTracker?.mark(id)
    titleCache?.delete(id)
    return { id, ok: true, freedBytes: 0 }
  }
  if (!isSessionDir(located.directory, sessionsRoot, id)) {
    logger?.warn?.(`[dsh-session-manager] refusing to remove ${located.directory}: outside the sessions root or mismatched id`)
    return { id, ok: false, error: 'unsafe-path' }
  }
  let freedBytes = 0
  try {
    const snapshot = await ctx.get('sessionPersistence')?.stat?.(id)
    freedBytes = Number.isFinite(snapshot?.sizeBytes) ? snapshot.sizeBytes : 0
  } catch { /* best-effort accounting */ }
  try {
    await rm(located.directory, { recursive: true, force: true })
  } catch (error) {
    logger?.warn?.(`[dsh-session-manager] rm ${located.directory} failed: ${error?.message ?? error}`)
    return { id, ok: false, error: 'remove-failed' }
  }
  await manifest.markPurged(id)
  titleCache?.delete(id)
  // The directory is gone but every host-side cache still holds the id;
  // without this the row survives in the sidebar's Archived view until the
  // client is restarted, when bootstrap prunes it by re-reading disk.
  await invalidateRemovedSession(ctx, id, logger)
  purgeTracker?.mark(id)
  return { id, ok: true, freedBytes }
}

export async function restoreSessions(ctx, ids, { manifest, titleCache, logger }) {
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
    if (entry.purged) {
      // The directory is gone; a manifest entry cannot bring it back (audit P3).
      results.push({ id, ok: false, error: 'purged' })
      continue
    }
    await manifest.remove(id)
    titleCache?.delete(id)
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
    // NOTE: no `registry.unarchiveSession(id)` here. The pre-purge
    // `archiveSession` is what stops the session's activity; un-archiving
    // immediately after deleting the directory only re-publishes the id —
    // including one whose session is gone — for the next corpus read to pick
    // up. Removing the directory is a removal, not an un-archive (audit P3).
  }
  ctx.emit?.('api-session/removed', id)
}

/**
 * Permanently remove sessions: stop their activity, delete their directory
 * under <$DSH_HOME>/sessions, and leave a `purged` manifest record so the
 * removal still holds after a restart (audit P2/P3).
 *
 * Unlike `delete`, purge does NOT depend on the session being listed by the
 * host: an id whose sessionQuery record is already gone must still be removable
 * (that is the common case when clearing a ghost row), so the directory is
 * located directly.
 */
export async function purgeSessions(ctx, ids, { manifest, dshHome, titleCache, logger, purgeTracker }) {
  const sessionsRoot = resolve(join(resolve(dshHome), 'sessions'))
  const results = []
  for (const id of ids) {
    results.push(await removeSessionDir(ctx, id, { manifest, sessionsRoot, titleCache, logger, purgeTracker }))
  }
  return { results }
}
