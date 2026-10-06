// dsh-session-manager — platform opener: show a path in the OS file manager
// (Finder reveal on macOS, Explorer select on Windows, parent-dir open on
// Linux). This is the ONLY open method by design — no application picker.
//
// Safety posture: spawns go through execFile with ARGV arrays (never a shell
// string); the RPC layer guards that resolved paths sit inside the session's
// workspace before the opener is called.
//
// Test seam: DSH_SM_OPEN_MODE=log records the would-be commands into
// `openLog` instead of spawning — smoke tests assert against it and no
// Finder windows pop on the machine running the tests.

import { execFile } from 'node:child_process'
import { dirname } from 'node:path'

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

/** Route one argv: log mode records it for tests, otherwise spawn. */
async function run(argv) {
  if (logMode() === true) {
    openLog.push(argv)
    return
  }
  await spawn(argv)
}

export function createOpener() {
  const platform = process.platform

  return {
    /** Show the path in the OS file manager (Finder reveal / Explorer select). */
    async reveal(absolutePath) {
      if (platform === 'darwin') return run(['open', '-R', absolutePath])
      if (platform === 'win32') return run(['explorer.exe', `/select,${absolutePath}`])
      return run(['xdg-open', dirname(absolutePath)])
    },
  }
}
