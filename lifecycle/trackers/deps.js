// dsh-session-manager — DependencyTracker with pluggable manager adapters.
//
// The tracker itself knows NOTHING about npm or pip (requirement §三): it
// compares the installed-set reported by the registered adapters against the
// baseline snapshot of that same set, and yields install/uninstall/upgrade
// changes. A new package manager is one adapter object away:
//
//   {
//     id: 'pip-site-packages',
//     /** returns null when the manager has no footprint in cwd */
//     probe(cwd) -> boolean,
//     /** name → {version?, source} for every installed package visible here */
//     list(cwd) -> Promise<Map<string, object>>,
//     /** reverse one install; must be idempotent and path-safe */
//     uninstall(cwd, name, logger) -> Promise<{ok: boolean, detail?: string}>
//   }
//
// The shipped adapter covers node_modules (npm / pnpm / yarn — their shared
// on-disk layout is the observable truth; which client wrote it does not
// matter for cleanup). package.json / lockfile edits are journalled separately
// by the FileTracker as configuration changes, so uninstalling a
// session-installed package here plus restoring package.json there reverses
// the whole `npm install` without spawning npm at cleanup time — deterministic,
// offline-safe and idempotent.

import { readdir, stat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIONS, RESOURCE_TYPES } from '../types.js'

/** node_modules adapter: scans top-level and @scope packages. */
export const nodeModulesAdapter = {
  id: 'node_modules',

  async probe(cwd) {
    return stat(join(cwd, 'node_modules')).then(info => info.isDirectory()).catch(() => false)
  },

  async list(cwd) {
    const root = join(cwd, 'node_modules')
    const installed = new Map()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return installed
    }
    for (const entry of entries) {
      // pnpm links packages into node_modules as symlinks (and @scope dirs are
      // real dirs) — both are installed packages
      if (entry.isDirectory() !== true && entry.isSymbolicLink() !== true) continue
      if (entry.name.startsWith('.')) continue // .bin, .cache, .pnpm store links
      if (entry.name.startsWith('@')) {
        let scoped
        try {
          scoped = await readdir(join(root, entry.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of scoped) {
          if (child.isDirectory() !== true && child.isSymbolicLink() !== true) continue
          const name = `${entry.name}/${child.name}`
          installed.set(name, { version: await versionOf(join(root, entry.name, child.name)) })
        }
        continue
      }
      installed.set(entry.name, { version: await versionOf(join(root, entry.name)) })
    }
    return installed
  },

  /**
   * Reverse one install by removing the package directory. Deliberately not
   * `npm uninstall`: cleanup must not depend on the network, on npm being
   * installed, or on a healthy registry — removing the directory is the
   * idempotent, path-safe core of what uninstall does, and the manifest
   * files are restored by the file-level rollback.
   */
  async uninstall(cwd, name, logger) {
    const target = join(cwd, 'node_modules', ...name.split('/'))
    // the adapter only ever receives names it listed, but the guard keeps a
    // hostile name from escaping node_modules regardless
    if (!target.startsWith(join(cwd, 'node_modules') + '/')) {
      return { ok: false, detail: 'unsafe-path' }
    }
    try {
      await rm(target, { recursive: true, force: true })
      return { ok: true }
    } catch (error) {
      logger?.warn?.(`[dsh-session-manager] dep uninstall ${name} failed: ${error?.message ?? error}`)
      return { ok: false, detail: error?.code ?? 'uninstall-failed' }
    }
  },
}

async function versionOf(packageDir) {
  try {
    const raw = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    return typeof raw?.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

/**
 * @param {object} opts
 * @param {string} opts.cwd session workspace
 * @param {object[]} [opts.adapters] defaults to [nodeModulesAdapter]
 * @param {Map<string, object>} [opts.baselineInstalled] adapter id → (name → info)
 *   captured at baseline; absent entries mean "nothing was installed"
 * @param {object} [opts.logger]
 */
export function createDependencyTracker({ cwd, adapters = [nodeModulesAdapter], baselineInstalled = new Map(), logger }) {
  const lastKnown = new Map() // adapter id → Map(name → info)
  for (const adapter of adapters) {
    lastKnown.set(adapter.id, new Map(baselineInstalled.get(adapter.id) ?? []))
  }

  return {
    resourceType: RESOURCE_TYPES.DEPENDENCY,
    adapters,

    /**
     * Diff every probed adapter's installed set against last-known. Yields
     * changes WITHOUT ownership stamps (manager stamps against baseline).
     */
    async diff() {
      const changes = []
      for (const adapter of adapters) {
        if (await adapter.probe(cwd).catch(() => false) !== true) continue
        let now
        try {
          now = await adapter.list(cwd)
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] dep list (${adapter.id}) failed: ${error?.message ?? error}`)
          continue
        }
        const known = lastKnown.get(adapter.id)
        for (const [name, info] of now) {
          const before = known.get(name)
          if (before === undefined) {
            changes.push({
              resourceType: RESOURCE_TYPES.DEPENDENCY,
              action: ACTIONS.INSTALLED,
              resource: { package: name, manager: adapter.id },
              before: null,
              after: { ...info, scope: cwd },
            })
            known.set(name, info)
          } else if (before.version !== info.version && before.version !== null && info.version !== null) {
            changes.push({
              resourceType: RESOURCE_TYPES.DEPENDENCY,
              action: ACTIONS.UPGRADED,
              resource: { package: name, manager: adapter.id },
              before: { ...before, scope: cwd },
              after: { ...info, scope: cwd },
            })
            known.set(name, info)
          } else {
            known.set(name, info)
          }
        }
        for (const [name, info] of known) {
          if (now.has(name)) continue
          changes.push({
            resourceType: RESOURCE_TYPES.DEPENDENCY,
            action: ACTIONS.UNINSTALLED,
            resource: { package: name, manager: adapter.id },
            before: { ...info, scope: cwd },
            after: null,
          })
          known.delete(name)
        }
      }
      return changes
    },

    /**
     * Snapshot the installed set for a fresh baseline.
     * @returns {Promise<Map<string, Map<string, object>>>} adapter id → (name → info)
     */
    async snapshot() {
      const snapshot = new Map()
      for (const adapter of adapters) {
        if (await adapter.probe(cwd).catch(() => false) !== true) continue
        try {
          snapshot.set(adapter.id, await adapter.list(cwd))
        } catch (error) {
          logger?.warn?.(`[dsh-session-manager] dep snapshot (${adapter.id}) failed: ${error?.message ?? error}`)
        }
      }
      return snapshot
    },
  }
}

/** Serialize a dep snapshot into baseline-friendly JSON. */
export function serializeDepSnapshot(snapshot) {
  return Object.fromEntries([...snapshot].map(([id, map]) => [id, Object.fromEntries(map)]))
}

/** Rebuild a dep snapshot map from baseline JSON. */
export function deserializeDepSnapshot(raw) {
  const out = new Map()
  for (const [id, entries] of Object.entries(raw ?? {})) {
    out.set(id, new Map(Object.entries(entries ?? {})))
  }
  return out
}
