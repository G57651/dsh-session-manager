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

import { ACTIONS, RESOURCE_TYPES, sha256Hex } from '../types.js'

/**
 * Value envelope for the journal: plaintext for non-secrets (rollback needs
 * the bytes), existence+fingerprint for secrets.
 */
export function envValueEntry(name, value) {
  if (value === undefined) return null // variable absent
  // The plugin never writes the host env and cleanup never restores from
  // these records, so no plaintext value is ever NEEDED — and a value's name
  // is no proof of its innocence (`DATABASE_URL=postgres://user:pw@…`). Every
  // value is therefore stored as existence plus a fingerprint.
  return { redacted: true, hash: sha256Hex(String(value)) }
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

/**
 * Split a shell command into statements on `;`, `&&`, `||` and newlines —
 * OUTSIDE quotes, so `export A="x;y"` stays one statement.
 */
function splitStatements(command) {
  const out = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote !== null) {
      current += char
      if (char === quote && command[index - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === ';') {
      out.push(current)
      current = ''
      continue
    }
    if ((char === '&' && command[index + 1] === '&') || (char === '|' && command[index + 1] === '|')) {
      out.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
  }
  out.push(current)
  return out
}

const EXPORT_PREFIX_RE = /^\s*export\s+/
const EXPORT_BARE_RE = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/
const UNSET_RE = /^\s*unset\s+(?:-v\s+)?(.+)$/
const ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_]*)=('([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'"]*))/g

/**
 * Parse the PERSISTENT env mutations out of one shell command. Only the
 * `export` keyword makes a mutation persistent: a bare `FOO=bar cmd` prefix is
 * scoped to the child process that dies with it, so it is deliberately NOT
 * recorded (recording it would manufacture rollback work for a change that
 * never outlived the command). Multiple assignments on one export line and
 * quoted values containing separators are handled; single quotes keep their
 * content verbatim, double quotes drop one escaping level.
 *
 * @param {string} command
 * @returns {{name: string, kind: 'set'|'unset', rawValue?: string}[]}
 */
export function parseEnvCommand(command) {
  const out = []
  for (const statement of splitStatements(String(command ?? ''))) {
    const trimmed = statement.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const unset = UNSET_RE.exec(trimmed)
    if (unset !== null) {
      for (const name of unset[1].split(/\s+/)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) === true) out.push({ name, kind: 'unset' })
      }
      continue
    }
    if (EXPORT_PREFIX_RE.test(trimmed) === false) continue
    const bare = EXPORT_BARE_RE.exec(trimmed)
    if (bare !== null) {
      // `export NAME` promotes an existing (possibly local) variable; the
      // effective value is whatever the host process already carries
      out.push({ name: bare[1], kind: 'set', rawValue: process.env[bare[1]] ?? '' })
      continue
    }
    const remainder = trimmed.replace(EXPORT_PREFIX_RE, '')
    let sawAssignment = false
    for (const match of remainder.matchAll(ASSIGNMENT_RE)) {
      sawAssignment = true
      const raw = match[3] ?? match[4] ?? match[5] ?? ''
      out.push({ name: match[1], kind: 'set', rawValue: raw })
    }
    if (sawAssignment === false) {
      for (const name of remainder.split(/\s+/)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) === true) {
          out.push({ name, kind: 'set', rawValue: process.env[name] ?? '' })
        }
      }
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
