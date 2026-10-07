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
import { encodeSegment, decodeSegment } from '../session-manage.js'
import {
  ACTIONS, OWNERSHIP, RESOURCE_TYPES, CLEANUP_STATES, RESUMABLE_STATES,
  makeChangeRecord, isInsideRoot, sha256Hex, isConfigurationName,
} from './types.js'
import { createChangeJournal, replayPathRecords } from './journal.js'
import { createSnapshotStore } from './snapshots.js'
import { createBaselineStore, baselineStateMap, DEFAULT_EXCLUDES, basenameOf } from './baseline.js'
import { createCleanupEngine, createCleanupStateStore, lockIsBusy } from './cleanup.js'
import { createDefaultTrackers } from './trackers/index.js'
import { createRecycleBin } from './recycle.js'
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
function deriveOwnership(change, { inBaseline }) {
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
    default: {
      // file / configuration / directory / download
      if (change.action === ACTIONS.CREATED || change.action === ACTIONS.DOWNLOADED) return OWNERSHIP.SESSION_CREATED
      if (change.action === ACTIONS.DELETED) return OWNERSHIP.SESSION_DELETED
      const configured = change.resourceType === RESOURCE_TYPES.CONFIGURATION
      // adopted pre-existing file (baseline never captured it): it predates the
      // session, so a modification is a modify — never a creation
      if (change.before?.unbaselined === true) return configured ? OWNERSHIP.SESSION_CONFIGURED : OWNERSHIP.SESSION_MODIFIED
      if (inBaseline) return configured ? OWNERSHIP.SESSION_CONFIGURED : OWNERSHIP.SESSION_MODIFIED
      // absent from the baseline and not adopted → this session created it;
      // a later edit of the session's own file is still a creation, not a
      // modification of pre-existing content
      return OWNERSHIP.SESSION_CREATED
    }
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
export function createSessionResourceManager({ dshHome, ctx, manifest, opener, trash, getConfig, logger }) {
  void logger
  const recycle = createRecycleBin({ rootDir: join(dshHome, 'dsh-session-manager', 'recycle'), logger })
  const trackingRoot = join(dshHome, 'dsh-session-manager', 'tracking')
  const runtimes = new Map() // sessionId → runtime
  const baselineJobs = new Map() // sessionId → in-flight capture promise
  const diffTimers = new Map() // sessionId → timer
  const diffJobs = new Map() // sessionId → in-flight diff promise (dedupe concurrent passes)
  const removalJobs = new Set() // sessionIds whose prepareRemoval is in flight
  let disposed = false // set on unload: in-flight work must stop writing
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
      excludes: Array.isArray(config.trackingExclude) && config.trackingExclude.length > 0
        ? [...new Set([...DEFAULT_EXCLUDES, ...config.trackingExclude])] // ADD to the defaults, never replace them
        : DEFAULT_EXCLUDES,
    }
  }

  function snapshotLimit() {
    return clampNumber(getConfig().trackingMaxSnapshotBytes, 4096, 512 * 1024 * 1024, 8 * 1024 * 1024)
  }

  function conflictMode() {
    return getConfig().conflictMode === 'force' ? 'force' : 'safe'
  }

  const dirFor = sessionId => join(trackingRoot, encodeSegment(String(sessionId)))

  /** Stores rooted at a KNOWN tracking directory (already-encoded — never re-encode). */
  function storesAtDirectory(dir) {
    const snapshotStore = createSnapshotStore(join(dir, 'snapshots'), { maxFileBytes: snapshotLimit(), logger })
    return {
      dir,
      snapshotStore,
      baselineStore: createBaselineStore(join(dir, 'baseline.json'), snapshotStore, logger),
      journal: createChangeJournal(join(dir, 'changes.jsonl'), logger),
      stateStore: createCleanupStateStore(join(dir, 'cleanup.json'), logger),
    }
  }

  function storesFor(sessionId) {
    return storesAtDirectory(dirFor(sessionId))
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

  /** Drop a pending debounced activity flush (called before journal destruction). */
  function cancelActivityFlush(sessionId) {
    const timer = activityTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      activityTimers.delete(sessionId)
    }
  }

  /** Record session activity: in-memory immediately, disk debounced. */
  function noteActivity(sessionId) {
    const now = Date.now()
    lastSeenAt.set(sessionId, now)
    if (activityTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      activityTimers.delete(sessionId)
      void (async () => {
        // the debounced flush can land AFTER a delete destroyed the tracking
        // dir; writing would mkdir it back into existence (observed on a real
        // host). A session in the trash never gets its dir resurrected.
        if (manifest !== undefined && await manifest.has?.(sessionId) === true) return
        await mkdir(dirFor(sessionId), { recursive: true, mode: 0o700 })
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
    // A DELETED session (trash entry, purged or not) must not be re-baselined:
    // the host keeps listing it in the stale in-memory corpus until a restart,
    // and the boot sweep / list self-heal would otherwise resurrect the very
    // tracking dir the delete just destroyed (observed on a real host). A
    // restored session leaves the trash and becomes trackable again.
    if (manifest !== undefined && await manifest.has?.(sessionId) === true) return null
    // A session with a pending cleanup is being torn down — baselining it now
    // would race the resume and resurrect a tracking dir mid-rollback.
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
      sessionStartedAt: Number(baseline.capturedAt) || 0,
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
    if (disposed === true) return null // an unloaded instance must not write
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
    if (typeof sessionId !== 'string' || sessionId === '') return
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
      // persistent env mutations from shell syntax are RECORDED ONLY. A tool's
      // child shell dies with its environment, so applying the parsed value to
      // the host process (the old behaviour) would let a session command
      // mutate the harness's own env (PATH / NODE_OPTIONS / ...) for every
      // later spawn. Restore against the host env stays a no-op by design.
      for (const mutation of parseEnvCommand(command)) {
        const change = runtime.trackers.env.classify(mutation)
        if (change !== null) await record(runtime, change)
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
  function diffSession(sessionId, { recordMetadata } = {}) {
    // concurrent passes over the same session would double-journal every
    // change they interleave on (debounce + explicit track + list self-heal +
    // the removal-time final diff are all live callers) — share one pass
    const existing = diffJobs.get(sessionId)
    if (existing !== undefined) return existing
    const job = runDiff(sessionId, { recordMetadata }).finally(() => {
      diffJobs.delete(sessionId)
    })
    diffJobs.set(sessionId, job)
    return job
  }

  async function runDiff(sessionId, { recordMetadata } = {}) {
    if (enabled() === false || disposed === true) return { journaled: 0, tracked: false }
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
  async function prepareRemoval(sessionId, options = {}) {
    if (removalJobs.has(sessionId) === true) {
      return { ok: false, state: null, actions: [], conflicts: [], failures: [{ phase: 'lock', reason: 'removal-in-flight' }] }
    }
    removalJobs.add(sessionId)
    try {
      return await prepareRemovalInner(sessionId, options)
    } finally {
      removalJobs.delete(sessionId)
    }
  }

  async function prepareRemovalInner(sessionId, { mode = 'full', explicit = false } = {}) {
    // autoCleanup gates the AUTOMATIC (delete/purge) path only; an explicit
    // cleanup RPC is a user decision and must not be silently skipped by it
    if (enabled() === false || (explicit !== true && getConfig().autoCleanup === false)) {
      return { ok: true, skipped: 'tracking-disabled', state: null, actions: [], conflicts: [], failures: [] }
    }
    if ((await hasAnyTracking(sessionId)) === false) {
      return { ok: true, skipped: 'legacy-untracked', state: null, actions: [], conflicts: [], failures: [] }
    }
    const engine = createEngine(sessionId, storesFor(sessionId))
    // the cleanup intent lands BEFORE the final diff: a crash inside the diff
    // leaves a resumable record instead of a deleted-looking session with
    // intact data and no cleanup state (requirement §七 step 1 "Lock")
    await engine.requestCleanup(mode)
    let finalDiff = 'ran'
    let idleMs = null
    try {
      idleMs = Date.now() - (await lastSeenOf(sessionId))
      await diffSession(sessionId, { recordMetadata: { finalDiff: true, idleMs } })
    } catch (error) {
      finalDiff = 'failed'
      logger?.warn?.(`[dsh-session-manager] final diff ${sessionId} failed: ${error?.message ?? error}`)
    }
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
    cancelActivityFlush(sessionId)
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
      // entry.name is the tracking DIRECTORY name (already encoded): address it
      // directly — passing it through storesFor would encode it a second time
      // and silently miss the very files this pass exists to read
      const stores = storesAtDirectory(join(trackingRoot, entry.name))
      const state = await stores.stateStore.load()
      if (state === null || RESUMABLE_STATES.has(state.state) === false) continue
      if (lockIsBusy(state)) {
        logger?.info?.(`[dsh-session-manager] cleanup for ${entry.name} is owned by a live process; skipping`)
        continue
      }
      // the tracking dir name IS encodeSegment(rawId) — the canonical source.
      // Trusting cleanup.json's sessionId instead survives a crash only once:
      // a previous rollback re-encodes it, and the second resume double-encodes
      // the lookup into a silent "dir not found" (audited bug).
      const decodedSessionId = decodeSegment(entry.name)
      const engine = createEngine(decodedSessionId, stores)
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
          await beforeSessionDirRemoval(decodedSessionId)
          const removed = await removeSessionDirForResume(decodedSessionId)
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
        await beforeSessionDirRemoval(decodedSessionId)
        const removed = await removeSessionDirForResume(decodedSessionId)
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
      // last record wins: a user-initiated trash is a different thing from an
      // agent deletion, and the view must keep the two apart
      row.trashed = record.action === ACTIONS.DELETED && record.metadata?.trashed === true
      if (row.trashed === true) row.binEntryId = record.metadata?.entryId ?? null
      else delete row.binEntryId
      rows.set(key, row)
      if (typeof record.resource.to === 'string' && record.resource.to !== '') {
        // moved/renamed: surface the destination as its own row — MERGE when
        // the destination already has records, or its history would be lost
        const toKey = rowKey('path', record.resource.to)
        const existingTo = rows.get(toKey)
        rows.set(toKey, {
          resourceType: record.resourceType,
          identifier: record.resource.to,
          ownership: record.ownership,
          actions: [...(existingTo?.actions ?? []), `${record.action} (from ${path})`],
          baseline: existingTo?.baseline ?? null,
          lastTimestamp: record.timestamp,
        })
      }
    }

    // current status per row kind
    for (const row of rows.values()) {
      if (PATH_RESOURCE_TYPES.has(row.resourceType)) {
        const current = await pathStatus(cwd, row)
        // a user-trashed path only reads as trashed while it is really off
        // disk: restoring it (from the bin, or by hand) revives the row
        row.status = row.trashed === true && current === 'missing' ? 'trashed' : current
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

  /**
   * Move session resources to the OS wastebasket (user-initiated deletion —
   * recoverable). Every path is workspace-relative and must resolve inside
   * the session's baseline cwd; the OS trash API does the rest.
   */
  async function deleteResources(sessionId, paths) {
    const list = Array.isArray(paths) ? paths.filter(path => typeof path === 'string' && path !== '') : []
    if (list.length === 0) {
      return { results: [] }
    }
    if (trash === undefined) {
      return list.map(path => ({ path, ok: false, error: { code: 'trash-unavailable', message: 'the OS wastebasket integration is not available' } }))
    }
    const baseline = await storesFor(sessionId).baselineStore.load()
    if (baseline === null || typeof baseline.cwd !== 'string') {
      return list.map(path => ({ path, ok: false, error: { code: 'untracked', message: 'this session has no resource baseline (legacy or already cleaned)' } }))
    }
    const cwd = resolve(baseline.cwd)
    const runtime = await runtimeFor(sessionId)
    const results = []
    for (const relativePath of list) {
      const absolute = resolve(cwd, relativePath)
      // the workspace root itself is not deletable through this surface
      if (absolute === cwd || isInsideRoot(absolute, cwd) === false) {
        results.push({ path: relativePath, ok: false, error: { code: 'unsafe-path', message: 'the resource path escapes the session workspace' } })
        continue
      }
      const info = await stat(absolute).catch(() => null)
      if (info === null) {
        results.push({ path: relativePath, ok: false, error: { code: 'resource-missing', message: 'the resource no longer exists on disk' } })
        continue
      }
      try {
        // 双写：先复制进插件内回收站（内容+元数据），再移入系统废纸篓。
        // 复制失败 → 不动文件，逐条报错。
        const entry = await recycle.put({ sessionId, workspaceCwd: cwd, relativePath, trashPath: null })
        const trashed = await trash.moveToTrash(absolute)
        await recycle.noteTrashPath(entry.entryId, trashed.trashPath ?? null).catch(() => {})
        if (runtime !== null) await noteUserTrash(runtime, relativePath, entry, trashed)
        results.push({ path: relativePath, ok: true, via: trashed.via, entryId: entry.entryId })
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] trash ${relativePath} failed: ${error?.message ?? error}`)
        results.push({ path: relativePath, ok: false, error: { code: error?.code ?? 'trash-failed', message: error?.message ?? 'trash-failed' } })
      }
    }
    return { results }
  }

  /**
   * Record a user-initiated trash in the journal and drop the path from the
   * live tracker. Both halves matter: the record is what makes the resource
   * view stop presenting the path as an ordinary resource (and what keeps
   * session cleanup from resurrecting something the user deliberately
   * removed), while forgetting it in the tracker stops the next diff from
   * journaling the same removal a second time as an agent deletion.
   */
  async function noteUserTrash(runtime, relativePath, entry, trashed) {
    runtime.trackers.file.forget?.(relativePath)
    await record(runtime, {
      resourceType: isConfigurationName(basenameOf(relativePath)) ? RESOURCE_TYPES.CONFIGURATION : RESOURCE_TYPES.FILE,
      action: ACTIONS.DELETED,
      resource: { path: relativePath },
      before: null,
      after: null,
      metadata: { trashed: true, entryId: entry.entryId, via: trashed?.via ?? null },
    }).catch(() => {})
  }

  /** 插件内回收站条目（可选按会话过滤）。 */
  async function recycleList(sessionId = null) {
    return recycle.list(sessionId)
  }

  /** 从插件内回收站还原到原位，并移除系统废纸篓中的已知副本。 */
  async function recycleRestore(entryId) {
    return recycle.restore(entryId)
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
      return prepareRemoval(sessionId, { mode: 'rollback-only', explicit: true })
    }
    if (mode === 'full') {
      const prepared = await prepareRemoval(sessionId, { mode: 'full', explicit: true })
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
    if (state.state === CLEANUP_STATES.ROLLBACK_FAILED || state.state === CLEANUP_STATES.DELETE_REQUESTED || state.state === CLEANUP_STATES.ROLLING_BACK) {
      // an unfinished rollback (failed, or a crash between requestCleanup and
      // rollback) must RUN before the teardown may destroy the journal
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

  /**
   * One sweep pass for poll deployments: diff every session the host corpus
   * knows about. Domain logic lives here, not in the RPC glue.
   */
  async function sweepKnownSessions() {
    const query = ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') return
    try {
      const records = await query.listSessions()
      for (const record of records ?? []) {
        const id = String(record?.header?.id ?? '')
        if (id === '') continue
        await diffSession(id).catch(() => {})
      }
    } catch { /* sweep is best-effort by definition */ }
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

  /** Debounce timers teardown (plugin unload). In-flight work is told to stop
   * via `disposed`, so an HMR remount cannot leave two writers on one journal. */
  function dispose() {
    disposed = true
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
    diffSession,
    prepareRemoval,
    beforeSessionDirRemoval,
    afterSessionDirRemoved,
    bootstrap,
    getChanges,
    getResources,
    getCleanupStatus,
    cleanupSession,
    openResource,
    deleteResources,
    recycleList,
    recycleRestore,
    sweepKnownSessions,
    isTracked,
    cancelPendingCleanup,
    dispose,
  }
}
