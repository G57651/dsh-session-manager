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

import { mkdir, readFile, appendFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

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
    const records = await readAll()
    const last = records[records.length - 1]
    return Number.isFinite(last?.seq) ? last.seq + 1 : 0
  }

  return {
    /**
     * Append one record with an assigned sequence number. The record object is
     * NOT mutated with the seq/id the caller computed — the journal stamps
     * them itself so seq allocation stays single-sourced.
     * @param {object} record partial record from makeChangeRecord (without seq)
     * @returns {Promise<object>} the record as written, with `seq` set
     */
    async append(record) {
      const seq = await nextSeq()
      const stamped = { ...record, seq }
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify(stamped)}\n`, 'utf8')
      return stamped
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

    /**
     * Physical removal. Only the CleanupEngine may call this, and only after
     * the rollback verified — deleting the journal is the LAST step of the
     * whole lifecycle (requirement §七 step 14). The caller removes the whole
     * tracking directory afterwards; this unlinks the file itself so a
     * partially-removed directory still reports "no journal" on resume.
     */
    async destroy() {
      try {
        await unlink(filePath)
      } catch (error) {
        if (error?.code === 'ENOENT') return
        logger?.warn?.(`[dsh-session-manager] journal destroy failed: ${error?.message ?? error}`)
        throw error
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
