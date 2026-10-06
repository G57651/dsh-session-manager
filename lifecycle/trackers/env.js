// dsh-session-manager — EnvTracker and observation trackers.
//
// env.js holds two complementary pieces:
//
// 1. EnvTracker — records persistent environment-variable changes with
//    before/after/scope. The only env a host-side plugin can observe and
//    restore is ITS OWN PROCESS env (`scope: 'host-process'`); changes inside
//    a tool's child shell die with the child. The tracker applies that honest
//    scope everywhere: it records what a parsed `export`/`unset` command
//    intended, captures the host-process value as `before`, and cleanup
//    reverses against the same env.
//
// 2. Redaction — the security half. A secret-looking variable NEVER carries a
//    plaintext value into the journal (requirement §十四): secrets store name,
//    existence and a SHA-256 fingerprint (equality checkable, not reversible).
//    Cleanup of a redacted modification is reported as skipped
//    ('secret-unrecoverable') rather than pretending to restore what it
//    cannot read back.

import { ACTIONS, RESOURCE_TYPES, isSecretName, sha256Hex, isPlainValue } from '../types.js'

/**
 * Value envelope for the journal: plaintext for non-secrets (rollback needs
 * the bytes), existence+fingerprint for secrets.
 */
export function envValueEntry(name, value) {
  if (value === undefined) return null // variable absent
  if (!isPlainValue(value)) return { redacted: true, hash: sha256Hex(String(value)), type: typeof value }
  if (isSecretName(name)) return { redacted: true, hash: sha256Hex(String(value)) }
  return { redacted: false, value: String(value) }
}

/**
 * Variables that steer the HARNESS PROCESS itself (spawn resolution, loader
 * hooks, shell startup). Tracking them buys nothing — the child shell's value
 * never reached the host — and any accidental write-back would be a real
 * hazard, so they are excluded outright.
 */
const EXCLUDED_ENV_NAMES = new Set([
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_FRAMEWORK_PATH',
  'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'IFS', 'BASH_ENV', 'ENV',
  'PROMPT_COMMAND', 'CDPATH', 'GLOBIGNORE', 'DSH_HOME',
])

const EXPORT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=((?:'[^']*')|(?:"[^"]*")|[^\s#]*)/
const EXPORT_BARE_RE = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|$|=)/
const UNSET_RE = /^\s*unset\s+(?:-v\s+)?([A-Za-z_][A-Za-z0-9_]*)/

function unquote(raw) {
  if (raw === undefined || raw === '') return ''
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1)
  }
  return raw
}

/**
 * Parse the persistent env mutations out of one shell command. Only
 * `export NAME=...`, bare `export NAME` and `unset NAME` persist past the
 * command — `NAME=x cmd` prefix assignments are scoped to the child and are
 * deliberately NOT recorded (recording them would manufacture rollback work
 * for changes that never outlived the command).
 *
 * @param {string} command
 * @returns {{name: string, kind: 'set'|'unset', rawValue?: string}[]}
 */
export function parseEnvCommand(command) {
  const out = []
  for (const line of String(command ?? '').split(/\n|&&|\|\||;/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const unset = UNSET_RE.exec(trimmed)
    if (unset !== null) {
      out.push({ name: unset[1], kind: 'unset' })
      continue
    }
    const assigned = EXPORT_RE.exec(trimmed)
    if (assigned !== null) {
      out.push({ name: assigned[1], kind: 'set', rawValue: unquote(assigned[2]) })
      continue
    }
    const bare = EXPORT_BARE_RE.exec(trimmed)
    if (bare !== null) {
      // `export NAME` promotes an existing (possibly local) variable; the
      // effective value is whatever the host process already carries
      out.push({ name: bare[1], kind: 'set', rawValue: process.env[bare[1]] ?? '' })
    }
  }
  return out
}

/**
 * @param {object} opts
 * @param {object} [opts.env] env source; defaults to process.env (the honest
 *   scope: 'host-process')
 * @param {object} [opts.logger]
 */
export function createEnvTracker({ env = process.env } = {}) {
  return {
    resourceType: RESOURCE_TYPES.ENVIRONMENT_VARIABLE,

    /**
     * Classify one parsed mutation into a journal-ready change (or null when
     * it is a no-op). Ownership is stamped by the manager.
     *
     * @param {{name: string, kind: 'set'|'unset', rawValue?: string}} mutation
     */
    classify(mutation) {
      const name = String(mutation.name)
      if (EXCLUDED_ENV_NAMES.has(name) === true) return null
      const before = envValueEntry(name, env[name])
      if (mutation.kind === 'unset') {
        if (before === null) return null // nothing to unset
        return {
          resourceType: RESOURCE_TYPES.ENVIRONMENT_VARIABLE,
          action: ACTIONS.UNSET,
          resource: { name, scope: 'host-process' },
          before,
          after: null,
        }
      }
      const after = envValueEntry(name, mutation.rawValue)
      if (before !== null && after !== null && before.redacted === after.redacted && before.hash === after.hash && before.value === after.value) {
        return null // assigning the value it already has
      }
      return {
        resourceType: RESOURCE_TYPES.ENVIRONMENT_VARIABLE,
        action: ACTIONS.SET,
        resource: { name, scope: 'host-process' },
        before,
        after,
      }
    },

  }
}
