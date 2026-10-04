// dsh-session-manager — SessionResourceManager: the lifecycle orchestrator.
//
// One instance per plugin. It owns, per session:
//
//   Baseline          captured on FIRST sight (a session event, a diff or a
//                     removal) — never retroactively re-captured
//   Trackers          file diff engine + dependency/env/download/process
//   Change Journal    append-only JSONL, written through `record()`
//   Cleanup State     cleanup.json via the CleanupEngine
//
// and exposes the operations the RPC layer and the delete/purge flows need:
// observe (session events), diff, prepare/finish a removal, resume unfinished
// cleanups after a crash, and the read-only views (changes / resources /
// cleanup status).
//
// Design constraints this file enforces:
//   - Resource tracking NEVER blocks or breaks session management: every
//     tracking failure degrades to "untracked", every helper is best-effort.
//   - Ownership is judged against the baseline (requirement §四) at RECORD
//     time and frozen into the journal.
//   - Legacy sessions (no tracking dir) are detected and treated as
//     attributable-nothing: cleanup skips resource rollback entirely
//     (requirement §十五).

import { join, resolve } from 'node:path'
import { readdir, rm, stat, readFile } from 'node:fs/promises'
import { encodeSegment } from '../session-manage.js'
import {
  ACTIONS, OWNERSHIP, RESOURCE_TYPES, CLEANUP_STATES, RESUMABLE_STATES,
  makeChangeRecord, isInsideRoot, sha256Hex,
} from './types.js'
import { createChangeJournal, replayPathRecords } from './journal.js'
import { createSnapshotStore } from './snapshots.js'
import { createBaselineStore, baselineStateMap, DEFAULT_EXCLUDES } from './baseline.js'
import { createCleanupEngine, createCleanupStateStore, lockIsBusy } from './cleanup.js'
import { createDefaultTrackers } from './trackers/index.js'
import {
  nodeModulesAdapter, createDependencyTracker,
  serializeDepSnapshot, deserializeDepSnapshot,
} from './trackers/deps.js'
import { parseEnvCommand } from './trackers/env.js'

const DIFF_DEBOUNCE_MS = 800
const PATH_RESOURCE_TYPES = new Set(['file', 'configuration', 'directory', 'download'])

/**
 * Map a raw tracker change to its journal ownership stamp. The rule is
 * baseline-anchored (requirement §四): what matters is whether the resource
 * existed BEFORE the session, not before the individual change — the cleanup
 * ledger independently derives the net effect per path from the same
 * baseline membership, so labels and rollback behavior can never disagree.
 */
export function deriveOwnership(change, { inBaseline }) {
  switch (change.resourceType) {
    case RESOURCE_TYPES.DEPENDENCY:
      if (change.action === ACTIONS.INSTALLED) return OWNERSHIP.SESSION_INSTALLED
      if (change.action === ACTIONS.UPGRADED) return OWNERSHIP.SESSION_MODIFIED
      return OWNERSHIP.SESSION_MODIFIED // uninstalled a pre-existing package
    case RESOURCE_TYPES.ENVIRONMENT_VARIABLE:
      if (change.action === ACTIONS.SET) return inBaseline ? OWNERSHIP.SESSION_MODIFIED : OWNERSHIP.SESSION_CREATED
      return OWNERSHIP.SESSION_DELETED // unset of something that existed
    case RESOURCE_TYPES.PROCESS:
      return OWNERSHIP.SESSION_CREATED
    default: // file / configuration / directory / download
      if (change.action === ACTIONS.CREATED || change.action === ACTIONS.DOWNLOADED) return OWNERSHIP.SESSION_CREATED
      if (change.action === ACTIONS.DELETED) return OWNERSHIP.SESSION_DELETED
      if (change.resourceType === RESOURCE_TYPES.CONFIGURATION) return OWNERSHIP.SESSION_CONFIGURED
      return OWNERSHIP.SESSION_MODIFIED
  }
}

/** In-baseline check per resource kind. */
function baselineMembership(change, baseline) {
  const path = change.resource?.path
  if (typeof path === 'string' && path !== '') {
    if (change.resourceType === RESOURCE_TYPES.DIRECTORY) {
      return Array.isArray(baseline.dirs) && baseline.dirs.includes(path)
    }
    return baseline.files !== undefined && Object.prototype.hasOwnProperty.call(baseline.files, path)
  }
  if (change.resourceType === RESOURCE_TYPES.ENVIRONMENT_VARIABLE) {
    // env "existed at baseline" == the before-side of this change says so
    return change.before !== null
  }
  return false
}

function clampNumber(value, min, max, fallback) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

/**
 * @param {object} opts
 * @param {string} opts.dshHome resolved $DSH_HOME
 * @param {object} opts.ctx cordis context (lazy service probes)
 * @param {() => object} opts.getConfig resolved config snapshot (volatile-aware)
 * @param {object} [opts.logger]
 */
export function createSessionResourceManager({ dshHome, ctx, getConfig, logger }) {
  const trackingRoot = join(dshHome, 'dsh-session-manager', 'tracking')
  const runtimes = new Map() // sessionId → runtime
  const baselineJobs = new Map() // sessionId → in-flight capture promise
  const diffTimers = new Map() // sessionId → timer
  const lastSeenAt = new Map() // sessionId → last session-event timestamp
  let bootstrapStarted = false

  function enabled() {
    return getConfig().trackingEnabled !== false
  }

  function scanBounds() {
    const config = getConfig()
    return {
      maxFiles: clampNumber(config.trackingMaxFiles, 1, 200_000, 5000),
      maxDepth: clampNumber(config.trackingMaxDepth, 0, 64, 12),
      excludes: Array.isArray(config.trackingExclude) && config.trackingExclude.length > 0 ? config.trackingExclude : DEFAULT_EXCLUDES,
    }
  }

  function snapshotLimit() {
    return clampNumber(getConfig().trackingMaxSnapshotBytes, 4096, 512 * 1024 * 1024, 8 * 1024 * 1024)
  }

  function conflictMode() {
    return getConfig().conflictMode === 'force' ? 'force' : 'safe'
  }

  const dirFor = sessionId => join(trackingRoot, encodeSegment(String(sessionId)))

  function storesFor(sessionId) {
    const dir = dirFor(sessionId)
    const snapshotStore = createSnapshotStore(join(dir, 'snapshots'), { maxFileBytes: snapshotLimit(), logger })
    return {
      dir,
      snapshotStore,
      baselineStore: createBaselineStore(join(dir, 'baseline.json'), snapshotStore, logger),
      journal: createChangeJournal(join(dir, 'changes.jsonl'), logger),
      stateStore: createCleanupStateStore(join(dir, 'cleanup.json'), logger),
    }
  }

  function createEngine(sessionId, stores) {
    return createCleanupEngine({
      trackingDir: stores.dir,
      sessionId,
      stateStore: stores.stateStore,
      journal: stores.journal,
      baselineStore: stores.baselineStore,
      snapshotStore: stores.snapshotStore,
      depAdapters: [nodeModulesAdapter],
      env: process.env,
      conflictMode: conflictMode(),
      logger,
    })
  }

  /** Resolve the session cwd from the host corpus (best effort). */
  async function lookupCwd(sessionId) {
    const query = ctx.get?.('sessionQuery')
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        const hit = (records ?? []).find(record => String(record?.header?.id) === String(sessionId))
        if (typeof hit?.header?.cwd === 'string' && hit.header.cwd !== '') return resolve(hit.header.cwd)
      } catch { /* fall through */ }
    }
    const persistence = ctx.get?.('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      try {
        const snapshots = await persistence.list()
        const hit = (snapshots ?? []).find(snapshot => String(snapshot?.header?.id) === String(sessionId))
        if (typeof hit?.header?.cwd === 'string' && hit.header.cwd !== '') return resolve(hit.header.cwd)
      } catch { /* give up */ }
    }
    return null
  }

  /**
   * Capture the baseline for `sessionId` if it does not have one. Idempotent
   * and race-safe (concurrent callers share one capture promise). The
   * baseline anchors PREEXISTING: whatever exists at first sight is never
   * attributed to the session.
   */
  async function ensureBaseline(sessionId) {
    if (enabled() === false) return null
    const stores = storesFor(sessionId)
    const existing = await stores.baselineStore.load()
    if (existing !== null) return existing
    let job = baselineJobs.get(sessionId)
    if (job !== undefined) return job
    job = (async () => {
      try {
        const cwd = await lookupCwd(sessionId)
        if (cwd === null) return null
        const deps = await createDependencyTracker({ cwd, logger }).snapshot()
        const bounds = scanBounds()
        const { baseline } = await stores.baselineStore.capture(sessionId, cwd, {
          maxFiles: bounds.maxFiles,
          maxDepth: bounds.maxDepth,
          excludes: bounds.excludes,
          extra: { dependencies: serializeDepSnapshot(deps) },
        })
        runtimes.delete(sessionId) // rebuild runtime against the real baseline
        logger?.info?.(`[dsh-session-manager] baseline captured for ${sessionId} at ${cwd}`)
        return baseline
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] baseline capture for ${sessionId} failed: ${error?.message ?? error}`)
        return null
      } finally {
        baselineJobs.delete(sessionId)
      }
    })()
    baselineJobs.set(sessionId, job)
    return job
  }

  /**
   * Build (or rebuild) the per-session runtime: last-known state from
   * baseline + journal replay, trackers wired against both.
   */
  async function runtimeFor(sessionId) {
    const cached = runtimes.get(sessionId)
    if (cached !== undefined) return cached
    const stores = storesFor(sessionId)
    const baseline = await stores.baselineStore.load()
    if (baseline === null) return null
    const records = await stores.journal.readAll()

    const state = baselineStateMap(baseline)
    replayPathRecords(state, records)

    const initialDirs = new Set(Array.isArray(baseline.dirs) ? baseline.dirs : [])
    const baselineDeps = deserializeDepSnapshot(baseline.dependencies)
    for (const record of records) {
      if (record.resourceType === RESOURCE_TYPES.DIRECTORY && record.action === ACTIONS.CREATED && typeof record.resource?.path === 'string') {
        initialDirs.add(record.resource.path)
      }
      if (record.resourceType === RESOURCE_TYPES.DEPENDENCY) {
        const manager = record.resource?.manager
        const pkg = record.resource?.package
        if (typeof manager !== 'string' || typeof pkg !== 'string') continue
        const known = baselineDeps.get(manager) ?? new Map()
        if (record.action === ACTIONS.UNINSTALLED) known.delete(pkg)
        else known.set(pkg, record.after ?? {})
        baselineDeps.set(manager, known)
      }
    }

    const trackers = createDefaultTrackers({
      cwd: baseline.cwd,
      state,
      baselineDirs: [...initialDirs],
      baselineDeps,
      snapshotStore: stores.snapshotStore,
      scan: scanBounds(),
      logger,
    })
    const runtime = {
      sessionId,
      cwd: baseline.cwd,
      baseline,
      stores,
      state,
      trackers,
    }
    runtimes.set(sessionId, runtime)
    return runtime
  }

  /** Stamp ownership, then append one change to the journal. */
  async function record(runtime, change) {
    if (change === null || change === undefined) return null
    const inBaseline = baselineMembership(change, runtime.baseline)
    const stamped = makeChangeRecord({
      seq: 0, // the journal assigns the real sequence number on append
      sessionId: runtime.sessionId,
      resourceType: change.resourceType,
      action: change.action,
      resource: change.resource,
      before: change.before ?? null,
      after: change.after ?? null,
      ownership: deriveOwnership(change, { inBaseline }),
      metadata: change.metadata,
    })
    return runtime.stores.journal.append(stamped)
  }

  // -------------------------------------------------------------------------
  // Event intake
  // -------------------------------------------------------------------------

  /**
   * Feed one `session/event` payload. Cheap by design: baselines are ensured
   * once, command parsing only runs for tool calls, diffs are debounced per
   * session.
   */
  async function observeEvent(sessionId, event) {
    if (typeof sessionId !== 'string' || sessionId === '' || event === null || typeof event !== 'object') return
    try {
      if (enabled() === false) return
      lastSeenAt.set(sessionId, Date.now())
      await ensureBaseline(sessionId)
      const runtime = await runtimeFor(sessionId)
      if (runtime === null) return

      if (event.type === 'tool/call') {
        await observeToolCall(runtime, event)
        return
      }
      if (event.type === 'tool/result') {
        scheduleDiff(sessionId)
      }
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] observe ${sessionId} failed: ${error?.message ?? error}`)
    }
  }

  async function observeToolCall(runtime, event) {
    let call = {}
    try {
      call = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : (event.data?.arguments ?? {})
    } catch {
      call = {}
    }
    const toolName = String(event.data?.name ?? '')
    const command = typeof call?.command === 'string' ? call.command : ''

    if (command !== '') {
      // persistent env mutations from shell syntax: journaled AND applied to
      // the plugin's process env — that env is the only scope the host side
      // can actually manage, and applying at record time is what gives the
      // journal's before/after real restore semantics
      for (const mutation of parseEnvCommand(command)) {
        const change = runtime.trackers.env.classify(mutation)
        if (change !== null) {
          await record(runtime, change)
          runtime.trackers.env.apply(mutation.name, mutation.kind === 'unset' ? null : mutation.rawValue)
        }
      }
      // background spawns
      const spawnChange = runtime.trackers.process.classify({ command })
      if (spawnChange !== null) await record(runtime, spawnChange)
    }
    // download intents (fetch-shaped tools, curl/wget in bash)
    runtime.trackers.download.observeToolCall({ name: toolName, command: command !== '' ? command : JSON.stringify(call ?? {}) })
  }

  function scheduleDiff(sessionId) {
    if (diffTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      diffTimers.delete(sessionId)
      void diffSession(sessionId).catch(error => {
        logger?.warn?.(`[dsh-session-manager] diff ${sessionId} failed: ${error?.message ?? error}`)
      })
    }, DIFF_DEBOUNCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    diffTimers.set(sessionId, timer)
  }

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  /**
   * One full tracking pass: file diff, download correlation, dependency
   * diff — everything goes through `record()` so ownership and journaling
   * stay uniform. Returns the number of changes journaled.
   */
  async function diffSession(sessionId) {
    if (enabled() === false) return { journaled: 0, tracked: false }
    await ensureBaseline(sessionId)
    const runtime = await runtimeFor(sessionId)
    if (runtime === null) return { journaled: 0, tracked: false }

    let journaled = 0
    const pathChanges = await runtime.trackers.file.diff()
    const createdPaths = pathChanges
      .filter(change => change.action === ACTIONS.CREATED && change.resourceType !== RESOURCE_TYPES.DIRECTORY)
      .map(change => change.resource.path)
    const downloads = runtime.trackers.download.correlate(createdPaths)
    const downloadByPath = new Map(downloads.map(entry => [entry.path, entry.url]))

    for (const change of pathChanges) {
      if (change.resourceType === RESOURCE_TYPES.DIRECTORY && baselineMembership(change, runtime.baseline)) {
        continue // pre-existing directory resurfaced in the scan; not a change
      }
      const url = downloadByPath.get(change.resource?.path)
      if (url !== undefined && change.action === ACTIONS.CREATED) {
        await record(runtime, {
          ...change,
          resourceType: RESOURCE_TYPES.DOWNLOAD,
          action: ACTIONS.DOWNLOADED,
          metadata: { url },
        })
      } else {
        await record(runtime, change)
      }
      journaled += 1
    }

    const depChanges = await runtime.trackers.dependency.diff()
    for (const change of depChanges) {
      await record(runtime, change)
      journaled += 1
    }
    return { journaled, tracked: true }
  }

  // -------------------------------------------------------------------------
  // Removal integration (delete / purge)
  // -------------------------------------------------------------------------

  async function hasAnyTracking(sessionId) {
    const stores = storesFor(sessionId)
    return (await stores.baselineStore.load()) !== null || (await stores.journal.exists())
  }

  /**
   * Everything that must happen BEFORE the session directory disappears:
   * final diff (stragglers → journal), cleanup request, journal-driven
   * rollback with conflict detection. Untracked/legacy sessions short-circuit
   * to a no-op so the existing removal flow is untouched.
   *
   * The final diff runs only while the session still looks ALIVE (a session
   * event inside the idle window): once a session has gone quiet, workspace
   * changes are as likely to be somebody else's — diffing them into the
   * journal would re-brand external edits as session-owned and defeat the
   * conflict check that protects them (requirement §六/§九). Idle sessions
   * roll back against the journal as it stands.
   */
  async function prepareRemoval(sessionId, { mode = 'full' } = {}) {
    if (enabled() === false || getConfig().autoCleanup === false) {
      return { ok: true, skipped: 'tracking-disabled', state: null, actions: [], conflicts: [], failures: [] }
    }
    if ((await hasAnyTracking(sessionId)) === false) {
      return { ok: true, skipped: 'legacy-untracked', state: null, actions: [], conflicts: [], failures: [] }
    }
    let finalDiff = 'skipped-idle'
    const idleWindowMs = clampNumber(getConfig().trackingIdleWindowMs, 0, 7 * 24 * 3600 * 1000, 5 * 60 * 1000)
    const lastSeen = lastSeenAt.get(sessionId) ?? 0
    if (idleWindowMs > 0 && Date.now() - lastSeen <= idleWindowMs) {
      finalDiff = 'ran'
      try {
        await diffSession(sessionId) // final diff — requirement §六/§七
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] final diff ${sessionId} failed: ${error?.message ?? error}`)
      }
    }
    const engine = createEngine(sessionId, storesFor(sessionId))
    await engine.requestCleanup(mode)
    const outcome = await engine.rollback()
    return { ok: outcome.ok, state: outcome.state, actions: outcome.actions, conflicts: outcome.conflicts, failures: outcome.failures, finalDiff }
  }

  /** Written BEFORE the session dir is unlinked (crash-resumable marker). */
  async function beforeSessionDirRemoval(sessionId) {
    if ((await hasAnyTracking(sessionId)) === false) return false
    const engine = createEngine(sessionId, storesFor(sessionId))
    await engine.markSessionDeleted()
    return true
  }

  /**
   * Called AFTER the session dir is gone. Destroys the journal — but only
   * when rollback verified; a failed/conflicted rollback keeps the journal
   * for inspection and retry (cleanupStatus stays queryable).
   */
  async function afterSessionDirRemoved(sessionId) {
    const stores = storesFor(sessionId)
    const engine = createEngine(sessionId, stores)
    const state = await engine.loadState()
    if (state === null) {
      // no cleanup.json (e.g. tracking was disabled mid-flight): a journal
      // with no verified rollback must not be silently destroyed
      if ((await stores.journal.exists()) === false) {
        await rm(dirFor(sessionId), { recursive: true, force: true }).catch(() => {})
        return { removed: true, reason: 'no-tracking' }
      }
      return { removed: false, reason: 'rollback-not-verified' }
    }
    if (state.state === CLEANUP_STATES.ROLLBACK_FAILED) {
      return { removed: false, reason: 'rollback-failed', state }
    }
    await engine.finish()
    runtimes.delete(sessionId)
    return { removed: true, reason: 'verified' }
  }

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  /**
   * Scan every tracking dir for unfinished cleanups and resume them. Called
   * once per plugin start. `autoResume: false` only logs.
   */
  async function resumePending() {
    let entries = []
    try {
      entries = await readdir(trackingRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`[dsh-session-manager] tracking root scan failed: ${error?.message ?? error}`)
      }
      return []
    }
    const resumed = []
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue
      const stores = storesFor(entry.name)
      const engine = createEngine(entry.name, stores)
      const state = await engine.loadState()
      if (state === null || RESUMABLE_STATES.has(state.state) === false) continue
      if (lockIsBusy(state)) {
        logger?.info?.(`[dsh-session-manager] cleanup for ${entry.name} is owned by a live process; skipping`)
        continue
      }
      const decodedSessionId = typeof state.sessionId === 'string' && state.sessionId !== '' ? state.sessionId : entry.name
      if (getConfig().autoResume === false) {
        logger?.info?.(`[dsh-session-manager] unfinished cleanup for ${decodedSessionId} (${state.state}); autoResume disabled`)
        continue
      }
      try {
        if (state.state === CLEANUP_STATES.ROLLBACK_VERIFIED || state.state === CLEANUP_STATES.SESSION_DELETED) {
          // rollback already done; only the teardown owes work
          if (state.mode === 'rollback-only') {
            resumed.push({ sessionId: decodedSessionId, state: state.state, resumed: true, note: 'rollback-only-terminal' })
            continue
          }
          const removed = await removeSessionDirForResume(decodedSessionId)
          await beforeSessionDirRemoval(decodedSessionId)
          const finished = await afterSessionDirRemoved(decodedSessionId)
          resumed.push({ sessionId: decodedSessionId, state: finished.removed ? 'complete' : finished.reason, resumed: true, sessionDirRemoved: removed })
          continue
        }
        // delete_requested / rolling_back / rollback_failed → run the
        // (idempotent) rollback first, then finish per recorded mode
        const outcome = await engine.rollback()
        if (outcome.ok !== true) {
          resumed.push({ sessionId: decodedSessionId, state: outcome.state, resumed: false })
          continue
        }
        if (state.mode === 'rollback-only') {
          resumed.push({ sessionId: decodedSessionId, state: outcome.state, resumed: true })
          continue
        }
        const removed = await removeSessionDirForResume(decodedSessionId)
        await beforeSessionDirRemoval(decodedSessionId)
        const finished = await afterSessionDirRemoved(decodedSessionId)
        resumed.push({ sessionId: decodedSessionId, state: finished.removed ? 'complete' : finished.reason, resumed: true, sessionDirRemoved: removed })
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] resume for ${decodedSessionId} failed: ${error?.message ?? error}`)
        resumed.push({ sessionId: decodedSessionId, resumed: false, error: error?.message ?? 'resume-failed' })
      }
    }
    return resumed
  }

  /** Remove the session directory using the same guards as the purge flow. */
  async function removeSessionDirForResume(sessionId) {
    const manage = await import('../session-manage.js')
    const sessionsRoot = join(dshHome, 'sessions')
    const located = await manage.locateSessionDir(sessionsRoot, sessionId)
    if (located.ok === false) {
      return located.error === 'session-dir-not-found' || located.error === 'sessions-root-missing'
    }
    if (manage.isSessionDir(located.directory, sessionsRoot, sessionId) === false) return false
    try {
      await rm(located.directory, { recursive: true, force: true })
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] resume rm ${located.directory} failed: ${error?.message ?? error}`)
      return false
    }
    try {
      await manage.invalidateRemovedSession(ctx, sessionId, logger)
    } catch { /* best effort cache invalidation */ }
    return true
  }

  // -------------------------------------------------------------------------
  // Views (RPC support)
  // -------------------------------------------------------------------------

  /** Raw journal tail for one session. */
  async function getChanges(sessionId, { limit = 500 } = {}) {
    const stores = storesFor(sessionId)
    const records = await stores.journal.readAll()
    const sliced = Number.isFinite(limit) && limit > 0 ? records.slice(-limit) : records
    return {
      sessionId,
      tracked: sliced.length > 0 || (await stores.baselineStore.load()) !== null,
      total: records.length,
      changes: sliced,
    }
  }

  /**
   * Resource view: baseline (preexisting) + journal-derived session-owned
   * resources with their CURRENT status. One row per resource.
   */
  async function getResources(sessionId) {
    const stores = storesFor(sessionId)
    const baseline = await stores.baselineStore.load()
    if (baseline === null) return { sessionId, tracked: false, resources: [], baseline: null }
    const records = await stores.journal.readAll()
    const cwd = typeof baseline.cwd === 'string' ? resolve(baseline.cwd) : null

    const rows = new Map() // key → row
    const rowKey = (kind, id) => `${kind}\u0000${id}`

    // baseline → preexisting rows
    for (const [path, entry] of Object.entries(baseline.files ?? {})) {
      rows.set(rowKey('path', path), {
        resourceType: 'file',
        identifier: path,
        ownership: OWNERSHIP.PREEXISTING,
        actions: [],
        baseline: { sha256: entry.sha256, size: entry.size },
        lastTimestamp: baseline.capturedAt,
      })
    }
    // baseline dependencies → preexisting rows (the journal updates them the
    // moment the session touches the package)
    for (const [manager, packages] of Object.entries(baseline.dependencies ?? {})) {
      for (const [name, info] of Object.entries(packages ?? {})) {
        rows.set(rowKey('dep', `${manager}/${name}`), {
          resourceType: RESOURCE_TYPES.DEPENDENCY,
          identifier: `${manager}/${name}`,
          ownership: OWNERSHIP.PREEXISTING,
          actions: [],
          before: info?.version ?? null,
          lastTimestamp: baseline.capturedAt,
        })
      }
    }

    // journal records → session-owned rows (latest record wins the label)
    for (const record of records) {
      if (record.resourceType === RESOURCE_TYPES.ENVIRONMENT_VARIABLE) {
        const key = rowKey('env', record.resource.name)
        const existing = rows.get(key)
        rows.set(key, {
          resourceType: RESOURCE_TYPES.ENVIRONMENT_VARIABLE,
          identifier: record.resource.name,
          ownership: record.ownership,
          actions: [...(existing?.actions ?? []), record.action],
          scope: record.resource.scope,
          lastTimestamp: record.timestamp,
        })
        continue
      }
      if (record.resourceType === RESOURCE_TYPES.DEPENDENCY) {
        const identifier = `${record.resource.manager}/${record.resource.package}`
        const key = rowKey('dep', identifier)
        const existing = rows.get(key)
        rows.set(key, {
          resourceType: RESOURCE_TYPES.DEPENDENCY,
          identifier,
          ownership: record.ownership,
          actions: [...(existing?.actions ?? []), record.action],
          before: record.before?.version ?? null,
          after: record.after?.version ?? null,
          lastTimestamp: record.timestamp,
        })
        continue
      }
      if (record.resourceType === RESOURCE_TYPES.PROCESS) {
        const key = rowKey('process', String(record.resource.command))
        if (rows.has(key) === false) {
          rows.set(key, {
            resourceType: RESOURCE_TYPES.PROCESS,
            identifier: record.resource.command,
            ownership: record.ownership,
            actions: [record.action],
            lastTimestamp: record.timestamp,
          })
        }
        continue
      }
      const path = record.resource?.path
      if (typeof path !== 'string' || path === '') continue
      const key = rowKey('path', path)
      const existing = rows.get(key)
      const row = existing ?? {
        resourceType: record.resourceType,
        identifier: path,
        ownership: record.ownership,
        actions: [],
        baseline: null,
        lastTimestamp: record.timestamp,
      }
      if (existing === undefined && baseline.files?.[path] !== undefined) {
        row.baseline = { sha256: baseline.files[path].sha256, size: baseline.files[path].size }
      }
      row.actions = [...row.actions, record.action]
      row.ownership = record.ownership
      row.lastTimestamp = record.timestamp
      if (record.metadata?.url !== undefined) row.url = record.metadata.url
      rows.set(key, row)
      if (typeof record.resource.to === 'string' && record.resource.to !== '') {
        // moved/renamed: surface the destination as its own row
        const toKey = rowKey('path', record.resource.to)
        rows.set(toKey, {
          resourceType: record.resourceType,
          identifier: record.resource.to,
          ownership: record.ownership,
          actions: [`${record.action} (from ${path})`],
          baseline: null,
          lastTimestamp: record.timestamp,
        })
      }
    }

    // current status per row kind
    for (const row of rows.values()) {
      if (PATH_RESOURCE_TYPES.has(row.resourceType)) {
        row.status = await pathStatus(cwd, row)
      } else if (row.resourceType === RESOURCE_TYPES.ENVIRONMENT_VARIABLE) {
        row.status = row.identifier in process.env ? 'present' : 'missing'
      } else if (row.resourceType === RESOURCE_TYPES.DEPENDENCY) {
        row.status = 'see-actions'
      } else {
        row.status = 'informational'
      }
    }

    return {
      sessionId,
      tracked: true,
      baseline: {
        cwd: baseline.cwd,
        capturedAt: baseline.capturedAt,
        fileCount: Object.keys(baseline.files ?? {}).length,
        truncated: baseline.truncated === true,
      },
      resources: [...rows.values()],
    }
  }

  async function pathStatus(cwd, row) {
    if (cwd === null) return 'unknown'
    const absolute = join(cwd, row.identifier)
    if (isInsideRoot(absolute, cwd) === false) return 'unknown'
    const info = await stat(absolute).catch(() => null)
    if (info === null) return 'missing'
    if (row.baseline?.sha256 !== null && row.baseline?.sha256 !== undefined && info.isFile()) {
      try {
        const hash = sha256Hex(await readFile(absolute))
        return hash === row.baseline.sha256 ? 'matches-baseline' : 'differs-from-baseline'
      } catch {
        return 'unreadable'
      }
    }
    return 'present'
  }

  /** Cleanup status for the RPC layer. */
  async function getCleanupStatus(sessionId) {
    const stores = storesFor(sessionId)
    const engine = createEngine(sessionId, stores)
    const status = await engine.status()
    return {
      sessionId,
      tracked: status.tracked,
      legacy: status.tracked === false,
      cleanup: status.cleanup,
    }
  }

  /**
   * Explicit cleanup entry point (RPC `cleanup`).
   *   'rollback-only'  reverse resources, keep the session (default)
   *   'resume'         continue whatever cleanup.json still owes
   *   'full'           rollback + remove the session dir + destroy the journal
   */
  async function cleanupSession(sessionId, { mode = 'rollback-only' } = {}) {
    if (mode === 'rollback-only') {
      return prepareRemoval(sessionId, { mode: 'rollback-only' })
    }
    if (mode === 'full') {
      const prepared = await prepareRemoval(sessionId, { mode: 'full' })
      if (prepared.skipped !== undefined) return prepared
      await beforeSessionDirRemoval(sessionId)
      const removed = await removeSessionDirForResume(sessionId)
      const finished = await afterSessionDirRemoved(sessionId)
      return {
        ok: finished.removed === true,
        state: finished.removed ? 'complete' : finished.reason,
        sessionDirRemoved: removed,
        actions: prepared.actions,
        conflicts: prepared.conflicts,
        failures: prepared.failures,
      }
    }
    // resume
    const stores = storesFor(sessionId)
    const engine = createEngine(sessionId, stores)
    const state = await engine.loadState()
    if (state === null || RESUMABLE_STATES.has(state.state) === false) {
      return { ok: true, state: state?.state ?? 'none', actions: [], conflicts: [], failures: [], note: 'nothing-to-resume' }
    }
    if (state.mode === 'rollback-only') {
      const outcome = await engine.rollback()
      return { ok: outcome.ok, state: outcome.state, actions: outcome.actions, conflicts: outcome.conflicts, failures: outcome.failures }
    }
    if (state.state === CLEANUP_STATES.ROLLBACK_FAILED) {
      // a rollback that failed last time: rerun it, then finish only if clean
      const outcome = await engine.rollback()
      if (outcome.ok !== true) {
        return { ok: false, state: outcome.state, actions: outcome.actions, conflicts: outcome.conflicts, failures: outcome.failures }
      }
    }
    await beforeSessionDirRemoval(sessionId)
    const removed = await removeSessionDirForResume(sessionId)
    const finished = await afterSessionDirRemoved(sessionId)
    return {
      ok: finished.removed === true,
      state: finished.removed ? 'complete' : finished.reason,
      sessionDirRemoved: removed,
    }
  }

  /** Cheap tracked-flag for list rows. */
  async function isTracked(sessionId) {
    if (enabled() === false) return false
    return stat(join(dirFor(sessionId), 'baseline.json')).then(info => info.isFile()).catch(() => false)
  }

  /** Cancel pending cleanup (session restored from trash). */
  async function cancelPendingCleanup(sessionId) {
    const engine = createEngine(sessionId, storesFor(sessionId))
    return engine.cancelPending()
  }

  /** Debounce timers teardown (plugin unload). */
  function dispose() {
    for (const timer of diffTimers.values()) clearTimeout(timer)
    diffTimers.clear()
  }

  /** Startup: resume unfinished cleanups exactly once. */
  async function bootstrap() {
    if (bootstrapStarted) return []
    bootstrapStarted = true
    try {
      return await resumePending()
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] cleanup resume failed: ${error?.message ?? error}`)
      return []
    }
  }

  return {
    ensureBaseline,
    observeEvent,
    diffSession,
    prepareRemoval,
    beforeSessionDirRemoval,
    afterSessionDirRemoved,
    resumePending,
    bootstrap,
    getChanges,
    getResources,
    getCleanupStatus,
    cleanupSession,
    isTracked,
    cancelPendingCleanup,
    dispose,
    trackingRoot,
  }
}
