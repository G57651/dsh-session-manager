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
import { readdir, rm, stat, readFile, writeFile, mkdir } from 'node:fs/promises'
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
const ACTIVITY_FLUSH_MS = 1500
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
 * @param {object} [opts.manifest] trash manifest store (session-manage.js) —
 *   purge tombstones keep the baseline sweep from resurrecting dead sessions
 *   whose host-side corpus cache is stale
 * @param {object} [opts.opener] platform opener (lifecycle/opener.js) for
 *   reveal / open-with-application
 * @param {() => object} opts.getConfig resolved config snapshot (volatile-aware)
 * @param {object} [opts.logger]
 */
export function createSessionResourceManager({ dshHome, ctx, manifest, opener, getConfig, logger }) {
  const trackingRoot = join(dshHome, 'dsh-session-manager', 'tracking')
  const runtimes = new Map() // sessionId → runtime
  const baselineJobs = new Map() // sessionId → in-flight capture promise
  const diffTimers = new Map() // sessionId → timer
  const lastSeenAt = new Map() // sessionId → last session-event timestamp (in-memory)
  const activityTimers = new Map() // sessionId → debounced activity.json writer
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
      // 最终 diff 记录的可疑阈值（复用 trackingIdleWindowMs 配置）：会话安静
      // 超过此时长后，删除时 final diff 捕获的变更按外部修改保护，不自动回滚
      finalDiffSuspectMs: clampNumber(getConfig().trackingIdleWindowMs, 0, 7 * 24 * 3600 * 1000, 5 * 60 * 1000),
      logger,
    })
  }

  // -------------------------------------------------------------------------
  // Session activity clock — persisted so ownership judgements survive a
  // plugin remount / host restart (the in-memory map alone would make every
  // post-restart final-diff record look ancient and get skipped).
  // -------------------------------------------------------------------------

  const activityPathFor = sessionId => join(dirFor(sessionId), 'activity.json')

  /** Record session activity: in-memory immediately, disk debounced. */
  function noteActivity(sessionId) {
    const now = Date.now()
    lastSeenAt.set(sessionId, now)
    if (activityTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      activityTimers.delete(sessionId)
      void (async () => {
        await mkdir(dirFor(sessionId), { recursive: true })
        await writeFile(activityPathFor(sessionId), `${JSON.stringify({ lastEventAt: lastSeenAt.get(sessionId) ?? now })}\n`, 'utf8')
      })().catch(error => {
        logger?.warn?.(`[dsh-session-manager] activity persist for ${sessionId} failed: ${error?.message ?? error}`)
      })
    }, ACTIVITY_FLUSH_MS)
    if (typeof timer.unref === 'function') timer.unref()
    activityTimers.set(sessionId, timer)
  }

  /** Last observed session activity: max(in-memory, persisted). */
  async function lastSeenOf(sessionId) {
    const memory = lastSeenAt.get(sessionId) ?? 0
    try {
      const raw = JSON.parse(await readFile(activityPathFor(sessionId), 'utf8'))
      const persisted = Number(raw?.lastEventAt)
      return Math.max(memory, Number.isFinite(persisted) ? persisted : 0)
    } catch {
      return memory
    }
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
    // A session with a pending cleanup is being torn down — baselining it now
    // would race the resume (and can resurrect a tracking dir the rollback
    // just finished destroying). Purged tombstones protect against a stale
    // corpus listing a session whose data is already gone.
    if (manifest !== undefined && await manifest.isPurged?.(sessionId) === true) return null
    const pendingState = await stores.stateStore.load()
    if (pendingState !== null && RESUMABLE_STATES.has(pendingState.state)) return null
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

  /** Stamp ownership (and any caller metadata), then append to the journal. */
  async function record(runtime, change, extraMetadata = {}) {
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
      metadata: { ...(change.metadata ?? {}), ...extraMetadata },
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
      noteActivity(sessionId)
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

  /**
   * A session came into existence: baseline it RIGHT NOW, while its workspace
   * is still pristine — the earliest and most faithful attribution anchor we
   * can get (wired to the host `session/created` event).
   */
  async function observeSessionCreated(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '' ) return
    try {
      if (enabled() === false) return
      noteActivity(sessionId)
      await ensureBaseline(sessionId)
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] baseline on create for ${sessionId} failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Baseline every session the host corpus knows about, staggered to keep the
   * disk load flat. Closes the "session existed before the plugin loaded /
   * plugin remounted" gap: after a boot sweep, every known session has a
   * baseline, so later work is attributable instead of being grandfathered as
   * pre-existing forever.
   */
  async function baselineKnownSessions() {
    if (enabled() === false) return 0
    const ids = new Set()
    try {
      const query = ctx.get?.('sessionQuery')
      if (query !== undefined && typeof query.listSessions === 'function') {
        for (const record of (await query.listSessions()) ?? []) {
          const id = String(record?.header?.id ?? '')
          if (id !== '') ids.add(id)
        }
      }
    } catch { /* corpus unavailable; the event/list paths still self-heal */ }
    try {
      const persistence = ctx.get?.('sessionPersistence')
      if (persistence !== undefined && typeof persistence.list === 'function') {
        for (const snapshot of (await persistence.list()) ?? []) {
          const id = String(snapshot?.header?.id ?? '')
          if (id !== '') ids.add(id)
        }
      }
    } catch { /* same */ }
    let started = 0
    for (const id of ids) {
      started += 1
      void ensureBaseline(id).catch(() => {})
      // stagger so a large corpus does not stampede the disk at boot
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    return started
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
   * stay uniform. `recordMetadata` (used by the removal-time final diff)
   * is stamped onto every record this pass produces. Returns the number of
   * changes journaled.
   */
  async function diffSession(sessionId, { recordMetadata } = {}) {
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
        }, recordMetadata)
      } else {
        await record(runtime, change, recordMetadata)
      }
      journaled += 1
    }

    const depChanges = await runtime.trackers.dependency.diff()
    for (const change of depChanges) {
      await record(runtime, change, recordMetadata)
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
   * The final diff ALWAYS runs — a tracked session must be cleaned even when
   * its event-driven diffs were missed (plugin remount, restart). The risk of
   * re-attributing external edits is handled by marking every final-diff
   * record with the session's idle time and letting the cleanup engine SKIP
   * records whose idle time exceeds `trackingIdleWindowMs`: a change captured
   * long after the session went quiet is far more likely somebody else's, so
   * it is preserved and reported instead of rolled back.
   */
  async function prepareRemoval(sessionId, { mode = 'full' } = {}) {
    if (enabled() === false || getConfig().autoCleanup === false) {
      return { ok: true, skipped: 'tracking-disabled', state: null, actions: [], conflicts: [], failures: [] }
    }
    if ((await hasAnyTracking(sessionId)) === false) {
      return { ok: true, skipped: 'legacy-untracked', state: null, actions: [], conflicts: [], failures: [] }
    }
    let finalDiff = 'ran'
    let idleMs = null
    try {
      idleMs = Date.now() - (await lastSeenOf(sessionId))
      await diffSession(sessionId, { recordMetadata: { finalDiff: true, idleMs } })
    } catch (error) {
      finalDiff = 'failed'
      logger?.warn?.(`[dsh-session-manager] final diff ${sessionId} failed: ${error?.message ?? error}`)
    }
    const engine = createEngine(sessionId, storesFor(sessionId))
    await engine.requestCleanup(mode)
    const outcome = await engine.rollback()
    return { ok: outcome.ok, state: outcome.state, actions: outcome.actions, conflicts: outcome.conflicts, failures: outcome.failures, finalDiff, idleMs }
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
    // same tombstone the purge flow writes: a resumed cleanup IS a purge, and
    // the tombstone keeps the boot sweep (and any stale corpus) from treating
    // the session as live and re-baselining it
    try {
      await manifest?.markPurged?.(sessionId)
    } catch { /* tombstone is best-effort */ }
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
   * Resource view: ONLY what this session produced (requirement: baseline
   * before the task, compare after, list the session's own additions/changes
   * — never the files that already existed and were left untouched).
   *
   * Rows come from the change journal (session_created / session_modified /
   * session_deleted / session_installed / session_configured). Pre-existing
   * baseline content is summarized (file count / cwd / capturedAt) but NOT
   * listed; it is the reference for ownership and restore, not a result.
   */
  async function getResources(sessionId) {
    const stores = storesFor(sessionId)
    const baseline = await stores.baselineStore.load()
    if (baseline === null) return { sessionId, tracked: false, resources: [], baseline: null }
    const records = await stores.journal.readAll()
    const cwd = typeof baseline.cwd === 'string' ? resolve(baseline.cwd) : null

    const rows = new Map() // key → row
    const rowKey = (kind, id) => `${kind}\u0000${id}`

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

  /**
   * Open one of the session's resources in the OS file manager (the ONLY open
   * method). The path is workspace-relative and MUST resolve inside the
   * session's baseline cwd — the RPC surface never opens arbitrary host paths.
   */
  async function openResource(sessionId, relativePath) {
    if (typeof relativePath !== 'string' || relativePath === '') {
      return { ok: false, error: { code: 'no-path', message: 'a resource path is required' } }
    }
    const baseline = await storesFor(sessionId).baselineStore.load()
    if (baseline === null || typeof baseline.cwd !== 'string') {
      return { ok: false, error: { code: 'untracked', message: 'this session has no resource baseline (legacy or already cleaned)' } }
    }
    if (opener === undefined) {
      return { ok: false, error: { code: 'opener-unavailable', message: 'the platform opener is not available' } }
    }
    const cwd = resolve(baseline.cwd)
    const absolute = resolve(cwd, relativePath)
    // the workspace root itself ('.') is a legitimate open target — everything
    // else must stay strictly inside the workspace
    if (absolute !== cwd && isInsideRoot(absolute, cwd) === false) {
      return { ok: false, error: { code: 'unsafe-path', message: 'the resource path escapes the session workspace' } }
    }
    const info = await stat(absolute).catch(() => null)
    if (info === null) {
      return { ok: false, error: { code: 'resource-missing', message: 'the resource no longer exists on disk' } }
    }
    try {
      await opener.reveal(absolute)
      return { ok: true, value: { sessionId, path: relativePath, mode: 'reveal' } }
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] open ${relativePath} failed: ${error?.message ?? error}`)
      return { ok: false, error: { code: error?.code ?? 'open-failed', message: error?.message ?? 'open-failed' } }
    }
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
    for (const timer of activityTimers.values()) clearTimeout(timer)
    activityTimers.clear()
  }

  /** Startup: resume unfinished cleanups, then baseline every known session. */
  async function bootstrap() {
    if (bootstrapStarted) return { resumed: [], baselined: 0 }
    bootstrapStarted = true
    try {
      const resumed = await resumePending()
      let baselined = 0
      try {
        baselined = await baselineKnownSessions()
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] boot baseline sweep failed: ${error?.message ?? error}`)
      }
      return { resumed, baselined }
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] cleanup resume failed: ${error?.message ?? error}`)
      return { resumed: [], baselined: 0 }
    }
  }

  return {
    ensureBaseline,
    observeEvent,
    observeSessionCreated,
    baselineKnownSessions,
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
    openResource,
    isTracked,
    cancelPendingCleanup,
    dispose,
    trackingRoot,
  }
}
