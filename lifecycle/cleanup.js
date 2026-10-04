// dsh-session-manager — Cleanup / Rollback Engine.
//
// Owns two things:
//
// 1. The per-session cleanup state machine, persisted in cleanup.json so a
//    crash, a kill or a reboot leaves a RESUMABLE record instead of a
//    half-deleted world (requirement §八). Every transition is written to disk
//    BEFORE the work it describes starts.
//
// 2. The journal-driven rollback itself. The plan is derived from the change
//    journal plus the baseline — never from a live rescan — because the
//    question is "what did THIS session change", not "what is different from
//    some earlier moment". Every action is state-guarded (idempotent: running
//    cleanup twice lands in the same place, requirement §八/§九) and every
//    restore validates the CURRENT state against what the session last left
//    behind before touching anything: mismatch → CONFLICT, and in safe mode
//    the resource is skipped and reported, never silently overwritten.
//
// The engine does NOT remove the session directory. That belongs to the
// existing delete/purge flow in session-manage.js; the engine only marks
// `session_deleted` (so a crash in between is resumable) and, after the caller
// removed the directory, destroys the journal — the last step of the whole
// lifecycle.

import { stat, writeFile, rename, mkdir, readFile, rm, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import {
  CLEANUP_STATES, RESUMABLE_STATES, LIFECYCLE_VERSION, OWNERSHIP,
  isInsideRoot, sha256Hex,
} from './types.js'

const ROLLBACK_LOCK_STALE_MS = 10 * 60 * 1000

/** Persisted cleanup state for one session. */
export function createCleanupStateStore(filePath, logger) {
  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8'))
        if (raw?.version === LIFECYCLE_VERSION && typeof raw.state === 'string') return raw
        logger?.warn?.('[dsh-session-manager] cleanup state has an unexpected shape; treating as absent')
        return null
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger?.warn?.(`[dsh-session-manager] cleanup state load failed: ${error?.message ?? error}`)
        }
        return null
      }
    },

    async save(state) {
      await mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, `${JSON.stringify(state, null, 1)}\n`, 'utf8')
      await rename(tmp, filePath)
      return state
    },

    async remove() {
      await rm(filePath, { force: true })
    },
  }
}

/**
 * True when a persisted `rolling_back` state belongs to a live, recent
 * process. A dead or stale owner means the lock is abandoned and cleanup must
 * take over (that is exactly the crash-recovery path).
 */
export function lockIsBusy(state, { now = Date.now(), isPidAlive = defaultPidAlive } = {}) {
  if (state?.state !== CLEANUP_STATES.ROLLING_BACK) return false
  const owner = state?.owner
  const startedAt = Number(state?.startedAt)
  if (owner?.pid !== undefined && isPidAlive(Number(owner.pid)) === false) return false
  if (Number.isFinite(startedAt) && now - startedAt > ROLLBACK_LOCK_STALE_MS) return false
  if (owner?.pid === undefined && !Number.isFinite(startedAt)) return false
  return true
}

function defaultPidAlive(pid) {
  try {
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} opts
 * @param {string} opts.trackingDir absolute tracking dir for this session
 * @param {string} opts.sessionId
 * @param {object} opts.stateStore createCleanupStateStore
 * @param {object} opts.journal createChangeJournal
 * @param {object} opts.baselineStore createBaselineStore
 * @param {object} opts.snapshotStore
 * @param {object[]} [opts.depAdapters] dependency manager adapters (id-probed)
 * @param {object} [opts.env] env for environment-variable restore
 * @param {'safe'|'force'} [opts.conflictMode]
 * @param {object} [opts.logger]
 */
export function createCleanupEngine({ trackingDir, sessionId, stateStore, journal, baselineStore, snapshotStore, depAdapters = [], env = process.env, conflictMode = 'safe', logger }) {
  let inFlight = false

  return {
    get isBusy() {
      return inFlight
    },

    /** Current persisted state, or null when the session was never tracked/cleaned. */
    async loadState() {
      return stateStore.load()
    },

    /**
     * Register the cleanup intent. Safe to call repeatedly; keeps an existing
     * resumable state instead of resetting it.
     * @param {'full'|'rollback-only'} mode
     */
    async requestCleanup(mode = 'full') {
      const existing = await stateStore.load()
      if (existing !== null && RESUMABLE_STATES.has(existing.state)) {
        return existing // do not reset a pending cleanup — resume semantics
      }
      return stateStore.save({
        version: LIFECYCLE_VERSION,
        sessionId,
        state: CLEANUP_STATES.DELETE_REQUESTED,
        mode,
        requestedAt: Date.now(),
        attempts: 0,
        results: [],
        conflicts: [],
        failures: [],
      })
    },

    /** Cancel a pending cleanup (session restored / user decision). */
    async cancelPending() {
      const existing = await stateStore.load()
      if (existing === null) return null
      if (RESUMABLE_STATES.has(existing.state) === false) return existing
      return stateStore.save({ ...existing, state: CLEANUP_STATES.ACTIVE, cancelledAt: Date.now() })
    },

    /**
     * Run (or resume) the journal-driven rollback. Idempotent: entries whose
     * desired end state is already reached are no-ops, so re-running after a
     * crash or a manual retry converges instead of damaging anything.
     *
     * @returns {Promise<{ok: boolean, state: string, actions: object[], conflicts: object[], failures: object[]}>}
     */
    async rollback() {
      if (inFlight) {
        return { ok: false, state: CLEANUP_STATES.ROLLING_BACK, actions: [], conflicts: [], failures: [{ phase: 'lock', reason: 'cleanup-already-running' }] }
      }
      inFlight = true
      try {
        const persisted = await stateStore.load()
        if (lockIsBusy(persisted)) {
          return { ok: false, state: persisted.state, actions: [], conflicts: [], failures: [{ phase: 'lock', reason: 'cleanup-owned-by-live-process' }] }
        }
        const mode = persisted?.mode ?? 'full'
        const started = {
          version: LIFECYCLE_VERSION,
          sessionId,
          state: CLEANUP_STATES.ROLLING_BACK,
          mode,
          requestedAt: persisted?.requestedAt ?? Date.now(),
          startedAt: Date.now(),
          attempts: (persisted?.attempts ?? 0) + 1,
          owner: { pid: process.pid, at: Date.now() },
          results: persisted?.results ?? [],
          conflicts: [],
          failures: [],
        }
        await stateStore.save(started)

        const outcome = await runRollback()

        // a conflict that force mode EXECUTED anyway is informational, not
        // blocking — the resource was restored/removed to the pre-session state
        const blockingConflicts = outcome.conflicts.filter(conflict => conflict.executed !== true)
        const finalState = blockingConflicts.length === 0 && outcome.failures.length === 0
          ? CLEANUP_STATES.ROLLBACK_VERIFIED
          : CLEANUP_STATES.ROLLBACK_FAILED
        await stateStore.save({
          ...started,
          state: finalState,
          finishedAt: Date.now(),
          owner: undefined,
          results: outcome.actions,
          conflicts: outcome.conflicts,
          failures: outcome.failures,
        })
        return { ok: finalState === CLEANUP_STATES.ROLLBACK_VERIFIED, state: finalState, ...outcome }
      } finally {
        inFlight = false
      }
    },

    /**
     * Persist that the session directory removal is intended/underway. Called
     * by the removal flow BEFORE it unlinks the directory: a crash after this
     * point resumes into finishing the removal (mode full), not into a
     * rollback the user already saw succeed.
     *
     * A FAILED rollback keeps its state: the journal must survive for retry
     * even though the session directory itself still gets removed — only a
     * verified rollback may advance toward journal destruction.
     */
    async markSessionDeleted() {
      const existing = await stateStore.load()
      const base = existing ?? {
        version: LIFECYCLE_VERSION,
        sessionId,
        mode: 'full',
        requestedAt: Date.now(),
        attempts: 0,
        results: [],
        conflicts: [],
        failures: [],
      }
      const nextState = base.state === CLEANUP_STATES.ROLLBACK_FAILED ? CLEANUP_STATES.ROLLBACK_FAILED : CLEANUP_STATES.SESSION_DELETED
      return stateStore.save({ ...base, state: nextState, sessionDeletedIntent: true, sessionDeletedAt: Date.now() })
    },

    /**
     * Terminal teardown: destroy the journal and the whole tracking directory.
     * Only legal after rollback verified (or nothing needed rolling back) —
     * the journal MUST outlive every cleanup step (requirement §七).
     */
    async finish() {
      const persisted = await stateStore.load()
      if (persisted !== null && persisted.state === CLEANUP_STATES.ROLLBACK_FAILED) {
        throw new Error(`refusing to delete the journal of ${sessionId}: cleanup did not verify`)
      }
      await rm(trackingDir, { recursive: true, force: true })
    },

    /** Summary for the cleanupStatus RPC. */
    async status() {
      const persisted = await stateStore.load()
      return {
        sessionId,
        tracked: persisted !== null || await journal.exists(),
        cleanup: persisted,
      }
    },
  }

  // -------------------------------------------------------------------------

  async function runRollback() {
    const actions = []
    const conflicts = []
    const failures = []

    const baseline = await baselineStore.load()
    const records = await journal.readAll()
    if (baseline === null || typeof baseline.cwd !== 'string') {
      // Legacy/unbaseline'd session: nothing is safely attributable, so the
      // correct rollback is "touch nothing" (requirement §十五).
      actions.push({ phase: 'baseline', outcome: 'skipped', reason: 'no-baseline' })
      return { actions, conflicts, failures }
    }
    const cwd = baseline.cwd
    const rootOk = await stat(cwd).then(info => info.isDirectory()).catch(() => false)
    if (rootOk === false) {
      actions.push({ phase: 'workspace', outcome: 'skipped', reason: 'workspace-missing', cwd })
      // workspace gone → every path resource is gone with it; env/deps of that
      // workspace too. Still process env (host-process scope survives).
      await runEnvPhase(records, actions, conflicts, failures)
      return { actions, conflicts, failures }
    }

    await runDepPhase(cwd, records, baseline, actions, conflicts, failures)
    await runPathPhase(cwd, records, baseline, actions, conflicts, failures)
    await runEnvPhase(records, actions, conflicts, failures)
    runProcessPhase(records, actions)
    await runVerifyPhase(cwd, records, baseline, actions, conflicts, failures)
    return { actions, conflicts, failures }
  }

  // --- dependencies ---------------------------------------------------------

  async function runDepPhase(cwd, records, baseline, actions, conflicts, failures) {
    const depRecords = records.filter(record => record.resourceType === 'dependency' && typeof record.resource?.package === 'string')
    if (depRecords.length === 0) return
    const byKey = new Map()
    for (const record of depRecords) {
      const key = `${record.resource.manager ?? 'node_modules'}\u0000${record.resource.package}`
      if (byKey.has(key) === false) byKey.set(key, [])
      byKey.get(key).push(record)
    }
    for (const [key, touches] of byKey) {
      const [manager, pkg] = key.split('\u0000')
      const adapter = depAdapters.find(candidate => candidate.id === manager)
      const first = touches[0]
      const last = touches[touches.length - 1]
      if (adapter === undefined) {
        failures.push({ phase: 'dependency', package: pkg, manager, reason: 'adapter-missing' })
        continue
      }
      const installedNow = await adapter.list(cwd).then(map => map.has(pkg)).catch(() => false)
      // desired end state: the package only existed because of the session →
      // gone. Pre-existing → must still be there (upgrade rollbacks are
      // reported, not attempted: no offline reinstall).
      if (first.before === null) {
        if (installedNow === false) {
          actions.push({ phase: 'dependency', package: pkg, manager, outcome: 'noop', reason: 'already-removed' })
          continue
        }
        const removed = await adapter.uninstall(cwd, pkg, logger)
        if (removed.ok === true) {
          const stillThere = await adapter.list(cwd).then(map => map.has(pkg)).catch(() => true)
          if (stillThere === false) actions.push({ phase: 'dependency', package: pkg, manager, outcome: 'uninstalled' })
          else failures.push({ phase: 'dependency', package: pkg, manager, reason: 'uninstall-ineffective' })
        } else {
          failures.push({ phase: 'dependency', package: pkg, manager, reason: removed.detail ?? 'uninstall-failed' })
        }
        continue
      }
      // pre-existing package: session upgraded or uninstalled it
      if (installedNow === true) {
        const nowVersion = await adapter.list(cwd).then(map => map.get(pkg)?.version ?? null).catch(() => null)
        if (nowVersion === first.before.version) {
          actions.push({ phase: 'dependency', package: pkg, manager, outcome: 'noop', reason: 'already-at-original-version' })
        } else {
          conflicts.push({
            phase: 'dependency', package: pkg, manager,
            expected: first.before.version, current: nowVersion,
            reason: 'version-restore-unsupported: pre-existing package must keep its pre-session version but automatic downgrade is not attempted',
          })
        }
        continue
      }
      conflicts.push({
        phase: 'dependency', package: pkg, manager,
        expected: first.before.version, current: null,
        reason: 'reinstall-unsupported: pre-existing package is missing but automatic reinstall is not attempted',
      })
    }
  }

  // --- path resources (file / configuration / directory / download) ----------

  function buildPathLedger(records, baseline) {
    const baselineFiles = new Set(Object.keys(baseline.files ?? {}))
    const ledger = new Map() // path → { touches: [], inBaseline, baselineEntry }

    const ledgerFor = (path) => {
      if (ledger.has(path) === false) {
        ledger.set(path, {
          touches: [],
          inBaseline: baselineFiles.has(path),
          baselineEntry: baselineFiles.has(path) ? baseline.files[path] : null,
        })
      }
      return ledger.get(path)
    }

    for (const record of records) {
      const type = record.resourceType
      if (type !== 'file' && type !== 'configuration' && type !== 'download' && type !== 'directory') continue
      const path = record.resource?.path
      if (typeof path !== 'string' || path === '') continue
      if (record.action === 'moved' || record.action === 'renamed') {
        // from-side: the resource left; to-side: it arrived
        ledgerFor(path).touches.push({ record, side: 'from' })
        if (typeof record.resource.to === 'string') {
          ledgerFor(record.resource.to).touches.push({ record, side: 'to' })
        }
        continue
      }
      ledgerFor(path).touches.push({ record, side: 'self' })
    }
    // seq order inside every path's touch list
    for (const entry of ledger.values()) {
      entry.touches.sort((left, right) => (left.record.seq ?? 0) - (right.record.seq ?? 0))
    }
    return ledger
  }

  async function currentEntry(cwd, relativePath) {
    const absolute = join(cwd, relativePath)
    if (isInsideRoot(absolute, cwd) === false) return { exists: false, unsafe: true }
    const info = await stat(absolute).catch(() => null)
    if (info === null) return { exists: false }
    if (info.isDirectory()) return { exists: true, isDirectory: true, sha256: null, size: 0 }
    return { exists: true, isDirectory: false, sha256: null, size: info.size }
  }

  async function hashOf(cwd, relativePath) {
    try {
      return sha256Hex(await readFile(join(cwd, relativePath)))
    } catch {
      return null
    }
  }

  async function runPathPhase(cwd, records, baseline, actions, conflicts, failures) {
    const ledger = buildPathLedger(records, baseline)
    if (ledger.size === 0) return

    const restores = []
    const removes = []
    // force mode (explicit user decision): a detected conflict is recorded and
    // then EXECUTED ANYWAY — the pre-session content wins. Safe mode, the
    // default, records the conflict and leaves the resource untouched.
    const force = conflictMode === 'force'
    const recordConflict = conflict => {
      conflicts.push(force ? { ...conflict, executed: true } : conflict)
      return force
    }

    for (const [path, entry] of ledger) {
      if (path.includes('..')) {
        failures.push({ phase: 'path', path, reason: 'unsafe-path' })
        continue
      }
      const last = entry.touches[entry.touches.length - 1]
      // what the session last left at THIS path: a deleted/moved-away resource
      // leaves the path empty; everything else leaves the record's after-state
      const expectedAfter = (last.side === 'from' || last.record.action === 'deleted') ? null : last.record.after
      const desired = entry.inBaseline ? 'restore' : 'remove'
      const current = await currentEntry(cwd, path)
      if (current.unsafe === true) {
        failures.push({ phase: 'path', path, reason: 'unsafe-path' })
        continue
      }
      // current hash is only worth computing for existing non-directories
      const currentHash = current.exists && current.isDirectory !== true ? await hashOf(cwd, path) : null

      if (desired === 'restore') {
        if (entry.baselineEntry?.sha256 === null || entry.baselineEntry?.sha256 === undefined) {
          failures.push({ phase: 'path', path, reason: 'snapshot-unavailable', detail: 'baseline content was too large to snapshot' })
          continue
        }
        if (current.exists === false) {
          if (expectedAfter === null) {
            restores.push({ path, baselineEntry: entry.baselineEntry, why: 'session-deleted' })
          } else if (recordConflict({ phase: 'path', path, expected: 'present', current: 'missing', reason: 'externally-deleted-after-session' })) {
            restores.push({ path, baselineEntry: entry.baselineEntry, why: 'force-restore' })
          }
          continue
        }
        if (currentHash === entry.baselineEntry.sha256) {
          actions.push({ phase: 'path', path, outcome: 'noop', reason: 'already-restored' })
          continue
        }
        if (expectedAfter === null) {
          if (recordConflict({ phase: 'path', path, expected: 'missing', current: `sha256:${currentHash}`, reason: 'externally-recreated-after-session-delete' })) {
            restores.push({ path, baselineEntry: entry.baselineEntry, why: 'force-restore' })
          }
          continue
        }
        if (expectedAfter?.sha256 !== null && expectedAfter?.sha256 !== undefined && currentHash !== expectedAfter.sha256) {
          if (recordConflict({ phase: 'path', path, expected: `sha256:${expectedAfter.sha256}`, current: `sha256:${currentHash}`, reason: 'externally-modified-after-session' })) {
            restores.push({ path, baselineEntry: entry.baselineEntry, why: 'force-restore' })
          }
          continue
        }
        if (expectedAfter?.sha256 === null || expectedAfter?.sha256 === undefined) {
          // session touched an oversize file; fall back to size agreement
          if (expectedAfter?.size !== current.size && recordConflict({ phase: 'path', path, expected: `size:${expectedAfter?.size}`, current: `size:${current.size}`, reason: 'externally-modified-after-session' })) {
            restores.push({ path, baselineEntry: entry.baselineEntry, why: 'force-restore' })
            continue
          }
          if (expectedAfter?.size !== current.size) continue
        }
        restores.push({ path, baselineEntry: entry.baselineEntry, why: 'session-modified' })
        continue
      }

      // desired === 'remove' (the session brought this path into existence)
      if (current.exists === false) {
        actions.push({ phase: 'path', path, outcome: 'noop', reason: 'already-removed' })
        continue
      }
      const lastAfterHash = expectedAfter?.sha256 ?? null
      if (lastAfterHash !== null && currentHash !== lastAfterHash) {
        if (recordConflict({ phase: 'path', path, expected: `sha256:${lastAfterHash}`, current: `sha256:${currentHash}`, reason: 'externally-modified-after-session' })) {
          removes.push({ path, isDirectory: last.record.resourceType === 'directory' })
        }
        continue
      }
      removes.push({ path, isDirectory: last.record.resourceType === 'directory' })
    }

    // restores first (deleted and modified back to pre-session content),
    // then removals deepest-first so created directories empty out naturally
    restores.sort((left, right) => left.path.split('/').length - right.path.split('/').length)
    removes.sort((left, right) => right.path.split('/').length - left.path.split('/').length)

    for (const task of restores) {
      const outcome = await restoreBaselineContent(cwd, task.path, task.baselineEntry)
      actions.push({ phase: 'path', path: task.path, outcome: outcome.ok ? 'restored' : 'failed', reason: outcome.reason, why: task.why })
      if (outcome.ok !== true) failures.push({ phase: 'path', path: task.path, reason: outcome.reason })
    }
    for (const task of removes) {
      const outcome = await removePath(cwd, task.path, task.isDirectory)
      if (outcome.reason === 'not-empty') {
        // a session-created directory still holding content: conservative
        // skip, reported but not a hard failure
        actions.push({ phase: 'path', path: task.path, outcome: 'skipped', reason: 'not-empty' })
        continue
      }
      actions.push({ phase: 'path', path: task.path, outcome: outcome.ok ? (task.isDirectory ? 'rmdir' : 'removed') : 'failed', reason: outcome.reason })
      if (outcome.ok !== true) failures.push({ phase: 'path', path: task.path, reason: outcome.reason })
    }
  }

  async function restoreBaselineContent(cwd, relativePath, baselineEntry) {
    const content = await snapshotStore.get(baselineEntry.sha256)
    if (content === null) return { ok: false, reason: 'snapshot-missing' }
    const absolute = join(cwd, relativePath)
    if (isInsideRoot(absolute, cwd) === false) return { ok: false, reason: 'unsafe-path' }
    try {
      await mkdir(dirname(absolute), { recursive: true })
      const tmp = `${absolute}.dsm-restore-${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, content)
      await rename(tmp, absolute)
      if (Number.isFinite(baselineEntry.mode)) await chmod(absolute, baselineEntry.mode).catch(() => {})
      const restoredHash = await hashOf(cwd, relativePath)
      if (restoredHash !== baselineEntry.sha256) return { ok: false, reason: 'restore-hash-mismatch' }
      return { ok: true }
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] restore ${relativePath} failed: ${error?.message ?? error}`)
      return { ok: false, reason: error?.code ?? 'restore-failed' }
    }
  }

  async function removePath(cwd, relativePath, isDirectory) {
    const absolute = join(cwd, relativePath)
    if (isInsideRoot(absolute, cwd) === false) return { ok: false, reason: 'unsafe-path' }
    try {
      await rm(absolute, { recursive: false, force: false })
      return { ok: true }
    } catch (error) {
      // an empty dir removes fine; one still holding foreign content refuses
      // with ENOTEMPTY — that is the conservative outcome we want for
      // session-created directories
      if (isDirectory && error?.code === 'ENOTEMPTY') return { ok: true, reason: 'not-empty' }
      logger?.warn?.(`[dsh-session-manager] remove ${relativePath} failed: ${error?.message ?? error}`)
      return { ok: false, reason: error?.code ?? 'remove-failed' }
    }
  }

  // --- environment -----------------------------------------------------------

  /**
   * Value fingerprint comparable across redacted and plain envelopes: both
   * reduce to the SHA-256 of the underlying value, so "is the env still what
   * the session last left" is answerable even for secrets whose plaintext the
   * journal never carried.
   */
  function envValueFingerprint(entry) {
    if (entry === null) return null
    return entry.redacted === true ? entry.hash : sha256Hex(String(entry.value))
  }

  function runEnvPhase(records, actions, conflicts, failures) {
    const envRecords = records.filter(record => record.resourceType === 'environment_variable' && typeof record.resource?.name === 'string')
    if (envRecords.length === 0) return
    const byName = new Map()
    for (const record of envRecords) {
      const name = record.resource.name
      if (byName.has(name) === false) byName.set(name, [])
      byName.get(name).push(record)
    }
    for (const [name, touches] of byName) {
      const first = touches[0]
      const last = touches[touches.length - 1]
      const desiredAbsent = first.before === null
      const currentFingerprint = name in env ? sha256Hex(String(env[name])) : null
      const expectedFingerprint = envValueFingerprint(last.after)
      const originalFingerprint = envValueFingerprint(first.before)

      if (desiredAbsent) {
        if (currentFingerprint === null) {
          actions.push({ phase: 'env', name, outcome: 'noop', reason: 'already-absent' })
          continue
        }
        // unset needs no value knowledge — safe even for secrets
        delete env[name]
        actions.push({ phase: 'env', name, outcome: 'unset' })
        continue
      }
      // desired: the pre-session value. Secret → plaintext unknowable, but
      // the fingerprint still tells "already back to the original" apart
      // from "someone changed it after the session".
      if (currentFingerprint === originalFingerprint) {
        actions.push({ phase: 'env', name, outcome: 'noop', reason: 'already-at-original-value' })
        continue
      }
      if (first.before.redacted === true) {
        conflicts.push({ phase: 'env', name, expected: `fingerprint:${originalFingerprint}`, current: `fingerprint:${currentFingerprint}`, reason: 'secret-unrecoverable: the pre-session value was redacted and cannot be written back' })
        continue
      }
      if (expectedFingerprint !== null && currentFingerprint !== null && currentFingerprint !== expectedFingerprint) {
        conflicts.push({ phase: 'env', name, expected: `fingerprint:${expectedFingerprint}`, current: `fingerprint:${currentFingerprint}`, reason: 'externally-modified-after-session' })
        continue
      }
      env[name] = first.before.value
      actions.push({ phase: 'env', name, outcome: 'restored' })
    }
  }

  // --- final verification (requirement §七 step 11) ---------------------------
  //
  // Independent re-check of the end state, after the action phases ran: every
  // restored path must hash to its baseline content, every removed path must
  // be gone. Adds verify rows to the report; a mismatch here is a hard failure
  // so the state lands on rollback_failed and the journal survives for retry.

  async function runVerifyPhase(cwd, records, baseline, actions, conflicts, failures) {
    const ledger = buildPathLedger(records, baseline)
    for (const [path, entry] of ledger) {
      if (entry.inBaseline === true) {
        if (entry.baselineEntry?.sha256 === null || entry.baselineEntry?.sha256 === undefined) continue
        const currentHash = await hashOf(cwd, path)
        if (currentHash === entry.baselineEntry.sha256) {
          actions.push({ phase: 'verify', path, outcome: 'verified', reason: 'matches-baseline' })
        } else {
          actions.push({ phase: 'verify', path, outcome: 'unverified', reason: 'hash-mismatch', current: currentHash })
          failures.push({ phase: 'verify', path, reason: 'restore-not-verified' })
        }
        continue
      }
      const current = await currentEntry(cwd, path)
      if (current.exists === false) {
        actions.push({ phase: 'verify', path, outcome: 'verified', reason: 'absent' })
      } else {
        actions.push({ phase: 'verify', path, outcome: 'unverified', reason: 'still-present' })
        failures.push({ phase: 'verify', path, reason: 'session-created-resource-still-present' })
      }
    }
  }

  // --- processes --------------------------------------------------------------

  function runProcessPhase(records, actions) {
    const processRecords = records.filter(record => record.resourceType === 'process')
    for (const record of processRecords) {
      actions.push({
        phase: 'process',
        command: record.resource?.command,
        outcome: 'skipped',
        reason: 'delegated: live session processes are stopped by the host activity stop; long-lived leftovers are reported here',
      })
    }
  }
}
