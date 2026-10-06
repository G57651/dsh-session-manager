// dsh-session-manager — tracker registry.
//
// Extension point for future resource kinds (requirement §二): a tracker is
// anything with `{ resourceType, diff?() }` plus the hooks it cares about.
// The manager calls the built-ins by capability, not by name, so a tracker
// set can be swapped wholesale (tests do exactly that).

import { createFileTracker } from './files.js'
import { createDependencyTracker } from './deps.js'
import { createEnvTracker } from './env.js'
import { createDownloadTracker, createProcessTracker } from './observe.js'

/**
 * Build the default tracker set for one session.
 * @param {object} opts
 * @param {string} opts.cwd session workspace
 * @param {Map<string, object>} opts.state last-known path state (shared with manager)
 * @param {string[]} [opts.baselineDirs]
 * @param {Map<string, Map<string, object>>} [opts.baselineDeps]
 * @param {object} opts.snapshotStore
 * @param {object} [opts.scan] file-scan bounds
 * @param {object} [opts.logger]
 */
export function createDefaultTrackers({ cwd, state, baselineDirs = [], sessionStartedAt = 0, baselineDeps, snapshotStore, scan, logger }) {
  return {
    file: createFileTracker({ cwd, state, baselineDirs, sessionStartedAt, snapshotStore, scan, logger }),
    dependency: createDependencyTracker({ cwd, baselineInstalled: baselineDeps, logger }),
    env: createEnvTracker({ logger }),
    download: createDownloadTracker({ logger }),
    process: createProcessTracker({ logger }),
  }
}
