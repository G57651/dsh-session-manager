// dsh-session-manager — 插件内回收站：用户从资源弹窗删除的文件/目录先复制到
// 这里（内容 + 元数据），再移入系统废纸篓。恢复时从本回收站把文件写回原位，
// 并顺手清掉系统废纸篓里的那份副本。
//
// 布局：
//   <rootDir>/index.json        条目索引（会话、原路径、类型、指纹、时间）
//   <rootDir>/<entryId>/meta.json    单条元数据（含 workspaceCwd、trashPath）
//   <rootDir>/<entryId>/payload/…    原文件 / 原目录树
//
// entryId 由本模块生成（`bin_` 前缀 + 安全字符），并做格式与包含性双重校验，
// 拒绝任何形式的路径穿越。恢复到原位时：目标已存在 → 拒绝（绝不覆盖）；
// 恢复后校验 SHA-256；系统废纸篓中已知路径的副本一并移除。

import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { sha256Hex } from './types.js'

const ENTRY_ID_RE = /^bin_[a-z0-9]+_[a-z0-9]+$/

async function pathExists(path) {
  return stat(path).then(() => true).catch(() => false)
}

export function createRecycleBin({ rootDir, logger } = {}) {
  const indexPath = join(rootDir, 'index.json')

  async function loadIndex() {
    try {
      const raw = JSON.parse(await readFile(indexPath, 'utf8'))
      if (Array.isArray(raw?.entries) === true) return raw.entries
      return []
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`[dsh-session-manager] recycle index load failed: ${error?.message ?? error}`)
      }
      return []
    }
  }

  async function saveIndex(entries) {
    await mkdir(rootDir, { recursive: true, mode: 0o700 })
    const tmp = `${indexPath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify({ entries }, null, 1)}\n`, 'utf8')
    await rename(tmp, indexPath)
  }

  function entryDirOf(entryId) {
    if (ENTRY_ID_RE.test(String(entryId)) === false) {
      throw Object.assign(new Error('invalid-entry-id'), { code: 'invalid-entry-id' })
    }
    return join(rootDir, String(entryId))
  }

  return {
    get rootDir() {
      return rootDir
    },

    /**
     * Copy one resource (file or directory) into the bin. The source must
     * still exist — callers do this BEFORE the OS-trash move.
     * @returns {Promise<object>} the index entry as stored
     */
    async put({ sessionId, workspaceCwd, relativePath, trashPath = null }) {
      const source = join(workspaceCwd, relativePath)
      const info = await stat(source).catch(() => null)
      if (info === null) {
        throw Object.assign(new Error('source vanished'), { code: 'resource-missing' })
      }
      const entryId = `bin_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
      const entryDir = entryDirOf(entryId)
      const payloadDir = join(entryDir, 'payload')
      await mkdir(payloadDir, { recursive: true, mode: 0o700 })
      const isDirectory = info.isDirectory() === true
      let sha256 = null
      let size = info.size
      if (isDirectory === true) {
        await cp(source, join(payloadDir, basename(relativePath)), { recursive: true })
      } else {
        const content = await readFile(source)
        sha256 = sha256Hex(content)
        size = content.length
        await writeFile(join(payloadDir, basename(relativePath)), content)
      }
      const entry = {
        entryId,
        sessionId: String(sessionId),
        originalPath: relativePath,
        name: basename(relativePath),
        type: isDirectory === true ? 'directory' : 'file',
        sha256,
        size,
        deletedAt: Date.now(),
        workspaceCwd,
        trashPath,
      }
      await mkdir(entryDir, { recursive: true, mode: 0o700 })
      await writeFile(join(entryDir, 'meta.json'), `${JSON.stringify(entry, null, 1)}\n`, 'utf8')
      const entries = await loadIndex()
      entries.unshift(entry)
      await saveIndex(entries)
      return entry
    },

    /** 回填系统废纸篓路径（rename 策略下路径可知；其他策略为 null）。 */
    async noteTrashPath(entryId, trashPath) {
      if (ENTRY_ID_RE.test(String(entryId)) === false) {
        throw Object.assign(new Error('invalid-entry-id'), { code: 'invalid-entry-id' })
      }
      const entries = await loadIndex()
      const entry = entries.find(candidate => candidate.entryId === entryId)
      if (entry === undefined) return null
      entry.trashPath = typeof trashPath === 'string' && trashPath !== '' ? trashPath : null
      await saveIndex(entries)
      return entry
    },

    /** Entries of the bin, optionally filtered to one session. */
    async list(sessionId = null) {
      const entries = await loadIndex()
      if (sessionId === null) return entries
      return entries.filter(entry => entry.sessionId === String(sessionId))
    },

    /** @returns {Promise<object>} meta of the restored entry. */
    async restore(entryId, { overwrite = false } = {}) {
      if (ENTRY_ID_RE.test(String(entryId)) === false) {
        throw Object.assign(new Error('invalid-entry-id'), { code: 'invalid-entry-id' })
      }
      const entries = await loadIndex()
      const entry = entries.find(candidate => candidate.entryId === entryId)
      if (entry === undefined) {
        throw Object.assign(new Error('entry not found'), { code: 'entry-not-found' })
      }
      const entryDir = entryDirOf(entryId)
      const payloadDir = join(entryDir, 'payload')
      const target = join(entry.workspaceCwd, entry.originalPath)
      if ((await pathExists(target)) === true && overwrite === false) {
        throw Object.assign(new Error('target already exists'), { code: 'target-exists' })
      }
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      if (entry.type === 'directory') {
        await cp(join(payloadDir, entry.name), target, { recursive: true })
      } else {
        const content = await readFile(join(payloadDir, entry.name))
        await writeFile(target, content)
        if (sha256Hex(content) !== entry.sha256) {
          throw Object.assign(new Error('bin content corrupted'), { code: 'bin-corrupted' })
        }
      }
      // 恢复完成：系统废纸篓中已知路径的副本一并移除（未知平台的副本留给用户）
      if (typeof entry.trashPath === 'string' && entry.trashPath !== '') {
        await rm(entry.trashPath, { recursive: true, force: true }).catch(() => {})
      }
      await rm(entryDir, { recursive: true, force: true })
      await saveIndex((await loadIndex()).filter(candidate => candidate.entryId !== entryId))
      return entry
    },

    /** Permanently drop one entry (bin copy + recorded OS-trash path). */
    async purge(entryId) {
      if (ENTRY_ID_RE.test(String(entryId)) === false) {
        throw Object.assign(new Error('invalid-entry-id'), { code: 'invalid-entry-id' })
      }
      const entries = await loadIndex()
      const entry = entries.find(candidate => candidate.entryId === entryId)
      if (entry === undefined) return false
      if (typeof entry.trashPath === 'string' && entry.trashPath !== '') {
        await rm(entry.trashPath, { recursive: true, force: true }).catch(() => {})
      }
      await rm(entryDirOf(entryId), { recursive: true, force: true })
      await saveIndex((await loadIndex()).filter(candidate => candidate.entryId !== entryId))
      return true
    },
  }
}
