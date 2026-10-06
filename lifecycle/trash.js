// dsh-session-manager — OS wastebasket: move a file or directory to the
// platform trash (macOS 废纸篓, Windows 回收站, Linux XDG trash) instead of
// destroying it. User-initiated deletions from the resource modal land here,
// so a mistake is always recoverable.
//
// Platform strategy:
//   darwin  — rename into ~/.Trash (same volume), duplicate-name resolution;
//             cross-volume (iCloud workspaces) falls back to Finder delete via
//             osascript, which handles iCloud and per-volume trashes.
//   win32   — PowerShell Shell.Application Namespace(10).MoveHere (the
//             Recycle Bin COM API); arguments single-quote escaped.
//   linux   — `gio trash` when available, else the XDG trash spec implemented
//             directly (Trash/files + Trash/info/*.trashinfo).
//
// Test seams: DSH_SM_TRASH_DIR redirects the trash directory (the smoke
// suites never touch the real 废纸篓); DSH_SM_OPEN_MODE=log records the
// would-be commands into `openLog`.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { openLog } from './opener.js'

const DATE_STAMP = () => new Date().toISOString().replace(/[:.]/g, '-')

function logMode() {
  return process.env.DSH_SM_OPEN_MODE === 'log'
}

function trashDirOverride() {
  const value = process.env.DSH_SM_TRASH_DIR
  return typeof value === 'string' && value !== '' ? value : null
}

/** Run argv without a shell; resolves regardless of exit code (explorer.exe
 * and friends report odd codes on success). */
function spawn(argv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const [file, ...args] = argv
    execFile(file, args, error => {
      if (error !== null && error.code === 'ENOENT') rejectPromise(Object.assign(new Error(`helper-not-found: ${file}`), { code: 'helper-not-found' }))
      else resolvePromise()
    })
  })
}

async function run(argv) {
  if (logMode() === true) {
    openLog.push(argv)
    return
  }
  await spawn(argv)
}

/** First free `base`, `base 2`, `base 3`… inside `dir`. */
async function dedupName(dir, base) {
  const exists = async path => stat(path).then(() => true).catch(() => false)
  let candidate = join(dir, base)
  let suffix = 1
  while ((await exists(candidate)) === true) {
    suffix += 1
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    candidate = join(dir, `${stem} ${suffix}${ext}`)
    if (suffix > 9999) {
      candidate = join(dir, `${base}.${DATE_STAMP()}`)
      break
    }
  }
  return candidate
}

export function createTrash({ logger } = {}) {
  const platform = process.platform

  /** The trash directory: DSH_SM_TRASH_DIR overrides (tests / ops). */
  function userTrashDir() {
    return trashDirOverride() ?? join(homedir(), '.Trash')
  }

  return {
    get platform() {
      return platform
    },

    /**
     * Move `absolutePath` into the platform wastebasket. Resolves with
     * `{ via, trashPath? }`; throws (with a `code`) when every strategy
     * fails — the file then stays in place and the caller reports it.
     */
    async moveToTrash(absolutePath) {
      const source = String(absolutePath)
      if (platform === 'darwin') return this.moveToTrashDarwin(source)
      if (platform === 'win32') return this.moveToTrashWin32(source)
      return this.moveToTrashLinux(source)
    },

    async moveToTrashDarwin(source) {
      const trashDir = userTrashDir()
      await mkdir(trashDir, { recursive: true })
      const target = await dedupName(trashDir, basename(source))
      try {
        await rename(source, target)
        if (logMode() === true) openLog.push(['trash', source, target])
        return { via: 'rename', trashPath: target }
      } catch (error) {
        // cross-volume (iCloud workspaces!) cannot rename into ~/.Trash —
        // let Finder delete it, which handles every volume and puts it in
        // that volume's own wastebasket
        if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') throw error
      }
      const script = `tell application "Finder" to delete POSIX file ${appleScriptString(source)}`
      await run(['osascript', '-e', script])
      if (logMode() === true) openLog.push(['osascript-finder-delete', source])
      return { via: 'finder' }
    },

    async moveToTrashWin32(source) {
      assertShellSafe(source)
      const script = [
        '$shell = New-Object -ComObject Shell.Application;',
        '$bin = $shell.Namespace(10);',
        `$bin.MoveHere('${source.replace(/'/g, "''")}')`,
      ].join(' ')
      await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script])
      if (logMode() === true) openLog.push(['recycle-bin', source])
      return { via: 'recycle-bin' }
    },

    async moveToTrashLinux(source) {
      try {
        await run(['gio', 'trash', source])
        if (logMode() === true) openLog.push(['gio-trash', source])
        return { via: 'gio' }
      } catch (error) {
        if (error?.code !== 'helper-not-found') throw error
      }
      // XDG trash spec implemented directly: Trash/files + Trash/info
      const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
      const filesDir = join(dataHome, 'Trash', 'files')
      const infoDir = join(dataHome, 'Trash', 'info')
      await mkdir(filesDir, { recursive: true })
      await mkdir(infoDir, { recursive: true })
      const target = await dedupName(filesDir, basename(source))
      await rename(source, target)
      const info = `[Trash Info]\nPath=${pathToFileURL(source).href}\nDeletionDate=${new Date().toISOString().slice(0, 19)}Z\n`
      await writeFile(join(infoDir, `${basename(target)}.trashinfo`), info, 'utf8')
      if (logMode() === true) openLog.push(['xdg-trash', source, target])
      return { via: 'xdg', trashPath: target }
    },

    logger,
  }
}

/** AppleScript string literal: backslashes and quotes escaped. */
function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function assertShellSafe(value) {
  if (/["&|<>^%!]/.test(String(value)) === true) {
    throw Object.assign(new Error('unsupported-char-in-path'), { code: 'unsupported-char-in-path' })
  }
}

// mkdtemp/tmpdir/readdir remain available for future dedup strategies; they
// are intentionally unused today. Remove this stub if it bothers you.
void mkdtemp
void tmpdir
void readdir
