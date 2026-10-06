// dsh-session-manager — shared vocabulary for the resource lifecycle model.
//
// The lifecycle model upgrades the plugin from "manage the Session row" to
// "manage what the Session DID": every resource a session creates, modifies,
// deletes, installs or configures is journalled while the session runs, and
// reversed when the session is removed.
//
// This module holds only constants and small pure helpers with no I/O so every
// other lifecycle module (and the tests) can share one vocabulary.

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** version of the on-disk lifecycle files (baseline.json / cleanup.json). */
export const LIFECYCLE_VERSION = 1

/**
 * Resource types a session can touch. FileTracker classifies paths into
 * `file` / `directory` / `configuration`; the other trackers own their type.
 * The registry is open: a future tracker (git, docker, port, ...) adds its own
 * type without touching the core.
 */
export const RESOURCE_TYPES = {
  FILE: 'file',
  DIRECTORY: 'directory',
  DOWNLOAD: 'download',
  ENVIRONMENT_VARIABLE: 'environment_variable',
  DEPENDENCY: 'dependency',
  CONFIGURATION: 'configuration',
  PROCESS: 'process',
}

/**
 * Journal actions. The requirement's CREATE/MODIFY/DELETE/INSTALL/UNINSTALL/
 * SET/UNSET/DOWNLOAD/MOVE/RENAME vocabulary, in the past tense the journal
 * stores. `permission_changed` and `upgraded` are refinements of modify;
 * `spawned` is the only process action.
 */
export const ACTIONS = {
  CREATED: 'created',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  MOVED: 'moved',
  RENAMED: 'renamed',
  PERMISSION_CHANGED: 'permission_changed',
  DOWNLOADED: 'downloaded',
  INSTALLED: 'installed',
  UNINSTALLED: 'uninstalled',
  UPGRADED: 'upgraded',
  SET: 'set',
  UNSET: 'unset',
  SPAWNED: 'spawned',
}

/**
 * Ownership — was the resource brought into existence by this session, or did
 * the session merely touch something that predated it? Computed once at
 * journal time against the last-known workspace state and frozen into the
 * record, because it can only be judged reliably at change time.
 *
 * cleanup semantics per ownership:
 *   session_created     → remove
 *   session_modified    → restore `before` snapshot
 *   session_deleted     → restore the deleted resource from its snapshot
 *   session_installed   → uninstall
 *   session_configured  → restore `before` snapshot (it is a modify of a
 *                         well-known configuration file)
 *   preexisting         → never journaled as a change; baseline entries only
 */
export const OWNERSHIP = {
  SESSION_CREATED: 'session_created',
  SESSION_MODIFIED: 'session_modified',
  SESSION_DELETED: 'session_deleted',
  SESSION_INSTALLED: 'session_installed',
  SESSION_CONFIGURED: 'session_configured',
  PREEXISTING: 'preexisting',
}

/**
 * Cleanup state machine (persisted in cleanup.json). Non-terminal states are
 * exactly the ones a crashed process must be able to resume:
 *
 *   active            tracking, nothing requested
 *   delete_requested  a removal asked for cleanup, not started yet
 *   rolling_back      journal-driven rollback in progress
 *   rollback_failed   finished with failures/conflicts; journal kept for retry
 *   rollback_verified rollback done and clean (terminal for rollback-only)
 *   session_deleted   rollback done, session dir removal intended/underway
 *                     (full mode); crash here resumes into finishing removal
 *   complete          everything done; full mode then deletes the journal
 */
export const CLEANUP_STATES = {
  ACTIVE: 'active',
  DELETE_REQUESTED: 'delete_requested',
  ROLLING_BACK: 'rolling_back',
  ROLLBACK_FAILED: 'rollback_failed',
  ROLLBACK_VERIFIED: 'rollback_verified',
  SESSION_DELETED: 'session_deleted',
  COMPLETE: 'complete',
}

/** States that still owe work to a resume pass, keyed by what they owe. */
export const RESUMABLE_STATES = new Set([
  CLEANUP_STATES.DELETE_REQUESTED,
  CLEANUP_STATES.ROLLING_BACK,
  CLEANUP_STATES.ROLLBACK_FAILED,
  CLEANUP_STATES.ROLLBACK_VERIFIED,
  CLEANUP_STATES.SESSION_DELETED,
])

/**
 * File name is the identifier for path-like resources; anything on this list
 * is journalled with resource type `configuration` instead of `file` so the
 * panel (and the cleanup report) can say "the session reconfigured something"
 * rather than "it wrote a file".
 */
const CONFIGURATION_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'npmrc', '.npmrc', 'tsconfig.json', 'jsconfig.json', 'pyproject.toml',
  'requirements.txt', 'Pipfile', 'poetry.lock', 'Cargo.toml', 'go.mod',
  'Makefile', 'Dockerfile', 'docker-compose.yml', '.gitignore', '.editorconfig',
])

const CONFIGURATION_PREFIXES = ['.env', '.eslintrc', '.prettierrc', '.babelrc']
const CONFIGURATION_PATTERNS = [/^eslint\.config\./, /^vite\.config\./, /^vitest\.config\./, /^jest\.config\./, /^next\.config\./, /^tsconfig\..*\.json$/]

/** @returns {boolean} true when `basename` should be typed `configuration`. */
export function isConfigurationName(basename) {
  const name = String(basename)
  if (CONFIGURATION_BASENAMES.has(name)) return true
  if (CONFIGURATION_PREFIXES.some(prefix => name.startsWith(prefix))) return true
  return CONFIGURATION_PATTERNS.some(pattern => pattern.test(name))
}

/**
 * Environment variable names that must never carry a plaintext value into the
 * journal. Matched against the upper-cased name; the list errs on the side of
 * redaction (a variable called SESSION_KEY is a secret until proven else).
 */
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|KEY|CREDENTIAL|CRED|AUTH|CERT|SIGNATURE|COOKIE|PRIVATE|API_?KEY|ACCESS_?KEY|SESSION_?KEY|BEARER|JWT)/

/** @returns {boolean} true when values of `name` must be redacted. */
export function isSecretName(name) {
  return SECRET_NAME_PATTERN.test(String(name).toUpperCase())
}

/**
 * SHA-256 of a string, hex. Used for content addressing in the snapshot store
 * and for redacted value fingerprints (equality checkable, not reversible).
 * @param {string | Buffer} data
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Cheap content type sniff for redacted values: only JSON-serializable
 * primitives are journalled as values at all; everything else is fingerprinted.
 * @param {unknown} value
 */
export function isPlainValue(value) {
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Guard used by every cleanup action that touches a path: the target must be
 * strictly inside `root` and must not be the root itself. Mirrors the
 * `isSessionDir` safety philosophy in session-manage.js (resolve, then
 * prefix-check with the separator appended so `..` and sibling prefixes
 * cannot sneak through).
 * @param {string} targetPath
 * @param {string} rootPath
 */
export function isInsideRoot(targetPath, rootPath) {
  const root = resolve(String(rootPath))
  const target = resolve(String(targetPath))
  if (target === root) return false
  return target.startsWith(root.endsWith('/') ? root : root + '/')
}

/**
 * Build the journal record envelope. Every tracker funnels through here so
 * the lifecycle semantics (id, seq, timestamp, ownership) are stamped in one
 * place and cannot drift per tracker.
 *
 * @param {object} fields
 * @param {number} seq monotonic per-session sequence number
 * @param {string} sessionId owning session
 * @param {string} resourceType one of RESOURCE_TYPES
 * @param {string} action one of ACTIONS
 * @param {object} resource tracker-specific identifier ({path} | {name} | {package} | {command})
 * @param {object|null} before state before the change (snapshot refs allowed)
 * @param {object|null} after state after the change
 * @param {string} ownership one of OWNERSHIP
 * @param {object} [metadata] tracker-specific extras (url, redaction flags, ...)
 */
export function makeChangeRecord({ seq, sessionId, resourceType, action, resource, before, after, ownership, metadata }) {
  return {
    id: `chg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    timestamp: Date.now(),
    resourceType,
    action,
    resource,
    before,
    after,
    ownership,
    metadata: metadata ?? {},
  }
}
