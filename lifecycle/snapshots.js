// dsh-session-manager — content-addressed snapshot (blob) store.
//
// Rollback needs the CONTENT a resource had before the session touched it;
// the journal itself only carries hashes and references (requirement §五).
// Blobs live under `<tracking>/snapshots/<xx>/<sha256>` and are shared by all
// records with identical content, so repeated saves of an unchanged file cost
// nothing.
//
// Size discipline: a file bigger than `maxFileBytes` is hashed but NOT stored,
// and the journal marks it `oversized` — cleanup then reports
// `snapshot-unavailable` for it instead of pretending to be able to restore.

import { mkdir, writeFile, readFile, stat, rm, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { sha256Hex } from './types.js'

export function createSnapshotStore(rootDir, { maxFileBytes = 8 * 1024 * 1024, logger } = {}) {
  const dirFor = hash => join(rootDir, hash.slice(0, 2), hash)

  return {
    /** @returns {string} absolute path a hash's blob lives at (no I/O). */
    pathFor(hash) {
      return dirFor(String(hash))
    },

    /**
     * Store raw content, deduplicated by hash.
     * @param {string|Buffer} content
     * @returns {Promise<{sha256: string, size: number}>}
     */
    async put(content) {
      const hash = sha256Hex(content)
      const target = dirFor(hash)
      const known = await stat(target).then(info => info.isFile()).catch(() => false)
      if (!known) {
        await mkdir(dirname(target), { recursive: true })
        const tmp = `${target}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await writeFile(tmp, content)
        // rename for atomicity: a crash mid-write leaves a .tmp orphan, never
        // a half-written blob under its real name
        await rename(tmp, target)
      }
      return { sha256: hash, size: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength }
    },

    /**
     * Read a blob back. Returns null when missing — callers treat that as
     * "cannot restore" rather than crashing.
     * @param {string} hash
     * @returns {Promise<Buffer|null>}
     */
    async get(hash) {
      try {
        return await readFile(dirFor(String(hash)))
      } catch {
        return null
      }
    },

    async has(hash) {
      return stat(dirFor(String(hash))).then(info => info.isFile()).catch(() => false)
    },

    /** Storing a file: reads at most maxFileBytes+1 to detect oversize. */
    async putFile(absolutePath) {
      const info = await stat(absolutePath).catch(() => null)
      if (info === null || !info.isFile()) return null
      if (info.size > maxFileBytes) return { oversized: true, size: info.size }
      const content = await readFile(absolutePath)
      const stored = await this.put(content)
      return { ...stored, mode: info.mode }
    },

    /** Only meaningful before the journal is destroyed; part of teardown. */
    async destroyAll() {
      await rm(rootDir, { recursive: true, force: true })
    },

    get limits() {
      return { maxFileBytes }
    },

    logger,
  }
}
