// dsh-session-manager — append-only change journal (JSONL) per session.
//
// The journal is the durable record of everything a session did. It is
// append-only on purpose (requirement §十): a crashed process leaves the lines
// it managed to flush intact, and cleanup must never truncate or rewrite the
// file — the whole tracking directory disappears only after cleanup verified.
//
// One line per change, JSON, in recording order. `seq` is assigned by the
// journal (0-based per file) so replay order is unambiguous even when two
// changes share a millisecond timestamp.

import { mkdir, readFile, appendFile, stat, open } from 'node:fs/promises'
import { dirname } from 'node:path'

// seq allocation used to re-read and re-parse the WHOLE journal on every single
// append (read-modify-write over a growing file = O(n²) per session, ~2.5 s for
// 2000 records and several times that for a full-trash of a large directory).
// The cache is keyed by file path and shared by every instance created for that
// path, because storesAtDirectory() builds a fresh journal per call and a
// per-instance cache would hand out duplicate seqs. `size` is the last observed
// file size: a smaller file means the journal was destroyed (cleanup) or
// replaced, so the base is re-read once.
const seqState = new Map() // filePath → { lastSeq, size }

export function createChangeJournal(filePath, logger) {
  /**
   * Read every record, oldest first. Tolerates a torn trailing line (a crash
   * between the bytes hitting the page cache and the newline) by skipping it —
   * losing half a line is acceptable, losing the file is not.
   */
  async function readAll() {
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      logger?.warn?.(`[dsh-session-manager] journal read failed: ${error?.message ?? error}`)
      return []
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object') records.push(parsed)
      } catch {
        // torn trailing write; keep everything before it
      }
    }
    return records
  }

  async function nextSeq() {
    const info = await stat(filePath).catch(() => null)
    const size = info?.isFile() === true ? info.size : 0
    const cached = seqState.get(filePath)
    if (cached === undefined || size < cached.size) {
      const records = await readAll()
      const last = records[records.length - 1]
      const base = Number.isFinite(last?.seq) ? last.seq : -1
      seqState.set(filePath, { lastSeq: base + 1, size })
      return base + 1
    }
    cached.lastSeq += 1
    cached.size = size
    return cached.lastSeq
  }

  /**
   * True when the file does not end in a newline — i.e. a previous write was
   * torn. Appending onto that fragment would concatenate two JSON objects into
   * one unparsable line, losing the NEW record as well.
   */
  async function needsLineBreak() {
    let handle
    try {
      handle = await open(filePath, 'r')
      const info = await handle.stat()
      if (info.size === 0) return false
      const buffer = Buffer.alloc(1)
      await handle.read(buffer, 0, 1, info.size - 1)
      return buffer[0] !== 0x0a
    } catch {
      return false // ENOENT etc. — a fresh file needs no break
    } finally {
      await handle?.close()
    }
  }

  // Appends are serialized through one chain: seq allocation is a
  // read-modify-write, and concurrent callers (env/process records racing the
  // debounced diff and the removal-time final diff) all got seq 0 before this.
  let appendQueue = Promise.resolve()

  async function doAppend(record) {
    const seq = await nextSeq()
    const stamped = { ...record, seq }
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const prefix = (await needsLineBreak()) === true ? '\n' : ''
    await appendFile(filePath, `${prefix}${JSON.stringify(stamped)}\n`, 'utf8')
    return stamped
  }

  return {
    /**
     * Append one record with an assigned sequence number. The record object is
     * NOT mutated with the seq/id the caller computed — the journal stamps
     * them itself so seq allocation stays single-sourced.
     * @param {object} record partial record from makeChangeRecord (without seq)
     * @returns {Promise<object>} the record as written, with `seq` set
     */
    append(record) {
      const run = appendQueue.then(() => doAppend(record))
      // a failed append must not poison the queue for every later caller
      appendQueue = run.then(() => {}, () => {})
      return run
    },

    readAll,

    /**
     * @returns {Promise<boolean>} true when the journal file exists (even if empty)
     */
    async exists() {
      try {
        const info = await stat(filePath)
        return info.isFile()
      } catch {
        return false
      }
    },
  }
}

/**
 * Rebuild the last-known workspace file state by replaying a journal on top of
 * a baseline state map. Used after a process restart, when the in-memory state
 * is gone but diffing must still classify ownership correctly.
 *
 * Only path-shaped records participate (file / directory / configuration /
 * download): env and dependency records are keyed differently and are handled
 * by their own trackers.
 *
 * @param {Map<string, object>} state mutable path → file-entry map (baseline)
 * @param {object[]} records journal records, oldest first
 */
export function replayPathRecords(state, records) {
  for (const record of records) {
    const type = record?.resourceType
    if (type !== 'file' && type !== 'directory' && type !== 'configuration' && type !== 'download') continue
    const path = record?.resource?.path
    if (typeof path !== 'string' || path === '') continue
    if (record.action === 'deleted') {
      state.delete(path)
    } else if (record.action === 'moved' || record.action === 'renamed') {
      // A move journals resource.path = from and resource.to = destination.
      state.delete(path)
      const target = record.resource.to
      if (typeof target === 'string' && target !== '' && record.after) state.set(target, record.after)
    } else if (record.action === 'permission_changed') {
      const existing = state.get(path)
      if (existing) state.set(path, { ...existing, mode: record.after?.mode })
    } else {
      // created / modified / downloaded: the `after` side is the new last-known state.
      if (record.after) state.set(path, record.after)
    }
  }
}
