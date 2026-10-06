// dsh-session-manager — observation trackers: downloads and processes.
//
// These two do not diff state — they observe tool-call metadata and turn it
// into journal-ready changes:
//
// DownloadTracker: a download is a distinct resource change (requirement §三)
// even though on disk it is "just" a created file. The tracker keeps a short
// rolling window of download intents (fetch/transfer tool calls, or
// curl/wget in a bash command) with their source URL and a target hint; the
// NEXT workspace diff that produces a created file while an intent is pending
// correlates the two (hint first, oldest-unhinted second) and yields a
// `downloaded` record carrying url, target, size and hash. A download that
// lands on a pre-existing file keeps that fact in its before-state (the
// manager's ownership stamping handles restore-not-remove). Uncorrelated
// intents expire silently — the file-level created record still journaled the
// artifact, so nothing is lost, only the URL attribution.
//
// ProcessTracker: records session-owned process spawns (nohup / trailing & /
// disown). Cleanup of a live process belongs to the harness (the existing
// delete/purge flow stops session activity before touching the disk); the
// journal entry exists so the cleanup report can account for what was
// observed instead of silently ignoring it.
//
// SCRUBBING: everything these trackers persist is scrubbed first. A URL may
// carry credentials (`user:pw@`) or signed query tokens; a command may carry
// `Authorization` headers or `TOKEN=...` assignments. Neither may reach the
// journal (requirement §十四) or the cleanup report.

import { ACTIONS, RESOURCE_TYPES } from '../types.js'

const INTENT_TTL_MS = 120 * 1000
const MAX_INTENTS = 16
const COMMAND_LIMIT = 512

const FETCH_TOOL_RE = /fetch|download|web|http|curl|wget/i
const URL_IN_COMMAND_RE = /\b(?:https?:\/\/[^\s'"<>]+|www\.[^\s'"<>]+)/i

/** Query parameters whose VALUES are credentials, tokens or signatures. */
const SENSITIVE_PARAM_RE = /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|credential|auth|authorization|signature|sig|signed|assertion|saml|session|jwt|bearer|code)$/i

/**
 * Scrub one URL: strip userinfo, redact sensitive query values. Unparsable
 * input still gets its `//user:pass@` prefix stripped.
 */
export function sanitizeUrl(raw) {
  const text = String(raw ?? '')
  try {
    const url = new URL(text)
    if (url.username !== '' || url.password !== '') {
      url.username = ''
      url.password = ''
    }
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAM_RE.test(name) === true) url.searchParams.set(name, '<REDACTED>')
    }
    return url.href
  } catch {
    return text.replace(/\/\/[^/@\s]+@/, '//')
  }
}

const AUTH_HEADER_RE = /(authorization\s*:\s*)(?:bearer\s+)?[^\s"']+/gi
const SECRET_ASSIGN_RE = /\b(token|access[_-]?token|api[_-]?key|apikey|secret|password|passwd|credential)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi
const URL_IN_TEXT_RE = /(https?:\/\/[^\s'"<>]+)/g

/**
 * Scrub one command string before it is persisted: URLs lose credentials and
 * signed tokens, `Authorization:` headers and secret-looking assignments are
 * masked, and the result is truncated.
 */
export function sanitizeCommand(command, limit = COMMAND_LIMIT) {
  let text = String(command ?? '')
  text = text.replace(URL_IN_TEXT_RE, match => sanitizeUrl(match))
  text = text.replace(AUTH_HEADER_RE, '$1<REDACTED>')
  text = text.replace(SECRET_ASSIGN_RE, '$1$2<REDACTED>')
  return text.length > limit ? text.slice(0, limit) : text
}

/** Extract the first http(s) URL from a command string, or null. */
export function firstUrl(text) {
  const match = URL_IN_COMMAND_RE.exec(String(text ?? ''))
  return match === null ? null : match[1] ?? match[0]
}

/** Best-effort target of a download: `-o/--output`, else the URL basename. */
function targetHintOf(command, url) {
  const output = /(?:^|\s)(?:-o|--output)\s+("[^"]+"|'[^']+'|\S+)/.exec(String(command ?? ''))
  if (output !== null) return output[1].replace(/^["']|["']$/g, '')
  if (url !== null && url !== '') {
    try {
      const path = new URL(url.startsWith('www.') ? `https://${url}` : url).pathname
      const base = path.slice(path.lastIndexOf('/') + 1)
      if (base !== '') return base
    } catch {
      const base = url.slice(url.lastIndexOf('/') + 1)
      if (base !== '') return base
    }
  }
  return null
}

export function createDownloadTracker() {
  let intents = [] // { url, hint, at, toolName }

  function pushIntent(url, toolName, hint) {
    const now = Date.now()
    intents = intents.filter(intent => now - intent.at < INTENT_TTL_MS)
    intents.unshift({ url: url === null ? null : sanitizeUrl(url), hint, at: now, toolName })
    if (intents.length > MAX_INTENTS) intents.length = MAX_INTENTS
  }

  return {
    resourceType: RESOURCE_TYPES.DOWNLOAD,

    /**
     * Feed one tool/call event. Recognizes fetch-shaped tool names and
     * curl/wget-shaped bash commands as download intents.
     * @param {{name?: string, command?: string}} call
     */
    observeToolCall(call) {
      const toolName = String(call?.name ?? '')
      const command = typeof call?.command === 'string' ? call.command : ''
      const isTransferCommand = /\b(curl|wget)\b/.test(command)
      if (FETCH_TOOL_RE.test(toolName) === false && isTransferCommand === false) return
      const url = firstUrl(command) // bash-shaped calls carry the URL in the command
      pushIntent(url, toolName, url === null ? null : targetHintOf(command, url))
    },

    /**
     * Called by the manager right after a file diff; correlates created files
     * with pending intents: a path matching an intent's target hint wins it;
     * hint-less intents fall back to oldest-first. Hinted intents never attach
     * to an unrelated file — they wait for their own target or expire.
     * @param {string[]} createdPaths workspace-relative paths
     * @returns {{path: string, url: string|null}[]}
     */
    correlate(createdPaths) {
      if (createdPaths.length === 0 || intents.length === 0) return []
      const now = Date.now()
      intents = intents.filter(intent => now - intent.at < INTENT_TTL_MS)
      if (intents.length === 0) return []
      const pending = [...intents]
      const correlated = []
      for (const path of createdPaths) {
        const base = path.slice(path.lastIndexOf('/') + 1)
        let index = pending.findIndex(intent => intent.hint !== null && (intent.hint === path || intent.hint === base))
        if (index === -1) index = pending.findIndex(intent => intent.hint === null)
        if (index === -1) continue // only hinted intents left, none matching
        const [intent] = pending.splice(index, 1)
        correlated.push({ path, url: intent.url })
      }
      intents = pending // leftovers stay valid for the next diff
      return correlated
    },
  }
}

// A backgrounded command ends a LINE with a single `&` (not `&&`), optionally
// followed by `disown`. Bare `&` inside a URL query or a `&&` chain must not
// classify as a spawn.
const BACKGROUND_LINE_RE = /(?<!&)&\s*(?:disown\s*)?$/

/** The first backgrounded line of a command, or null. */
function backgroundLineOf(command) {
  for (const line of String(command ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.endsWith('&&') === true || trimmed.endsWith('||') === true) continue
    if (BACKGROUND_LINE_RE.test(trimmed) === true) return trimmed
  }
  return null
}

export function createProcessTracker() {
  return {
    resourceType: RESOURCE_TYPES.PROCESS,

    /**
     * Classify one bash tool call as a background spawn, if it is one.
     * @returns {object|null} change record WITHOUT ownership stamps
     */
    classify(call) {
      const line = backgroundLineOf(call?.command)
      if (line === null) return null
      const command = sanitizeCommand(line)
      return {
        resourceType: RESOURCE_TYPES.PROCESS,
        action: ACTIONS.SPAWNED,
        resource: { command },
        before: null,
        after: { command, observedAt: Date.now() },
        metadata: { cleanup: 'delegated', reason: 'live session processes are stopped by the host activity stop' },
      }
    },
  }
}
