// dsh-session-manager — platform opener: reveal a path in the OS file manager
// or open it with a user-selected application, plus the installed-application
// scan that feeds the client's app dropdown.
//
// Safety posture:
//   - spawns go through execFile with ARGV arrays (never a user-built shell
//     string); the one Windows exception (`start` is a cmd builtin) validates
//     every argument against shell metacharacters first;
//   - the RPC layer guards that resolved paths sit inside the session's
//     workspace before the opener is called;
//   - the application list is scan-fed (no free-text input from the wire).
//
// Test seam: DSH_SM_OPEN_MODE=log records the would-be commands into
// `openLog` instead of spawning — smoke tests assert against it and no
// Finder windows pop on the machine running the tests.

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** Commands the opener would have run; populated in log mode (tests). */
export const openLog = []

function logMode() {
  return process.env.DSH_SM_OPEN_MODE === 'log'
}

/** Run argv without a shell; resolves on spawn success regardless of exit
 * code (explorer.exe famously exits 1 even when it opens fine). */
function spawn(argv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const [file, ...args] = argv
    execFile(file, args, error => {
      if (error !== null && error.code === 'ENOENT') rejectPromise(Object.assign(new Error(`opener-not-found: ${file}`), { code: 'opener-not-found' }))
      else resolvePromise()
    })
  })
}

const SHELL_UNSAFE = /["&|<>^%!]/
function assertShellSafe(value) {
  if (SHELL_UNSAFE.test(value) === true) {
    throw Object.assign(new Error('unsupported-char-in-path'), { code: 'unsupported-char-in-path' })
  }
}

/** Route one argv: log mode records it for tests, otherwise spawn. */
async function run(argv) {
  if (logMode() === true) {
    openLog.push(argv)
    return
  }
  await spawn(argv)
}

export function createOpener({ logger } = {}) {
  const platform = process.platform
  const home = homedir()
  let appCache = { at: 0, applications: [], paths: new Map() }
  const APP_CACHE_TTL = 60 * 1000

  async function scanApplications() {
    const applications = []
    const paths = new Map()
    const push = (name, path) => {
      if (name !== '' && applications.includes(name) === false) {
        applications.push(name)
        paths.set(name, path)
      }
    }
    if (platform === 'darwin') {
      for (const root of ['/Applications', '/System/Applications', join(home, 'Applications')]) {
        let entries = []
        try {
          entries = await readdir(root, { withFileTypes: true })
        } catch {
          continue // root missing on this machine
        }
        for (const entry of entries) {
          if (entry.isDirectory() === true && entry.name.endsWith('.app') === true) {
            push(entry.name.slice(0, -'.app'.length), join(root, entry.name))
          }
        }
      }
    } else if (platform === 'win32') {
      const roots = [
        join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        join(process.env.AppData ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      ]
      const walk = async dir => {
        let entries = []
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else if (entry.name.toLowerCase().endsWith('.lnk')) push(entry.name.slice(0, -'.lnk'.length), full)
        }
      }
      for (const root of roots) await walk(root)
    } else {
      for (const root of ['/usr/share/applications', join(home, '.local', 'share', 'applications')]) {
        let entries = []
        try {
          entries = await readdir(root, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry.isFile() !== true || entry.name.endsWith('.desktop') === false) continue
          const id = entry.name.slice(0, -'.desktop'.length)
          let name = id
          try {
            const text = await readFile(join(root, entry.name), 'utf8')
            const named = /^\s*Name(?:\[en_US\])?=([^\n]+)/m.exec(text)
            if (named !== null && named[1].trim() !== '') name = named[1].trim()
          } catch {
            // keep the id-derived name
          }
          push(name, id)
        }
      }
    }
    applications.sort((left, right) => left.localeCompare(right))
    return { applications, paths }
  }

  return {
    get platform() {
      return platform
    },

    /** Show the path in the OS file manager (Finder reveal / Explorer select). */
    async reveal(absolutePath) {
      if (platform === 'darwin') return run(['open', '-R', absolutePath])
      if (platform === 'win32') {
        assertShellSafe(absolutePath)
        return run(['explorer.exe', `/select,${absolutePath}`])
      }
      return run(['xdg-open', dirname(absolutePath)])
    },

    /**
     * Open the path with the named application (from listApplications).
     * darwin: `open -a <app-path-or-name> <file>`; win32: `start <lnk> <file>`
     * through cmd (arguments validated); linux: `gtk-launch <id> <file>`.
     */
    async openWith(app, absolutePath) {
      const name = String(app)
      if (name === '') return this.reveal(absolutePath)
      const path = appCache.paths.get(name)
      if (platform === 'darwin') {
        return run(['open', '-a', path ?? name, absolutePath])
      }
      if (platform === 'win32') {
        const lnk = path ?? name
        assertShellSafe(lnk)
        assertShellSafe(absolutePath)
        // `start` is a cmd builtin — the one place a shell is unavoidable;
        // every argument is metacharacter-checked above and empty-titled
        return run(['cmd.exe', '/c', 'start', '', lnk, absolutePath])
      }
      return run(['gtk-launch', path ?? name, absolutePath])
    },

    /** Installed applications for the client's dropdown, scan-cached for 60s. */
    async listApplications({ refresh = false } = {}) {
      const now = Date.now()
      if (refresh === false && now - appCache.at < APP_CACHE_TTL && appCache.applications.length > 0) {
        return { platform, applications: appCache.applications }
      }
      try {
        const { applications, paths } = await scanApplications()
        appCache = { at: now, applications, paths }
      } catch (error) {
        logger?.warn?.(`[dsh-session-manager] application scan failed: ${error?.message ?? error}`)
      }
      return { platform, applications: appCache.applications }
    },

    /** Testing / diagnostics: drop the scan cache. */
    invalidateAppCache() {
      appCache = { at: 0, applications: [], paths: new Map() }
    },

    logger,
  }
}
