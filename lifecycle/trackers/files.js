// dsh-session-manager — FileTracker: the workspace diff engine.
//
// Unlike the other trackers this one owns the source of truth for "what does
// the workspace look like now": it rescans the session cwd (bounded, same
// rules as the baseline) and classifies every difference against the
// last-known state. Detection is intentionally diff-based, not watcher-based
// (requirement §六): a watcher sees writes, but a diff also sees deletions,
// moves, permission changes and anything a subprocess did behind the plugin's
// back. The cost is one bounded rescan per diff, which the caps keep cheap.
//
// The tracker never journalling anything itself — it yields classified changes
// to the caller (SessionResourceManager), which stamps ownership against the
// baseline and appends. Ownership is deliberately NOT decided here: only the
// manager knows the baseline, and "was it in the baseline" is the whole
// question.

import { join, relative, sep, dirname as pathDirname } from 'node:path'
import { scanWorkspace, basenameOf } from '../baseline.js'
import { ACTIONS, RESOURCE_TYPES, isConfigurationName } from '../types.js'

/**
 * @param {object} opts
 * @param {string} opts.cwd absolute workspace root for this session
 * @param {Map<string, object>} opts.state last-known path → entry map
 *   (relative '/'-separated paths). MUTATED as changes are classified, so a
 *   follow-up diff against the same tracker instance stays incremental.
 * @param {string[]} [opts.baselineDirs] directory paths present at baseline;
 *   first known-dir set, so a fresh session does not journal the world
 * @param {object} opts.snapshotStore content-addressed blob store (before-content checks)
 * @param {object} [opts.scan] scan bounds override ({maxFiles, maxDepth, excludes})
 * @param {object} [opts.logger]
 */
export function createFileTracker({ cwd, state, baselineDirs = [], sessionStartedAt = 0, snapshotStore, scan = {}, logger }) {
  let knownDirs = new Set(baselineDirs)

  function typeFor(path) {
    return isConfigurationName(basenameOf(path)) ? RESOURCE_TYPES.CONFIGURATION : RESOURCE_TYPES.FILE
  }

  return {
    /** Type this tracker reports for its own changes (files and kin). */
    resourceType: RESOURCE_TYPES.FILE,

    /**
     * One diff pass over the workspace. Returns classified changes WITHOUT
     * ownership stamps (the manager owns that judgement). The tracker's state
     * map is updated in place — the next diff compares against what this pass
     * saw, which is what makes repeated diffs cheap and correct.
     */
    async diff() {
      const { files, dirs } = await scanWorkspace({ cwd, ...scan, onFile: async () => {} })
      const changes = []

      // --- changed / removed, against last-known -----------------------------
      // An adopted pre-existing entry (unbaselined) keeps its provenance on
      // every state refresh: the flag is what stops a later modify/delete of
      // that path from ever being treated as a session-owned resource.
      const refresh = (known, now) => (known.unbaselined === true ? { ...now, unbaselined: true } : now)
      const removed = []
      for (const [path, known] of state) {
        const now = files.get(path)
        if (now === undefined) {
          removed.push({ path, known })
          state.delete(path)
          continue
        }
        const hashComparable = now.sha256 !== null && known.sha256 !== null
        const contentChanged = hashComparable ? now.sha256 !== known.sha256 : now.size !== known.size || now.mtimeMs !== known.mtimeMs
        const modeChanged = now.mode !== known.mode
        if (contentChanged) {
          changes.push({
            resourceType: typeFor(path),
            action: ACTIONS.MODIFIED,
            resource: { path },
            before: await beforeSnapshotFor(known),
            after: { ...now },
          })
          state.set(path, refresh(known, now))
        } else if (hashComparable && modeChanged) {
          // content identical, permissions differ: its own, cheap-to-restore action
          changes.push({
            resourceType: typeFor(path),
            action: ACTIONS.PERMISSION_CHANGED,
            resource: { path },
            before: { mode: known.mode },
            after: { ...now },
          })
          state.set(path, refresh(known, now))
        } else {
          // untouched; refresh mtime so future diffs stay cheap
          state.set(path, refresh(known, now))
        }
      }

      // --- created, with move/rename pairing ---------------------------------
      const created = []
      for (const [path, now] of files) {
        if (state.has(path)) continue
        if (predatesSession(now, sessionStartedAt)) {
          // existed before the session but the baseline never captured it:
          // adopt silently as pre-existing (no journal record, no cleanup
          // target). `unbaselined` rides on the state entry so any later
          // modify/delete keeps that provenance in its `before` side.
          state.set(path, { ...now, unbaselined: true })
          continue
        }
        created.push({ path, now })
        state.set(path, now)
      }
      const removedToCreated = new Map() // removed item → created item it pairs with
      for (const item of removed) {
        if (item.known.sha256 === null || item.known.sha256 === undefined) continue
        const match = created.find(candidate => candidate.now.sha256 === item.known.sha256 && ![...removedToCreated.values()].includes(candidate))
        if (match !== undefined) removedToCreated.set(item, match)
      }

      for (const item of removed) {
        const match = removedToCreated.get(item)
        if (match !== undefined) {
          const renamed = basenameOf(item.path) === basenameOf(match.path)
          changes.push({
            resourceType: typeFor(match.path),
            action: renamed ? ACTIONS.RENAMED : ACTIONS.MOVED,
            resource: { path: item.path, to: match.path },
            before: await beforeSnapshotFor(item.known),
            after: { ...match.now },
          })
        } else {
          changes.push({
            resourceType: typeFor(item.path),
            action: ACTIONS.DELETED,
            resource: { path: item.path },
            before: await beforeSnapshotFor(item.known),
            after: null,
          })
        }
      }
      for (const item of created) {
        if ([...removedToCreated.values()].includes(item)) continue
        changes.push({
          resourceType: typeFor(item.path),
          action: ACTIONS.CREATED,
          resource: { path: item.path },
          before: null,
          after: { ...item.now },
        })
      }

      // --- directories --------------------------------------------------------
      // New directories are journalled individually (not deduped against new
      // descendants): cleanup removes them deepest-first with a plain rmdir,
      // which refuses to delete a directory that still holds pre-existing or
      // foreign content — the conservative failure mode we want.
      for (const dirPath of dirs) {
        if (knownDirs.has(dirPath)) continue
        knownDirs.add(dirPath)
        changes.push({
          resourceType: RESOURCE_TYPES.DIRECTORY,
          action: ACTIONS.CREATED,
          resource: { path: dirPath },
          before: null,
          after: { path: dirPath },
        })
      }

      return changes
    },

    /**
     * Register a directory the cleanup engine just (re)created, so the next
     * diff does not re-journal it as session-created.
     */
    noteDir(dirRelativePath) {
      knownDirs.add(String(dirRelativePath))
    },

    /** Current known dir set (for the resources view). */
    knownDirList() {
      return [...knownDirs]
    },
  }

  /**
   * Snapshot bookkeeping for before-content: the content a resource had
   * before the change is already gone by diff time, so the only faithful
   * copy is whatever the baseline/previous snapshot stored under the known
   * hash. Absent → snapshotUnavailable, and cleanup will report it.
   */
  async function beforeSnapshotFor(known) {
    if (known?.sha256 === null || known?.sha256 === undefined) {
      return { ...known, snapshot: null, snapshotUnavailable: true }
    }
    const present = await snapshotStore.has(known.sha256)
    return { ...known, snapshot: present ? known.sha256 : null, snapshotUnavailable: !present }
  }
}

/** Timestamp slack absorbing same-millisecond captures and coarse FS granularity. */
const PREEXISTING_SLACK_MS = 1000

/**
 * True when a file's timestamps prove it existed before the session started.
 * birthtime is authoritative (session writes move mtime but never birth time);
 * mtime is the fallback for filesystems that do not report a birth time.
 * A path that PREDATES the session yet is missing from the baseline means the
 * baseline never captured it (truncated scan / unreadable dir) — such a file
 * must be adopted as pre-existing, never journalled as a session creation and
 * never removed by cleanup.
 */
export function predatesSession(entry, sessionStartedAt) {
  if (Number.isFinite(sessionStartedAt) === false || sessionStartedAt <= 0) return false
  const birth = Number(entry?.birthtimeMs)
  if (Number.isFinite(birth) && birth > 0) return birth < sessionStartedAt - PREEXISTING_SLACK_MS
  const mtime = Number(entry?.mtimeMs)
  return Number.isFinite(mtime) && mtime > 0 && mtime < sessionStartedAt - PREEXISTING_SLACK_MS
}

/** Probe whether an absolute path exists. */
export async function pathExists(absolutePath) {
  const { stat } = await import('node:fs/promises')
  return stat(absolutePath).then(() => true).catch(() => false)
}

/** Workspace-relative path of an absolute path under cwd (null when outside). */
export function relativeTo(cwd, absolutePath) {
  const rel = relative(cwd, absolutePath)
  if (rel === '' || rel.startsWith('..')) return null
  return rel.split(sep).join('/')
}

/** Absolute path of a workspace-relative path (no existence check). */
export function absoluteIn(cwd, relativePath) {
  return join(cwd, String(relativePath).split('/').join(sep))
}

/** Parent relative dir of a workspace-relative path ('' for top level). */
export function parentDirOf(relativePath) {
  return pathDirname(String(relativePath))
}
