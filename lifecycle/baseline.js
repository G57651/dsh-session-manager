// dsh-session-manager — session baseline.
//
// The baseline answers exactly one question for the rest of the system: what
// did the world look like when this session started being watched? Anything
// present here is PREEXISTING — the session may modify it, but cleanup must
// RESTORE, never remove. Anything absent but present later was brought in by
// the session and can be removed.
//
// Resource boundary (requirement §一/§二): the scan is strictly bounded to the
// session's own cwd. No host-wide walk, no `$DSH_HOME` crawling — the plugin
// has no business fingerprinting the user's machine. Hard caps (file count,
// depth, name excludes, per-file snapshot size) keep the cost proportional to
// the workspace rather than the disk.
//
// Files in the baseline also snapshot their content into the shared blob
// store: that content is the ONLY faithful pre-session copy the plugin will
// ever have, and a later modify/delete cannot be rolled back without it.

import { readdir, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, relative, sep, dirname } from 'node:path'
import { LIFECYCLE_VERSION, sha256Hex } from './types.js'

/** Default excludes: dependency stores and VCS/build noise, not user data. */
export const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache',
  '.DS_Store', '.pytest_cache', '.mypy_cache', '.gradle', 'target',
]

/**
 * Walk one directory tree under hard bounds. Returns parallel maps:
 *   files: relative-path → { sha256, size, mode, mtimeMs }
 *   dirs:  sorted deepest-first list of relative directory paths
 * `truncated` reports which bound (if any) cut the walk short.
 *
 * @param {object} opts
 * @param {string} opts.cwd absolute root (pre-resolved)
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxDepth]
 * @param {string[]} [opts.excludes]
 * @param {number} [opts.maxHashBytes] files bigger than this are hashed by
 *   size+mtime only (sha256: null) — they can still be diffed, just not
 *   restored; keeps the walk off a rogue multi-GB artifact
 * @param {(entry: {absolutePath: string, sha256: string, size: number, mode: number}) => Promise<void>} [opts.onFile]
 *   called for every hashed file so the caller can snapshot content inline
 */
export async function scanWorkspace({ cwd, maxFiles = 5000, maxDepth = 12, excludes = DEFAULT_EXCLUDES, maxHashBytes = 64 * 1024 * 1024, onFile }) {
  const excluded = new Set(excludes)
  const files = new Map()
  const dirs = []
  let truncated = false
  let visited = 0

  async function walk(absoluteDir, depth) {
    if (truncated || depth > maxDepth) {
      if (depth > maxDepth) truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch {
      return // unreadable subdir: skip, never fail the whole baseline
    }
    for (const entry of entries) {
      if (truncated) return
      if (excluded.has(entry.name)) continue
      const absolutePath = join(absoluteDir, entry.name)
      const relativePath = relative(cwd, absolutePath).split(sep).join('/')
      if (entry.isDirectory()) {
        dirs.push(relativePath)
        await walk(absolutePath, depth + 1)
        continue
      }
      if (entry.isFile() !== true) continue // sockets/symlinks/fifos are out of scope
      visited += 1
      if (visited > maxFiles) {
        truncated = true
        return
      }
      const info = await stat(absolutePath).catch(() => null)
      if (info === null) continue
      // birthtimeMs is the strongest "did this file exist before the session"
      // signal (mtime moves on every write; birth time does not)
      const record = { sha256: null, size: info.size, mode: info.mode, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs }
      if (info.size <= maxHashBytes) {
        try {
          const content = await readFile(absolutePath)
          record.sha256 = sha256Hex(content)
          if (onFile !== undefined) {
            await onFile({ absolutePath, sha256: record.sha256, size: info.size })
          }
        } catch {
          // unreadable at read time: size/mtime still recorded for diffing
        }
      }
      files.set(relativePath, record)
    }
  }

  await walk(cwd, 0)
  // deepest-first so cleanup can remove children before parents
  dirs.sort((left, right) => right.split('/').length - left.split('/').length || right.localeCompare(left))
  return { files, dirs, truncated }
}

/**
 * Baseline persistence: one baseline.json per session under its tracking dir.
 * Small and rewritten wholesale — it changes once (first sight), so the
 * append-only discipline of the journal is not needed here.
 */
export function createBaselineStore(filePath, snapshotStore, logger) {
  return {
    /**
     * Capture a baseline for `sessionId` rooted at `cwd`, snapshotting file
     * contents. Idempotent: a second call is a no-op — the baseline is the
     * state at FIRST sight by definition, and overwriting it would silently
     * re-attribute session changes as pre-existing.
     * @param {object} [opts.extra] additional fields merged into the stored
     *   document (e.g. the dependency snapshot)
     */
    async capture(sessionId, cwd, opts = {}) {
      const existing = await this.load()
      if (existing !== null) return { baseline: existing, captured: false }
      const { files, dirs, truncated } = await scanWorkspace({
        cwd,
        maxFiles: opts.maxFiles,
        maxDepth: opts.maxDepth,
        excludes: opts.excludes,
        onFile: async ({ absolutePath, sha256 }) => {
          // content snapshot for restore; failure keeps the hash-only entry
          try {
            const stored = await snapshotStore.putFile(absolutePath)
            if (stored?.oversized === true) {
              logger?.info?.(`[dsh-session-manager] baseline snapshot skipped (oversized, ${stored.size} bytes): ${absolutePath}`)
            }
          } catch (error) {
            logger?.warn?.(`[dsh-session-manager] baseline snapshot failed for ${absolutePath}: ${error?.message ?? error}`)
          }
        },
      })
      const baseline = {
        version: LIFECYCLE_VERSION,
        sessionId,
        cwd,
        capturedAt: Date.now(),
        truncated,
        files: Object.fromEntries(files),
        dirs,
        ...(opts.extra !== null && typeof opts.extra === 'object' ? opts.extra : {}),
      }
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      const tmp = `${filePath}.${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, `${JSON.stringify(baseline, null, 1)}\n`, 'utf8')
      await rename(tmp, filePath)
      return { baseline, captured: true }
    },

    /** @returns {Promise<object|null>} */
    async load() {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8'))
        if (raw?.version === LIFECYCLE_VERSION && raw?.sessionId !== undefined) return raw
        logger?.warn?.('[dsh-session-manager] baseline file has an unexpected shape; treating as absent')
        return null
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger?.warn?.(`[dsh-session-manager] baseline load failed: ${error?.message ?? error}`)
        }
        return null
      }
    },
  }
}

/**
 * Baseline state as a Map for the diff engine.
 * @param {object} baseline
 * @returns {Map<string, object>} relative path → entry
 */
export function baselineStateMap(baseline) {
  return new Map(Object.entries(baseline?.files ?? {}))
}

/** Convenience: the basename of a workspace-relative path. */
export function basenameOf(relativePath) {
  const idx = relativePath.lastIndexOf('/')
  return idx >= 0 ? relativePath.slice(idx + 1) : relativePath
}
