// dsh-session-manager — observation trackers: downloads and processes.
//
// These two do not diff state — they observe tool-call metadata and turn it
// into journal-ready changes:
//
// DownloadTracker: a download is a distinct resource change (requirement §三)
// even though on disk it is "just" a created file. The tracker keeps a short
// rolling window of download intents (fetch/transfer tool calls, or
// curl/wget in a bash command) with their source URL; the NEXT workspace diff
// that produces a created file while an intent is pending correlates the two
// and yields a `downloaded` record carrying url, target, size and hash. A
// download that lands on a pre-existing file keeps that fact in its
// before-state (the manager's ownership stamping handles restore-not-remove).
// Uncorrelated intents expire silently — the file-level created record still
// journaled the artifact, so nothing is lost, only the URL attribution.
//
// ProcessTracker: records session-owned process spawns (nohup / trailing & /
// disown). Cleanup of a live process belongs to the harness (the existing
// delete/purge flow stops session activity before touching the disk); the
// journal entry exists so the cleanup report can account for what was
// observed instead of silently ignoring it.

import { ACTIONS, RESOURCE_TYPES } from '../types.js'

const INTENT_TTL_MS = 120 * 1000
const MAX_INTENTS = 16

const FETCH_TOOL_RE = /fetch|download|web|http|curl|wget/i
const URL_IN_COMMAND_RE = /\b(?:https?:\/\/[^\s'"<>]+|www\.[^\s'"<>]+)/i
const BACKGROUND_RE = /(?:^|\s)(?:nohup\s+.*&\s*$|.*&\s*(?:disown\s*)?$|.*&>?\s*\/dev\/null\s*&\s*$)/

/** Extract the first http(s) URL from a command string, or null. */
export function firstUrl(text) {
  const match = URL_IN_COMMAND_RE.exec(String(text ?? ''))
  return match === null ? null : match[1] ?? match[0]
}

export function createDownloadTracker() {
  let intents = [] // { url, at, toolName }

  function pushIntent(url, toolName) {
    const now = Date.now()
    intents = intents.filter(intent => now - intent.at < INTENT_TTL_MS)
    intents.unshift({ url, at: now, toolName })
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
      if (FETCH_TOOL_RE.test(toolName) === false && /\b(curl|wget)\b/.test(command) === false) return
      const url = firstUrl(command) // bash-shaped calls carry the URL in the command
      if (url === null && /\b(curl|wget)\b/.test(command) === false) {
        // fetch tools without a URL argument we can read still count as an
        // intent: the created-file correlation then proceeds url-less
        pushIntent(null, toolName)
        return
      }
      pushIntent(url, toolName)
    },

    /**
     * Called by the manager right after a file diff; correlates created files
     * with pending intents. `createdPaths` are workspace-relative.
     * @param {string[]} createdPaths
     * @returns {{path: string, url: string|null}[]}
     */
    correlate(createdPaths) {
      if (createdPaths.length === 0 || intents.length === 0) return []
      const now = Date.now()
      intents = intents.filter(intent => now - intent.at < INTENT_TTL_MS)
      if (intents.length === 0) return []
      const correlated = []
      for (const path of createdPaths) {
        const intent = intents.shift()
        if (intent === undefined) break
        correlated.push({ path, url: intent.url })
      }
      return correlated
    },
  }
}

export function createProcessTracker() {
  return {
    resourceType: RESOURCE_TYPES.PROCESS,

    /**
     * Classify one bash tool call as a background spawn, if it is one.
     * @returns {object|null} change record WITHOUT ownership stamps
     */
    classify(call) {
      const command = String(call?.command ?? '')
      if (command === '' || BACKGROUND_RE.test(command) === false) return null
      return {
        resourceType: RESOURCE_TYPES.PROCESS,
        action: ACTIONS.SPAWNED,
        resource: { command: command.slice(0, 512) },
        before: null,
        after: { command: command.slice(0, 512), observedAt: Date.now() },
        metadata: { cleanup: 'delegated', reason: 'live session processes are stopped by the host activity stop' },
      }
    },
  }
}
