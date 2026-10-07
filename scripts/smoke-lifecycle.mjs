// Lifecycle smoke test for the resource-tracking upgrade (v0.2.0).
//
// Boots apply() against a mock ctx whose services are backed by a temp
// $DSH_HOME and a REAL temp workspace directory, then drives the ten required
// lifecycle scenarios through the real RPC dispatcher:
//
//   Case 1  session creates a file        → cleanup removes it + journal gone
//   Case 2  session modifies a file       → cleanup restores pre-session content
//   Case 3  session deletes a file        → cleanup restores the deleted file
//   Case 4  session installs a dependency → cleanup uninstalls it
//   Case 5  session uses an existing dep  → cleanup leaves it alone
//   Case 6  env var created               → recorded (values redacted; host env untouched)
//   Case 7  env var modified (+secret)    → recorded redacted; cleanup never writes the host env
//   Case 8  crash mid-cleanup             → restart resumes and finishes
//   Case 9  cleanup run twice             → idempotent, no damage
//   Case 10 external conflict             → detected, not silently overwritten;
//                                           force mode overwrites explicitly
//
// Plus: download attribution, move/rename, resources/changes/cleanupStatus
// views, legacy (untracked) session behavior, restore-cancels-pending-cleanup.
//
// Run: node scripts/smoke-lifecycle.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../lifecycle/types.js'

// never pop real Finder/Explorer windows during the smoke run
process.env.DSH_SM_OPEN_MODE = 'log'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'dsm-life-'))
process.env.DSH_HOME = home
process.env.DSH_SM_TRASH_DIR = join(home, '.Trash')

const NOW = Date.now()
let checks = 0
function ok(condition, message) {
  if (!condition) {
    console.error(`LIFE FAIL: ${message}`)
    console.error(`(temp home kept for inspection: ${home})`)
    process.exit(1)
  }
  checks += 1
}

// --- host scaffolding ---------------------------------------------------------

const workspaces = new Map() // sessionId → cwd
const sessionIds = () => [...workspaces.keys()]
const headers = () => sessionIds().map(id => ({ version: 4, id, createdAt: NOW, cwd: workspaces.get(id), isSeeded: false }))

const workspace = {
  archived: new Set(),
  stopped: [],
}
const archiveFailIds = new Set()
const noCwdIds = new Set()
const services = {
  sessionController: { list: async () => ({ items: [] }) },
  sessionQuery: {
    listSessions: async () => headers().map(header => noCwdIds.has(header.id) ? { header: { ...header, cwd: undefined }, live: true, persisted: true } : { header, live: true, persisted: true }),
    readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: { version: 4, id, createdAt: NOW } } })),
  },
  sessionPersistence: { list: async () => headers().map(header => noCwdIds.has(header.id) ? { header: { ...header, cwd: undefined }, revision: 'r1', sizeBytes: 100, eventCount: 1 } : { header, revision: 'r1', sizeBytes: 100, eventCount: 1 }) },
  workspaceRegistry: {
    get archivedSessionIds() { return [...workspace.archived] },
    archiveSession: async (id, options) => {
      if (archiveFailIds.has(id)) throw new Error('registry exploded')
      if (!workspaces.has(id)) throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' })
      workspace.archived.add(id)
      if (options?.stopActivity === true) workspace.stopped.push(id)
    },
    unarchiveSession: async (id) => { workspace.archived.delete(id) },
  },
}

const allApps = []
function bootWith(configOverrides = {}) {
  const eventListeners = {}
  const captured = {}
  captured.disposers = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: (name, listener) => { (eventListeners[name] ??= []).push(listener); return () => {} },
    effect: (execute) => { const disposer = execute(); captured.disposers.push(disposer); return disposer },
    get: name => services[name],
    connection: { rpc: { handle: (channel, dispatch) => { captured.dispatch = dispatch; return () => {} } } },
  }
  const config = hostModule.Config(configOverrides)
  hostModule.apply(ctx, config)
  const instance = {
    dispatch: captured.dispatch,
    disposers: captured.disposers,
    emitTo(name, ...args) {
      for (const listener of eventListeners[name] ?? []) listener(...args)
    },
    emit(sessionId, event) {
      this.emitTo('session/event', { id: sessionId }, event)
    },
    sessionCreated(sessionId) {
      this.emitTo('session/created', { id: sessionId })
    },
    async toolCall(sessionId, name, args) {
      this.emit(sessionId, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify(args) }, time: Date.now() })
    },
    async toolResult(sessionId) {
      this.emit(sessionId, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'toolResult', content: [] } }, time: Date.now() })
    },
  }
  allApps.push(instance)
  return instance
}

const boot = () => bootWith({})

async function call(dispatch, endpoint, payload) {
  const result = await dispatch(endpoint, payload)
  ok(result !== null && typeof result === 'object' && typeof result.ok === 'boolean', `${endpoint} returned a strict { ok } result`)
  return result
}

/**
 * The host emits session events without awaiting listeners (ctx.emit is a
 * sync broadcast), so the journal write behind a tool/call lands a few
 * microtasks later. Poll like the real world would.
 */
async function peek(endpoint, payload) {
  return dispatch(endpoint, payload)
}

async function waitFor(predicate, { timeout = 4000, step = 20 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, step))
  }
  return false
}

const sessionsRoot = () => join(home, 'sessions', '--tmp-project--')
const sessionDir = id => join(sessionsRoot(), id)
const trackingDir = id => join(home, 'dsh-session-manager', 'tracking', encodeSegmentForTest(String(id)))

function encodeSegmentForTest(input) {
  return String(input).replace(/[^A-Za-z0-9._-]/g, char => '~' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
}

/** Session whose on-disk directory uses the ENCODED id (like the real layout). */
function makeSessionDir(rawId, encodedId) {
  const cwd = join(home, 'workspaces', encodedId)
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(sessionsRoot(), encodedId), { recursive: true })
  workspaces.set(rawId, cwd)
  return cwd
}

function makeSession(id) {
  const cwd = join(home, 'workspaces', id)
  mkdirSync(cwd, { recursive: true })
  mkdirSync(sessionDir(id), { recursive: true })
  workspaces.set(id, cwd)
  return cwd
}

function removeSessionFromCorpus(id) {
  workspaces.delete(id)
}

const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : null)

// load the host half once; boot() per plugin instance
const hostModule = await import(new URL('../index.js', import.meta.url).href)

const app = boot()
const dispatch = app.dispatch

// --- event-driven path (the REAL usage flow, no explicit track calls) ----------
{
  const id = 'session-event'
  const cwd = makeSession(id)
  app.sessionCreated(id)
  ok(await waitFor(() => existsSync(trackingDir(id))), 'event: session/created baselines the session immediately')

  // the agent creates a file; only the tool/result event fires (no track RPC)
  writeFileSync(join(cwd, 'live.txt'), 'live')
  await app.toolResult(id)
  ok(await waitFor(async () => (await peek('changes', { id })).value.changes.some(record => record.action === 'created' && record.resource.path === 'live.txt')), 'event: debounced diff journals the created file')

  // deleting the session removes what it created — the core promise
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true && result.value.results[0]?.cleanup?.state === 'rollback_verified', `event: delete cleans up (got ${JSON.stringify(result.value.results[0]?.cleanup)})`)
  ok(!existsSync(join(cwd, 'live.txt')), 'event: session-created file removed by delete')
  removeSessionFromCorpus(id)
}

// --- deleted sessions must not be re-baselined by the boot sweep ----------------
{
  const id = 'session-norelive'
  makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  ok(existsSync(trackingDir(id)), 'norelive: baseline exists before delete')
  await call(dispatch, 'delete', { ids: [id] })
  ok(!existsSync(trackingDir(id)), 'norelive: tracking destroyed by delete')
  // the id stays in the corpus (host caches lag the disk) and we "restart"
  const restarted = boot()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  ok(!existsSync(trackingDir(id)), 'norelive: boot sweep does NOT resurrect a deleted session tracking dir')
  ok((await peek('list', { view: 'all' })).ok === true, 'norelive: list still renders after restart')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  ok(!existsSync(trackingDir(id)), 'norelive: list self-heal does NOT resurrect it either')
  removeSessionFromCorpus(id)
}

// --- list self-heal: opening the panel baselines untracked rows -----------------
{
  const id = 'session-listheal'
  const cwd = makeSession(id)
  const list = await call(dispatch, 'list', { view: 'all' })
  ok(list.value.rows.find(row => row.id === id) !== undefined, 'self-heal: session listed')
  ok(await waitFor(async () => (await peek('list', { view: 'all' })).value.rows.find(row => row.id === id)?.tracked === true), 'self-heal: list request baselines the row (tracked=true)')
  removeSessionFromCorpus(id)
}

// --- final diff rescues a missed debounce (the "no effect" report scenario) -----
{
  const id = 'session-finaldiff'
  const cwd = makeSession(id)
  app.sessionCreated(id)
  await waitFor(() => existsSync(trackingDir(id)))
  writeFileSync(join(cwd, 'late.txt'), 'late')
  await app.toolResult(id) // fresh activity; debounce deliberately NOT awaited
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true && result.value.results[0]?.cleanup?.state === 'rollback_verified', `final-diff: delete with missed debounce still cleans (got ${JSON.stringify(result.value.results[0]?.cleanup)})`)
  ok(!existsSync(join(cwd, 'late.txt')), 'final-diff: removal-time diff caught the file the event diff missed')
  removeSessionFromCorpus(id)
}

// --- final diff protects external edits made long after the session went quiet --
{
  const id = 'session-suspect'
  const cwd = makeSession(id)
  app.sessionCreated(id)
  await waitFor(() => existsSync(trackingDir(id)))
  // something else writes a file long after the session went quiet: backdate
  // the persisted activity clock (a restart loses the in-memory freshness)
  writeFileSync(join(trackingDir(id), 'activity.json'), `${JSON.stringify({ lastEventAt: Date.now() - 10 * 60 * 1000 })}\n`)
  writeFileSync(join(cwd, 'foreign.txt'), 'foreign')
  // delete through a SECOND instance (fresh in-memory clock, like a restart)
  const restarted = boot()
  const result = await call(restarted.dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'suspect: delete ok')
  ok(existsSync(join(cwd, 'foreign.txt')), 'suspect: change captured long after session went quiet is NOT rolled back')
  removeSessionFromCorpus(id)
}

// --- Case 1: session creates a file → delete removes it, journal gone ---------
{
  const id = 'session-case1'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] }) // first sight → baseline
  ok(existsSync(trackingDir(id)), 'case1: baseline captured for tracked session')

  writeFileSync(join(cwd, 'a.txt'), 'created by session')
  await call(dispatch, 'track', { ids: [id] })
  ok(existsSync(join(cwd, 'a.txt')), 'case1: a.txt exists during session')

  const changes = await call(dispatch, 'changes', { id })
  ok(changes.value.total === 1, `case1: journal has 1 change, got ${changes.value.total}`)
  ok(changes.value.changes[0]?.action === 'created' && changes.value.changes[0]?.ownership === 'session_created', 'case1: change stamped created/session_created')

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case1: delete ok')
  ok(!existsSync(join(cwd, 'a.txt')), 'case1: session-created file removed by cleanup')
  ok(!existsSync(sessionDir(id)), 'case1: session directory removed')
  ok(!existsSync(trackingDir(id)), 'case1: journal + baseline destroyed after verified cleanup')
  ok(result.value.results[0]?.journalRemoved === true, 'case1: result reports journalRemoved')
  removeSessionFromCorpus(id)
}

// --- Case 2: session modifies a pre-existing file → restore A ------------------
{
  const id = 'session-case2'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'config.json'), 'A')
  writeFileSync(join(cwd, 'untouched.txt'), 'never touched')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'B')
  await call(dispatch, 'track', { ids: [id] })

  // the view lists the session's own changes only: the modified file IS
  // listed (as a change), the untouched file is NOT listed at all
  const resources = await call(dispatch, 'resources', { id })
  const configRow = resources.value.resources.find(row => row.identifier === 'config.json')
  ok(configRow?.ownership === 'session_modified', `case2: modify stamped session_modified, got ${configRow?.ownership}`)
  ok(resources.value.resources.some(row => row.identifier === 'untouched.txt') === false, 'case2: untouched pre-existing file NOT listed')
  ok(resources.value.resources.every(row => row.ownership !== 'preexisting'), 'case2: no pre-existing rows at all')

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case2: delete ok')
  ok(read(join(cwd, 'config.json')) === 'A', `case2: config.json restored to A, got ${JSON.stringify(read(join(cwd, 'config.json')))}`)
  ok(read(join(cwd, 'untouched.txt')) === 'never touched', 'case2: untouched file intact')
  ok(!existsSync(trackingDir(id)), 'case2: journal destroyed')
  removeSessionFromCorpus(id)
}

// --- Case 3: session deletes a pre-existing file → restore ---------------------
{
  const id = 'session-case3'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'old.txt'), 'precious')
  await call(dispatch, 'track', { ids: [id] })
  rmSync(join(cwd, 'old.txt'))
  await call(dispatch, 'track', { ids: [id] })

  const changes = await call(dispatch, 'changes', { id })
  ok(changes.value.changes.some(record => record.action === 'deleted' && record.ownership === 'session_deleted' && record.before?.snapshot), 'case3: delete journaled with a before snapshot')

  await call(dispatch, 'delete', { ids: [id] })
  ok(read(join(cwd, 'old.txt')) === 'precious', 'case3: deleted file restored from snapshot')
  removeSessionFromCorpus(id)
}

// --- Case 4: session installs a new dependency → uninstalled on cleanup --------
{
  const id = 'session-case4'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }, null, 2))
  await call(dispatch, 'track', { ids: [id] })

  // the session ran `npm install axios`: package dir + manifest entry
  mkdirSync(join(cwd, 'node_modules', 'axios'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'axios', 'package.json'), JSON.stringify({ name: 'axios', version: '1.0.0' }))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', dependencies: { axios: '^1.0.0' } }, null, 2))
  await call(dispatch, 'track', { ids: [id] })

  const changes = await call(dispatch, 'changes', { id })
  const install = changes.value.changes.find(record => record.resourceType === 'dependency' && record.action === 'installed')
  ok(install?.resource?.package === 'axios' && install.ownership === 'session_installed', 'case4: axios install journaled as session_installed')

  await call(dispatch, 'delete', { ids: [id] })
  ok(!existsSync(join(cwd, 'node_modules', 'axios')), 'case4: session-installed package removed')
  ok(existsSync(join(cwd, 'node_modules')), 'case4: node_modules root survives (excluded from file tracking, so the session never owned it)')
  ok(!read(join(cwd, 'package.json')).includes('axios'), 'case4: package.json restored without the axios dependency')
  removeSessionFromCorpus(id)
}

// --- Case 5: session uses an existing dependency → untouched -------------------
{
  const id = 'session-case5'
  const cwd = makeSession(id)
  mkdirSync(join(cwd, 'node_modules', 'axios'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'axios', 'package.json'), JSON.stringify({ name: 'axios', version: '1.0.0' }))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', dependencies: { axios: '^1.0.0' } }, null, 2))
  await call(dispatch, 'track', { ids: [id] })

  // the resources view lists ONLY what the session produced — pre-existing
  // content (axios, package.json) must not appear as rows
  const resources = await call(dispatch, 'resources', { id })
  ok(resources.value.tracked === true, 'case5: view available')
  ok(resources.value.resources.every(row => row.ownership !== 'preexisting'), 'case5: no pre-existing rows in the resource view')
  ok(resources.value.resources.every(row => row.identifier !== 'node_modules/axios'), 'case5: untouched pre-existing dependency not listed')
  ok(resources.value.baseline?.fileCount >= 1, 'case5: baseline summary still reports the pre-existing content')

  await call(dispatch, 'delete', { ids: [id] })
  ok(existsSync(join(cwd, 'node_modules', 'axios')), 'case5: pre-existing axios still installed after cleanup')
  ok(read(join(cwd, 'package.json')).includes('axios'), 'case5: package.json still declares axios')
  removeSessionFromCorpus(id)
}

// --- unbaselined pre-existing files are never treated as session creations -----
{
  const id = 'session-unbaselined'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'old-a.txt'), 'old-a')
  writeFileSync(join(cwd, 'old-b.txt'), 'old-b')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200)) // outlive the timestamp slack
  await call(dispatch, 'track', { ids: [id] }) // baseline captures both files
  // simulate a truncated / missed baseline: drop the file entries on disk,
  // then diff through a FRESH instance (a remount, like a real restart)
  const baselinePath = join(trackingDir(id), 'baseline.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  baseline.files = {}
  writeFileSync(baselinePath, JSON.stringify(baseline))
  const restarted = boot()
  await call(restarted.dispatch, 'track', { ids: [id] })

  const changes = await call(restarted.dispatch, 'changes', { id })
  ok(changes.value.changes.some(record => record.resource?.path === 'old-a.txt') === false, 'unbaselined: pre-existing file NOT journaled as a creation')
  const resources = await call(restarted.dispatch, 'resources', { id })
  ok(resources.value.resources.some(row => row.identifier === 'old-a.txt') === false, 'unbaselined: pre-existing file NOT listed in the resource view')

  // a genuinely new file still journals + cleans up normally
  writeFileSync(join(cwd, 'fresh.txt'), 'fresh')
  await call(restarted.dispatch, 'track', { ids: [id] })
  ok((await peek('changes', { id })).value.changes.some(record => record.resource?.path === 'fresh.txt' && record.action === 'created'), 'unbaselined: genuinely new file still journaled as created')

  // modifying an adopted pre-existing file must NOT make it removable
  writeFileSync(join(cwd, 'old-a.txt'), 'old-a-modified')
  // a permission-only change on another adopted file must not make it removable either
  chmodSync(join(cwd, 'old-b.txt'), 0o600)
  await call(restarted.dispatch, 'track', { ids: [id] })
  const deleted = await call(restarted.dispatch, 'delete', { ids: [id] })
  ok(deleted.value.results[0]?.cleanup?.state === 'rollback_verified', `unbaselined: cleanup verified (got ${JSON.stringify(deleted.value.results[0]?.cleanup)})`)
  ok(existsSync(join(cwd, 'old-a.txt')) && readFileSync(join(cwd, 'old-a.txt'), 'utf8') === 'old-a-modified', `unbaselined: pre-existing modified file PRESERVED [exists=${existsSync(join(cwd, 'old-a.txt'))} content=${existsSync(join(cwd, 'old-a.txt')) ? JSON.stringify(readFileSync(join(cwd, 'old-a.txt'), 'utf8')) : 'n/a'}]`)
  ok(existsSync(join(cwd, 'old-b.txt')), 'unbaselined: pre-existing file with permission-only change preserved')
  ok(!existsSync(join(cwd, 'fresh.txt')), 'unbaselined: session-created file still removed')
  removeSessionFromCorpus(id)
}

// --- Case 6: env var created → unset on cleanup --------------------------------
{
  const id = 'session-case6'
  makeSession(id)
  delete process.env.DSM_LIFE_FOO
  await call(dispatch, 'track', { ids: [id] })

  await app.toolCall(id, 'bash', { command: 'export DSM_LIFE_FOO=123' })
  ok(await waitFor(async () => (await peek('changes', { id })).value.total >= 1), 'case6: env mutation journaled')
  ok(!('DSM_LIFE_FOO' in process.env), 'case6: host process env NOT mutated (record-only)')
  const changes = await call(dispatch, 'changes', { id })
  const setRecord = changes.value.changes.find(record => record.resourceType === 'environment_variable')
  ok(setRecord?.action === 'set' && setRecord.before === null && setRecord.after?.redacted === true && typeof setRecord.after?.hash === 'string', 'case6: set journaled with before=null and a redacted value')

  // runtime-affecting variables are excluded from tracking outright
  {
    const before = (await peek('changes', { id })).value.total
    const pathBefore = process.env.PATH
    await app.toolCall(id, 'bash', { command: 'export PATH=/tmp/evil:$PATH' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    ok((await peek('changes', { id })).value.total === before, 'case6: PATH mutation NOT journaled (excluded)')
    ok(process.env.PATH === pathBefore, 'case6: PATH untouched on the host')
  }

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case6: delete ok')
  ok(!('DSM_LIFE_FOO' in process.env), 'case6: session-created env var stays unset')
  removeSessionFromCorpus(id)
}

// --- Case 7: env var modified → restored; secret redacted ----------------------
{
  const id = 'session-case7'
  makeSession(id)
  process.env.DSM_LIFE_BAR = 'old'
  process.env.DSM_LIFE_TOKEN = 'sekrit-old'
  await call(dispatch, 'track', { ids: [id] })

  await app.toolCall(id, 'bash', { command: 'export DSM_LIFE_BAR=new && export DSM_LIFE_TOKEN=sekrit-new' })
  ok(await waitFor(async () => (await peek('changes', { id })).value.total >= 2), 'case7: both env mutations journaled')
  const changes = await call(dispatch, 'changes', { id })
  const barRecord = changes.value.changes.find(record => record.resource?.name === 'DSM_LIFE_BAR')
  const tokenRecord = changes.value.changes.find(record => record.resource?.name === 'DSM_LIFE_TOKEN')
  ok(barRecord?.before?.redacted === true && barRecord.after?.redacted === true && barRecord.before.value === undefined, 'case7: env values are NEVER journalled in plaintext (redacted+fingerprint)')
  ok(tokenRecord?.before?.redacted === true && tokenRecord.before.value === undefined && tokenRecord.before.hash !== undefined, 'case7: secret value redacted, existence+fingerprint kept')

  ok(process.env.DSM_LIFE_BAR === 'old', 'case7: host env untouched while the session ran (record-only)')
  // cleanup must NEVER write the host env: whatever value it holds now is
  // somebody else's business, and env records are audit-only
  process.env.DSM_LIFE_TOKEN = 'externally-changed'
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case7: delete ok')
  ok(result.value.results[0]?.cleanup?.state === 'rollback_verified', `case7: verified without env writes (got ${JSON.stringify(result.value.results[0]?.cleanup)})`)
  ok(process.env.DSM_LIFE_BAR === 'old', `case7: non-secret env stays at old, got ${process.env.DSM_LIFE_BAR}`)
  ok(process.env.DSM_LIFE_TOKEN === 'externally-changed', 'case7: secret var untouched by cleanup')
  delete process.env.DSM_LIFE_BAR
  delete process.env.DSM_LIFE_TOKEN
  removeSessionFromCorpus(id)
}

// --- Case 8: crash mid-cleanup → restart resumes and finishes ------------------
{
  const id = 'session-case8'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'keep.txt'), 'keep')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'junk.txt'), 'junk')
  await call(dispatch, 'track', { ids: [id] })

  // Simulate a crash DURING the rollback: cleanup.json left behind with
  // state rolling_back and an abandoned (stale) lock — exactly what a killed
  // process leaves, and exactly what the resume pass must pick up (mode full).
  mkdirSync(trackingDir(id), { recursive: true })
  writeFileSync(join(trackingDir(id), 'cleanup.json'), `${JSON.stringify({
    version: 1, sessionId: id, state: 'rolling_back', mode: 'full', requestedAt: NOW, attempts: 1,
    startedAt: Date.now() - 11 * 60 * 1000, results: [], conflicts: [], failures: [],
  })}\n`)

  // "restart": a fresh plugin instance over the same $DSH_HOME
  const restarted = boot()
  // give the fire-and-forget bootstrap a moment
  await new Promise(resolvePromise => setTimeout(resolvePromise, 150))

  ok(!existsSync(join(cwd, 'junk.txt')), 'case8: resume completed the rollback (session-created file removed)')
  ok(existsSync(join(cwd, 'keep.txt')), 'case8: pre-existing file untouched')
  ok(!existsSync(sessionDir(id)), 'case8: session directory removal finished by resume')
  ok(!existsSync(trackingDir(id)), 'case8: journal destroyed after resumed cleanup')
  removeSessionFromCorpus(id)
}

// --- Case 9: cleanup run twice → idempotent ------------------------------------
{
  const id = 'session-case9'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'base.txt'), 'base')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'extra.txt'), 'extra')
  await call(dispatch, 'track', { ids: [id] })

  const first = await call(dispatch, 'cleanup', { ids: [id], mode: 'rollback-only' })
  ok(first.value.results[0]?.ok === true && first.value.results[0]?.state === 'rollback_verified', `case9: first rollback verified, got ${JSON.stringify(first.value.results[0]?.state)}`)
  ok(!existsSync(join(cwd, 'extra.txt')), 'case9: rollback removed the session-created file')
  ok(existsSync(join(cwd, 'base.txt')), 'case9: baseline file kept')

  const second = await call(dispatch, 'cleanup', { ids: [id], mode: 'rollback-only' })
  ok(second.value.results[0]?.ok === true && second.value.results[0]?.state === 'rollback_verified', 'case9: second rollback also verified')
  ok(existsSync(join(cwd, 'base.txt')), 'case9: second cleanup did not damage the workspace')
  ok(existsSync(trackingDir(id)), 'case9: rollback-only keeps the journal (session still alive)')

  // a full cleanup after a rollback-only one: converges, then journal goes
  const full = await call(dispatch, 'cleanup', { ids: [id], mode: 'full' })
  ok(full.value.results[0]?.ok === true, 'case9: full cleanup ok')
  ok(!existsSync(trackingDir(id)), 'case9: journal destroyed by full cleanup')
  removeSessionFromCorpus(id)
}

// --- Case 10: external edits after the session went quiet are preserved ---------
{
  const id = 'session-case10'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'config.json'), 'A')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'B') // session's change
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'C') // someone else's, long after

  const result = await call(dispatch, 'delete', { ids: [id] })
  const summary = result.value.results[0]?.cleanup
  ok(summary?.ok === true && summary.state === 'rollback_verified', `case10: cleanup converges (got ${JSON.stringify(summary)})`)
  ok(read(join(cwd, 'config.json')) === 'C', `case10: external change NOT overwritten (still C), got ${read(join(cwd, 'config.json'))}`)
  removeSessionFromCorpus(id)
}

// --- Case 10b: force mode is the explicit user decision that DOES overwrite ------
{
  const id = 'session-case10f'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'config.json'), 'A')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'B')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'C')
  const forceApp = forceBoot()
  const result = await call(forceApp.dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.cleanup?.state === 'rollback_verified', `case10-force: cleanup verified, got ${JSON.stringify(result.value.results[0]?.cleanup)}`)
  ok(read(join(cwd, 'config.json')) === 'A', `case10-force: pre-session content A restored, got ${read(join(cwd, 'config.json'))}`)
  removeSessionFromCorpus(id)
}

// force boot: a plugin instance configured with conflictMode 'force'
function forceBoot() {
  return bootWith({ conflictMode: 'force', autoResume: false })
}

// --- env external changes are preserved, never silently undone ------------------
{
  // case8a: session-created var that somebody else set afterwards
  const id = 'session-env-ext'
  makeSession(id)
  delete process.env.DSM_EXT_FOO
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: 'export DSM_EXT_FOO=123' })
  ok(await waitFor(async () => (await peek('changes', { id })).value.total >= 1), 'env-ext: mutation journaled')
  process.env.DSM_EXT_FOO = 'externally-set' // the plugin never applied it; this is someone else's value
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.cleanup?.state === 'rollback_verified', `env-ext: cleanup verified, env never written (got ${JSON.stringify(result.value.results[0]?.cleanup)})`)
  ok(process.env.DSM_EXT_FOO === 'externally-set', 'env-ext: externally-set value NOT deleted')
  delete process.env.DSM_EXT_FOO
  removeSessionFromCorpus(id)

  // case8b: pre-existing var the session touched, then somebody unset it
  const id2 = 'session-env-ext2'
  makeSession(id2)
  process.env.DSM_EXT_BAR = 'old'
  await call(dispatch, 'track', { ids: [id2] })
  await app.toolCall(id2, 'bash', { command: 'export DSM_EXT_BAR=new' })
  ok(await waitFor(async () => (await peek('changes', { id: id2 })).value.total >= 1), 'env-ext: modify journaled')
  delete process.env.DSM_EXT_BAR // external unset
  const result2 = await call(dispatch, 'delete', { ids: [id2] })
  ok(result2.value.results[0]?.cleanup?.state === 'rollback_verified', `env-ext: cleanup verified, nothing resurrected (got ${JSON.stringify(result2.value.results[0]?.cleanup)})`)
  ok(!('DSM_EXT_BAR' in process.env), 'env-ext: externally-unset variable NOT resurrected')
  delete process.env.DSM_EXT_BAR
  removeSessionFromCorpus(id2)
}

// --- downloads ------------------------------------------------------------------
{
  const id = 'session-dl'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: 'curl -sSL https://example.com/data.bin -o data.bin' })
  // the event fires without await; give observeToolCall's intent registration
  // a moment before diffing, then the correlation is deterministic
  await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  writeFileSync(join(cwd, 'data.bin'), 'binary-ish')
  await call(dispatch, 'track', { ids: [id] })

  const fresh = await call(dispatch, 'changes', { id })
  const download2 = fresh.value.changes.find(record => record.resourceType === 'download')
  ok(download2 !== undefined, 'download: journaled')
  ok(download2?.action === 'downloaded' && download2.metadata?.url === 'https://example.com/data.bin', 'download: URL attributed')
  ok(download2?.ownership === 'session_created', 'download: ownership session_created')

  await call(dispatch, 'delete', { ids: [id] })
  ok(!existsSync(join(cwd, 'data.bin')), 'download: file removed on cleanup')
  removeSessionFromCorpus(id)
}

// --- move/rename ------------------------------------------------------------------
{
  const id = 'session-mv'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'draft.txt'), 'same-content')
  await call(dispatch, 'track', { ids: [id] })
  rmSync(join(cwd, 'draft.txt'))
  writeFileSync(join(cwd, 'final.txt'), 'same-content')
  await call(dispatch, 'track', { ids: [id] })

  const changes = await call(dispatch, 'changes', { id })
  const rename = changes.value.changes.find(record => record.action === 'renamed' || record.action === 'moved')
  ok(rename !== undefined && rename.resource?.path === 'draft.txt' && rename.resource?.to === 'final.txt', `move: journaled as ${rename?.action} from→to`)

  await call(dispatch, 'delete', { ids: [id] })
  ok(read(join(cwd, 'draft.txt')) === 'same-content', 'move: pre-session path restored')
  ok(!existsSync(join(cwd, 'final.txt')), 'move: session-created destination removed')
  removeSessionFromCorpus(id)
}

// --- legacy (untracked) session: nothing is attributed, nothing destroyed --------
{
  const id = 'session-legacy'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'user-file.txt'), 'user data')
  // no baseline, no journal: a session from before the upgrade
  const view = await call(dispatch, 'changes', { id })
  ok(view.value.tracked === false && view.value.total === 0, 'legacy: reported untracked')

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'legacy: delete ok')
  ok(result.value.results[0]?.cleanup?.skipped === 'legacy-untracked', 'legacy: cleanup skipped as legacy-untracked')
  ok(existsSync(join(cwd, 'user-file.txt')), 'legacy: workspace files untouched (requirement §十五)')
  ok(!existsSync(sessionDir(id)), 'legacy: session directory still removed')
  ok(!existsSync(trackingDir(id)), 'legacy: no tracking dir invented for legacy sessions')
  removeSessionFromCorpus(id)
}

// --- restore cancels a pending cleanup --------------------------------------------
{
  const id = 'session-cancel'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'doc.txt'), 'doc')
  writeFileSync(join(cwd, 'gen.txt'), 'gen')

  // Craft the crash site on disk BEFORE booting an instance: a trash entry
  // plus a full-mode cleanup frozen mid-rollback (stale lock), session
  // directory still present — the resumable state a killed process leaves.
  writeFileSync(join(home, 'dsh-session-manager-deleted.json'), `${JSON.stringify({
    version: 1,
    items: [{ id, title: null, deletedAt: NOW, wasArchived: false, purged: false }],
  })}\n`)
  mkdirSync(join(home, 'dsh-session-manager', 'tracking', id, 'snapshots'), { recursive: true })
  writeFileSync(join(home, 'dsh-session-manager', 'tracking', id, 'changes.jsonl'), '')
  writeFileSync(join(home, 'dsh-session-manager', 'tracking', id, 'cleanup.json'), `${JSON.stringify({
    version: 1, sessionId: id, state: 'rolling_back', mode: 'full', requestedAt: NOW, attempts: 1,
    startedAt: Date.now() - 11 * 60 * 1000, results: [], conflicts: [], failures: [],
  })}\n`)

  // Instance A (autoResume off) performs the user's restore decision.
  const restorer = bootWith({ autoResume: false })
  const restored = await call(restorer.dispatch, 'restore', { ids: [id] })
  ok(restored.value.results[0]?.ok === true, 'cancel: restore ok')
  const status = await call(restorer.dispatch, 'cleanupStatus', { ids: [id] })
  ok(status.value.results[0]?.cleanup?.state === 'active', `cancel: pending cleanup cancelled, got ${status.value.results[0]?.cleanup?.state}`)

  // Instance B is a normal restart (autoResume on): the resume pass must now
  // skip the cancelled session entirely.
  const restarted = bootWith({ autoResume: true })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  ok(existsSync(sessionDir(id)), 'cancel: restored session directory untouched by resume')
  ok(existsSync(join(cwd, 'gen.txt')), 'cancel: session resources untouched by resume')
  ok(existsSync(trackingDir(id)), 'cancel: journal kept for the living session')
  removeSessionFromCorpus(id)
}

// --- cleanupStatus / resources / changes on unknown ids behave --------------------
{
  const status = await call(dispatch, 'cleanupStatus', { ids: ['session-never-existed'] })
  ok(status.value.results[0]?.tracked === false && status.value.results[0]?.legacy === true, 'status: unknown id reports untracked legacy')
  ok((await call(dispatch, 'cleanup', {})).error?.code === 'no-ids', 'cleanup: empty batch rejected')
  ok((await call(dispatch, 'changes', {})).error?.code === 'no-ids', 'changes: missing id rejected')
}

// --- open / reveal resources (OS file manager is the only open method) ---------
{
  const { openLog } = await import(new URL('../lifecycle/opener.js', import.meta.url).href)
  const id = 'session-open'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'openable.txt'), 'open me')
  await call(dispatch, 'track', { ids: [id] })

  let result = await call(dispatch, 'openResource', { id, path: 'openable.txt' })
  ok(result.ok === true && result.value.mode === 'reveal', `open: reveal ok, got ${JSON.stringify(result)}`)
  if (process.platform === 'darwin') {
    ok(openLog.some(argv => argv[0] === 'open' && argv[1] === '-R' && argv[2] === join(cwd, 'openable.txt')), 'open: reveal argv is `open -R <abs>`')
  }

  result = await call(dispatch, 'openResource', { id, path: '.' })
  ok(result.ok === true, 'open: workspace root allowed')

  result = await call(dispatch, 'openResource', { id, path: '../outside.txt' })
  ok(result.ok === false && result.error.code === 'unsafe-path', 'open: traversal rejected')
  result = await call(dispatch, 'openResource', { id, path: 'gone.txt' })
  ok(result.ok === false && result.error.code === 'resource-missing', 'open: missing file reported')
  result = await call(dispatch, 'openResource', { id: 'session-never', path: 'x.txt' })
  ok(result.ok === false && result.error.code === 'untracked', 'open: untracked session reported')

  removeSessionFromCorpus(id)
}

// --- audit regressions (red-capable: each targets one audited bug) -------------
{
  // S1: created → deleted by the session → externally recreated must CONFLICT,
  // never be silently removed (the remove branch skipped the check when the
  // expected after-state was null)
  const id = 'session-recreate'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'temp.txt'), 'v1')
  await call(dispatch, 'track', { ids: [id] })
  rmSync(join(cwd, 'temp.txt'))
  await call(dispatch, 'track', { ids: [id] })     // deleted
  writeFileSync(join(cwd, 'temp.txt'), 'external') // recreated AFTER the journal closed
  // residue path: a pending cleanup resumes STRAIGHT into rollback (no final
  // diff to re-attribute the recreation), which is exactly where the old code
  // silently removed it because the expected after-state was null
  writeFileSync(join(trackingDir(id), 'cleanup.json'), `${JSON.stringify({
    version: 1, sessionId: id, state: 'delete_requested', mode: 'rollback-only', requestedAt: NOW, attempts: 0, results: [], conflicts: [], failures: [],
  })}\n`)
  const result = await call(dispatch, 'cleanup', { ids: [id], mode: 'resume' })
  ok(result.value.results[0]?.state === 'rollback_failed', `recreate: conflict instead of silent removal (got ${JSON.stringify(result.value.results[0])})`)
  ok(read(join(cwd, 'temp.txt')) === 'external', 'recreate: externally recreated file NOT deleted')
  removeSessionFromCorpus(id)
}
{
  // S3: trackingExclude must ADD to the defaults, not replace them
  const id = 'session-excludes'
  const cwd = makeSession(id)
  mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(cwd, 'custom-dir'), { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  const custom = bootWith({ trackingExclude: ['custom-dir'] })
  await call(custom.dispatch, 'track', { ids: [id] })
  const baseline = JSON.parse(readFileSync(join(trackingDir(id), 'baseline.json'), 'utf8'))
  ok(baseline.dirs.includes('node_modules') === false, 'excludes: default excludes survive a custom trackingExclude')
  ok(baseline.dirs.includes('custom-dir') === false, 'excludes: custom exclude applied')
  ok(baseline.dirs.includes('src') === true, 'excludes: ordinary dirs tracked')
  removeSessionFromCorpus(id)
  rmSync(trackingDir(id), { recursive: true, force: true })
}
{
  // S5: a session-created file edited again stays session_created (the label
  // must answer "was it in the baseline", not "what was the last action")
  const id = 'session-ownership'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'own.txt'), 'v1')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'own.txt'), 'v2')
  await call(dispatch, 'track', { ids: [id] })
  const changes = await call(dispatch, 'changes', { id })
  const last = changes.value.changes.filter(record => record.resource?.path === 'own.txt').at(-1)
  ok(last?.action === 'modified' && last?.ownership === 'session_created', `ownership: re-edited created file stays session_created (got ${last?.ownership})`)
  removeSessionFromCorpus(id)
  rmSync(trackingDir(id), { recursive: true, force: true })
}
{
  // S4: a file whose content was never snapshotted (oversize) must report
  // snapshot-unavailable, not the misleading snapshot-missing
  const small = bootWith({ trackingMaxSnapshotBytes: 1024 })
  const id = 'session-bigfile'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'big.bin'), 'x'.repeat(8192))
  await call(small.dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'big.bin'), 'y'.repeat(8192))
  await call(small.dispatch, 'track', { ids: [id] })
  const result = await call(small.dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.cleanup?.state === 'rollback_failed', 'bigfile: unrestorable modify is a reported failure')
  const status = await call(small.dispatch, 'cleanupStatus', { ids: [id] })
  const failure = status.value.results[0]?.cleanup?.failures?.find(entry => entry.phase === 'path')
  ok(failure?.reason === 'snapshot-unavailable', `bigfile: reason is snapshot-unavailable (got ${failure?.reason})`)
  removeSessionFromCorpus(id)
  rmSync(trackingDir(id), { recursive: true, force: true })
}
{
  // S7: a crash AFTER a first resume must still remove the right session dir —
  // cleanup.json can hold an already-encoded sessionId, which double-encoding
  // used to turn into a silent "dir not found"
  const rawId = 'session-enc~test'
  const encoded = encodeSegmentForTest(rawId)
  const cwd = makeSessionDir(rawId, encoded)
  mkdirSync(trackingDir(rawId), { recursive: true })
  writeFileSync(join(trackingDir(rawId), 'baseline.json'), `${JSON.stringify({ version: 1, sessionId: encoded, cwd, capturedAt: Date.now(), truncated: false, files: {}, dirs: [] })}\n`)
  writeFileSync(join(trackingDir(rawId), 'cleanup.json'), `${JSON.stringify({
    version: 1, sessionId: encoded, state: 'rolling_back', mode: 'full', requestedAt: NOW, attempts: 1,
    startedAt: Date.now() - 11 * 60 * 1000, results: [], conflicts: [], failures: [],
  })}\n`)
  const restarted = boot()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 600))
  ok(!existsSync(join(sessionsRoot(), encoded)), 'encid: resume removed the encoded session dir')
  ok(!existsSync(trackingDir(rawId)), 'encid: journal destroyed after resume')
  removeSessionFromCorpus(rawId)
}
{
  // decodeSegment round-trips the persistence encoding
  const manage = await import(new URL('../session-manage.js', import.meta.url).href)
  ok(manage.decodeSegment(manage.encodeSegment('a/b~c')) === 'a/b~c', 'encid: decodeSegment round-trips encodeSegment')
}

// ===================== round-2 audit regressions =====================
{
  // H1: session-created DIRECTORIES must actually be removed (rm recursive:false
  // throws EISDIR for any directory on modern Node)
  const id = 'session-dirclean'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  mkdirSync(join(cwd, 'newdir'), { recursive: true })
  writeFileSync(join(cwd, 'newdir', 'inner.txt'), 'inner')
  await call(dispatch, 'track', { ids: [id] })
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.cleanup?.state === 'rollback_verified', `dirclean: cleanup verified (got ${JSON.stringify(result.value.results[0]?.cleanup)})`)
  ok(!existsSync(join(cwd, 'newdir', 'inner.txt')), 'dirclean: file inside the created dir removed')
  ok(!existsSync(join(cwd, 'newdir')), 'dirclean: session-created directory removed')
  removeSessionFromCorpus(id)
}
{
  // H2: cleanup RPC resume with state delete_requested/rolling_back must run the
  // rollback BEFORE destroying the journal
  const id = 'session-resume-first'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'r.txt'), 'v1')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(trackingDir(id), 'cleanup.json'), `${JSON.stringify({
    version: 1, sessionId: id, state: 'delete_requested', mode: 'full', requestedAt: NOW, attempts: 0, results: [], conflicts: [], failures: [],
  })}\n`)
  const result = await call(dispatch, 'cleanup', { ids: [id], mode: 'resume' })
  ok(result.value.results[0]?.ok === true && result.value.results[0]?.state === 'complete', `resume-first: complete (got ${JSON.stringify(result.value.results[0])})`)
  ok(!existsSync(join(cwd, 'r.txt')), 'resume-first: rollback ran before the teardown (file removed)')
  ok(!existsSync(trackingDir(id)), 'resume-first: journal destroyed')
  removeSessionFromCorpus(id)
}
{
  // H3/H4: journal sequence numbers stay unique under concurrency and a torn
  // trailing line never swallows the next record
  const { createChangeJournal } = await import(new URL('../lifecycle/journal.js', import.meta.url).href)
  const jdir = mkdtempSync(join(tmpdir(), 'dsm-journal-'))
  const journal = createChangeJournal(join(jdir, 'changes.jsonl'), null)
  await Promise.all(Array.from({ length: 30 }, (_, index) => journal.append({ marker: index })))
  const records = await journal.readAll()
  const seqs = new Set(records.map(record => record.seq))
  ok(records.length === 30 && seqs.size === 30, `journal: 30 concurrent appends get 30 unique seqs (got ${records.length} records / ${seqs.size} seqs)`)
  writeFileSync(join(jdir, 'changes.jsonl'), `${'x'.repeat(10)}`) // torn line without newline
  await journal.append({ marker: 'after-torn' })
  const after = await journal.readAll()
  ok(after.some(record => record.marker === 'after-torn'), 'journal: a record appended after a torn line survives')
  // seq 缓存必须跨实例共享：storesAtDirectory 每次调用都会新建一个 journal，
  // 各实例若各自缓存 lastSeq，交错写入就会发出重复序号
  {
    const shared = join(jdir, 'shared.jsonl')
    const a = createChangeJournal(shared, null)
    const b = createChangeJournal(shared, null)
    for (let i = 0; i < 40; i += 1) await (i % 2 === 0 ? a : b).append({ marker: i })
    const seqs = (await a.readAll()).map(record => record.seq)
    ok(seqs.length === 40 && new Set(seqs).size === 40, `journal: two instances over one file never duplicate a seq (got ${seqs.length} records / ${new Set(seqs).size} seqs)`)
    ok(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), 'journal: seqs stay strictly increasing across instances')
  }
  rmSync(jdir, { recursive: true, force: true })
}
{
  // H5: download URLs are scrubbed (credentials, signed query tokens)
  const id = 'session-urlscrub'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: "curl 'https://user:pw@files.example.com/data.bin?token=PLAINTOKEN123&ok=1' -o data.bin" })
  writeFileSync(join(cwd, 'data.bin'), 'bytes')
  await call(dispatch, 'track', { ids: [id] })
  const journal = read(join(trackingDir(id), 'changes.jsonl'))
  ok(journal.includes('PLAINTOKEN123') === false && journal.includes('user:pw@') === false, 'urlscrub: URL credentials/tokens never reach the journal')
  const changes = await call(dispatch, 'changes', { id })
  const download = changes.value.changes.find(record => record.resourceType === 'download')
  ok(download?.metadata?.url?.includes('<REDACTED>') === true || download?.metadata?.url?.includes('REDACTED') === true, `urlscrub: sanitized URL recorded (got ${download?.metadata?.url})`)
  removeSessionFromCorpus(id)
}
{
  // H6: background commands are scrubbed before they are journalled (and the
  // cleanup report re-persists them into cleanup.json)
  const id = 'session-cmdscrub'
  makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: 'nohup curl -H "Authorization: Bearer sk-PLAINSECRET42" https://user:pw@api.example.com/job & ' })
  ok(await waitFor(async () => (await peek('changes', { id })).value.total >= 1), 'cmdscrub: spawn journaled')
  const journal = read(join(trackingDir(id), 'changes.jsonl'))
  ok(journal.includes('sk-PLAINSECRET42') === false, 'cmdscrub: bearer token never reaches the journal')
  ok(journal.includes('user:pw@') === false, 'cmdscrub: URL credentials never reach the journal')
  removeSessionFromCorpus(id)
}
{
  // 非 http(s) 方案的 URL 同样携带凭据（postgres://user:pw@host），
  // 只匹配 https?:// 会把数据库/缓存口令原样写进日志
  const { sanitizeCommand } = await import(new URL('../lifecycle/trackers/observe.js', import.meta.url).href)
  const scrubbed = sanitizeCommand('nohup psql postgres://admin:pg-secret@db.internal:5432/app &')
  ok(scrubbed.includes('pg-secret') === false, `cmdscrub: a postgres:// credential is redacted (got ${scrubbed})`)
  ok(scrubbed.includes('admin') === false, `cmdscrub: the postgres:// username is stripped too (got ${scrubbed})`)
  const redis = sanitizeCommand('redis-cli -u redis://default:r3dis-pw@cache.internal:6379 ping')
  ok(redis.includes('r3dis-pw') === false, `cmdscrub: a redis:// credential is redacted (got ${redis})`)
  const signed = sanitizeCommand('curl https://x.example.com/f?X-Amz-Signature=abc123 -o out.bin')
  ok(signed.includes('abc123') === false, `cmdscrub: a non-listed signed query param is still scrubbed by name (got ${signed})`)
}
{
  // M1: journal-supplied hashes are validated (no snapshot-store path escape)
  const { createSnapshotStore } = await import(new URL('../lifecycle/snapshots.js', import.meta.url).href)
  const sdir = mkdtempSync(join(tmpdir(), 'dsm-snap-'))
  const store = createSnapshotStore(join(sdir, 'snapshots'))
  const escaped = join(sdir, 'escape-target')
  writeFileSync(escaped, 'host file content')
  ok((await store.get('../escape-target')) === null, 'snap: non-hash lookup returns null (no path escape)')
  ok((await store.has('../escape-target')) === false, 'snap: non-hash probe is false')
  rmSync(sdir, { recursive: true, force: true })
}
{
  // M3: a permission-only change is actually restored by cleanup
  const id = 'session-chmod'
  const cwd = makeSession(id)
  const target = join(cwd, 'perm.txt')
  writeFileSync(target, 'same')
  await call(dispatch, 'track', { ids: [id] })
  const baselineMode = statSync(target).mode
  chmodSync(target, 0o600)
  await call(dispatch, 'track', { ids: [id] })
  await call(dispatch, 'delete', { ids: [id] })
  ok(statSync(target).mode === baselineMode, `chmod: permission restored (got ${statSync(target).mode.toString(8)} vs ${baselineMode.toString(8)})`)
  removeSessionFromCorpus(id)
}
{
  // M4: the EXPLICIT cleanup RPC works even with autoCleanup:false
  const noAuto = bootWith({ autoCleanup: false })
  const id = 'session-explicitclean'
  const cwd = makeSession(id)
  await call(noAuto.dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'e.txt'), 'v')
  await call(noAuto.dispatch, 'track', { ids: [id] })
  const deleted = await call(noAuto.dispatch, 'delete', { ids: [id] })
  ok(deleted.value.results[0]?.cleanup?.skipped === 'tracking-disabled', 'explicitclean: automatic cleanup stays off for delete')
  const result = await call(noAuto.dispatch, 'cleanup', { ids: [id], mode: 'full' })
  ok(result.value.results[0]?.ok === true, `explicitclean: explicit cleanup still runs (got ${JSON.stringify(result.value.results[0])})`)
  ok(!existsSync(join(cwd, 'e.txt')), 'explicitclean: rollback executed')
  removeSessionFromCorpus(id)
}
{
  // M9: an archive failure must not leave the session hidden in the trash
  const id = 'session-archivefail'
  const cwd = makeSession(id)
  archiveFailIds.add(id)
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === false && result.value.results[0]?.error === 'archive-failed', `archivefail: failure reported (got ${JSON.stringify(result.value.results[0])})`)
  const list = await call(dispatch, 'list', { view: 'all' })
  ok(list.value.rows.some(row => row.id === id), 'archivefail: session still visible (trash entry rolled back)')
  archiveFailIds.delete(id)
  removeSessionFromCorpus(id)
}
{
  // M12: env parsing — child-scoped prefixes are not persistent, multiple
  // assignments and quoted separators are handled
  const id = 'session-envparse'
  makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: 'FOO_CHILD=bar npm test' })
  await app.toolCall(id, 'bash', { command: 'export AA_MULTI=1 BB_MULTI=2' })
  await app.toolCall(id, 'bash', { command: 'export CC_QUOTED="x;y"' })
  ok(await waitFor(async () => (await peek('changes', { id })).value.total >= 3), 'envparse: records journaled')
  const changes = await call(dispatch, 'changes', { id })
  const names = changes.value.changes.filter(record => record.resourceType === 'environment_variable').map(record => record.resource.name)
  ok(names.includes('FOO_CHILD') === false, 'envparse: child-scoped prefix is not a persistent env change')
  ok(names.includes('AA_MULTI') && names.includes('BB_MULTI'), `envparse: multiple assignments on one export line (got ${JSON.stringify(names)})`)
  const cc = changes.value.changes.find(record => record.resource?.name === 'CC_QUOTED')
  ok(cc !== undefined && cc.resource?.name === 'CC_QUOTED', 'envparse: quoted value with a separator stays one assignment')
  removeSessionFromCorpus(id)
}
{
  // M13: the process classifier must not fire on URL '&' or '&&'
  const id = 'session-procregex'
  makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: "curl 'http://x.example/?a=1&'" })
  await app.toolCall(id, 'bash', { command: 'make && echo done' })
  await app.toolCall(id, 'bash', { command: 'sleep 1 &\necho done' })
  ok(await waitFor(async () => (await peek('changes', { id })).value.total >= 1), 'procregex: the background line is journaled')
  const changes = await call(dispatch, 'changes', { id })
  const spawns = changes.value.changes.filter(record => record.resourceType === 'process')
  ok(spawns.length === 1, `procregex: exactly one spawn recorded (got ${spawns.length})`)
  ok(spawns[0]?.resource?.command?.startsWith('sleep 1') === true, 'procregex: the spawn is the backgrounded command')
  removeSessionFromCorpus(id)
}
{
  // M14: the download intent attaches to the hinted target file
  const id = 'session-dlhint'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  await app.toolCall(id, 'bash', { command: 'curl -o real.bin https://files.example.com/real.bin' })
  for (const name of ['decoy1.txt', 'decoy2.txt', 'decoy3.txt', 'decoy4.txt']) writeFileSync(join(cwd, name), 'decoy')
  writeFileSync(join(cwd, 'real.bin'), 'real')
  await call(dispatch, 'track', { ids: [id] })
  const changes = await call(dispatch, 'changes', { id })
  const download = changes.value.changes.find(record => record.resourceType === 'download')
  ok(download?.resource?.path === 'real.bin', `dlhint: intent attaches to the hinted target (got ${download?.resource?.path})`)
  removeSessionFromCorpus(id)
}
{
  // M15: pnpm-style symlinked packages are tracked and their removal unlinks
  // only the symlink
  const id = 'session-symlinkdep'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] }) // baseline: nothing installed yet
  const store = join(home, 'store', 'axios')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'axios', version: '1.0.0' }))
  mkdirSync(join(cwd, 'node_modules'), { recursive: true })
  symlinkSync(store, join(cwd, 'node_modules', 'axios'))
  await call(dispatch, 'track', { ids: [id] })
  const changes = await call(dispatch, 'changes', { id })
  ok(changes.value.changes.some(record => record.resourceType === 'dependency' && record.action === 'installed' && record.resource.package === 'axios'), 'symlinkdep: symlinked package tracked as installed')
  await call(dispatch, 'delete', { ids: [id] })
  ok(!existsSync(join(cwd, 'node_modules', 'axios')), 'symlinkdep: symlink removed')
  ok(existsSync(store) && existsSync(join(store, 'package.json')), 'symlinkdep: the link target is untouched')
  removeSessionFromCorpus(id)
}
{
  // M19: a session whose header carries no cwd stays untracked (legacy path)
  const id = 'session-nocwd'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'user.txt'), 'mine')
  noCwdIds.add(id)
  await call(dispatch, 'track', { ids: [id] })
  ok(!existsSync(trackingDir(id)), 'nocwd: no baseline without a cwd')
  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.cleanup?.skipped === 'legacy-untracked', 'nocwd: delete reports legacy-untracked')
  ok(existsSync(join(cwd, 'user.txt')), 'nocwd: workspace untouched')
  noCwdIds.delete(id)
  removeSessionFromCorpus(id)
}

{
  // M6: concurrent tracking passes must not double-journal the same change
  const id = 'session-diffmutex'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'base.txt'), 'v1')
  await call(dispatch, 'track', { ids: [id] })   // baseline
  writeFileSync(join(cwd, 'base.txt'), 'v2')      // the change every pass will see
  await Promise.all([
    peek('track', { ids: [id] }),
    peek('track', { ids: [id] }),
    peek('track', { ids: [id] }),
    peek('track', { ids: [id] }),
  ])
  const changes = await call(dispatch, 'changes', { id })
  const modified = changes.value.changes.filter(record => record.resource?.path === 'base.txt' && record.action === 'modified')
  ok(modified.length === 1, `diffmutex: exactly one modified record for the path (got ${modified.length})`)
  removeSessionFromCorpus(id)
  rmSync(trackingDir(id), { recursive: true, force: true })
}

{
  // R3-DEADLOCK: once the baseline fills the hash budget (trackingMaxFiles),
  // every file the session creates AFTER that must still be tracked — the old
  // walk cap silently hid all post-baseline files from every diff
  const small = bootWith({ trackingMaxFiles: 3 })
  const id = 'session-fullbudget'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'p1.txt'), 'p1')
  writeFileSync(join(cwd, 'p2.txt'), 'p2')
  writeFileSync(join(cwd, 'p3.txt'), 'p3')
  writeFileSync(join(cwd, 'p4.txt'), 'p4')
  await call(small.dispatch, 'track', { ids: [id] })   // baseline: 3 hashed, 1 hash-less, TRUNCATED
  const bl = JSON.parse(readFileSync(join(trackingDir(id), 'baseline.json'), 'utf8'))
  ok(bl.truncated === true, `fullbudget: baseline reports the hash budget as exhausted (got truncated=${bl.truncated})`)
  ok(Object.values(bl.files).filter(entry => entry.sha256 === null).length === 1, 'fullbudget: exactly one file beyond the hash budget (existence recorded, no hash)')
  writeFileSync(join(cwd, 'new.txt'), 'new')
  writeFileSync(join(cwd, 'p1.txt'), 'p1-modified')
  await call(small.dispatch, 'track', { ids: [id] })
  const changes = await call(small.dispatch, 'changes', { id })
  ok(changes.value.changes.some(record => record.resource?.path === 'new.txt' && record.action === 'created'), 'fullbudget: post-budget creation IS journaled')
  ok(changes.value.changes.some(record => record.resource?.path === 'p1.txt' && record.action === 'modified'), 'fullbudget: post-budget modification IS journaled')
  const result = await call(small.dispatch, 'delete', { ids: [id] })
  ok(!existsSync(join(cwd, 'new.txt')), 'fullbudget: session-created file removed by delete')
  ok(existsSync(join(cwd, 'p1.txt')), 'fullbudget: pre-existing modified file kept (restored or preserved)')
  ok(existsSync(join(cwd, 'p2.txt')) && existsSync(join(cwd, 'p3.txt')) && existsSync(join(cwd, 'p4.txt')), 'fullbudget: other pre-existing files kept')
  removeSessionFromCorpus(id)
  rmSync(trackingDir(id), { recursive: true, force: true })
}

{
  // deleteResources: selected files go to the TRASH (recoverable), never
  // destroyed in place
  const id = 'session-trash'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 't.txt'), 'trash me')
  writeFileSync(join(cwd, 'u.txt'), 'keep me')
  await call(dispatch, 'track', { ids: [id] })
  const result = await call(dispatch, 'deleteResources', { id, paths: ['t.txt'] })
  ok(result.value.results[0]?.ok === true, `trash: RPC ok (got ${JSON.stringify(result.value.results[0])})`)
  ok(!existsSync(join(cwd, 't.txt')), 'trash: file gone from the workspace')
  const trashTarget = join(process.env.DSH_SM_TRASH_DIR, 't.txt')
  ok(existsSync(trashTarget) && readFileSync(trashTarget, 'utf8') === 'trash me', 'trash: file INTACT inside the wastebasket')
  ok(existsSync(join(cwd, 'u.txt')), 'trash: unselected file untouched')
  // guards: traversal and missing files
  const bad = await call(dispatch, 'deleteResources', { id, paths: ['../escape.txt'] })
  ok(bad.value.results[0]?.ok === false && bad.value.results[0]?.error?.code === 'unsafe-path', 'trash: traversal rejected')
  const missing = await call(dispatch, 'deleteResources', { id, paths: ['nope.txt'] })
  ok(missing.value.results[0]?.ok === false && missing.value.results[0]?.error?.code === 'resource-missing', 'trash: missing file rejected')
  // batch: two paths in one call
  writeFileSync(join(cwd, 'b1.txt'), 'b1')
  writeFileSync(join(cwd, 'b2.txt'), 'b2')
  const batch = await call(dispatch, 'deleteResources', { id, paths: ['b1.txt', 'b2.txt'] })
  ok(batch.value.results.filter(entry => entry.ok === true).length === 2, 'trash: batch of two trashed')
  ok(!existsSync(join(cwd, 'b1.txt')) && !existsSync(join(cwd, 'b2.txt')), 'trash: both gone from the workspace')
  removeSessionFromCorpus(id)
}

{
  // 插件内回收站：删除 = 双写（插件回收站 + 系统废纸篓），恢复 = 从回收站还原
  const id = 'session-bin'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'orig.txt'), 'bin-content-42')
  mkdirSync(join(cwd, 'mydir'), { recursive: true })
  writeFileSync(join(cwd, 'mydir', 'x.txt'), 'inner-x')
  await call(dispatch, 'track', { ids: [id] })
  const result = await call(dispatch, 'deleteResources', { id, paths: ['orig.txt', 'mydir'] })
  ok(result.value.results.every(entry => entry.ok === true), `bin: both trashed (got ${JSON.stringify(result.value.results)})`)
  ok(!existsSync(join(cwd, 'orig.txt')) && !existsSync(join(cwd, 'mydir')), 'bin: gone from the workspace')
  // 双写之插件内回收站：内容 + 元数据完好
  const binDir = join(home, 'dsh-session-manager', 'recycle')
  const entries = JSON.parse(readFileSync(join(binDir, 'index.json'), 'utf8')).entries
  const sessionEntries = entries.filter(entry => entry.sessionId === id)
  ok(sessionEntries.length === 2, `bin: index has 2 entries for this session (got ${sessionEntries.length})`)
  const fileEntry = sessionEntries.find(entry => entry.originalPath === 'orig.txt')
  ok(fileEntry !== undefined && fileEntry.sessionId === id, 'bin: entry records session + original path')
  ok(readFileSync(join(binDir, fileEntry.entryId, 'payload', 'orig.txt'), 'utf8') === 'bin-content-42', 'bin: file content preserved')
  // RPC：列表按会话过滤
  const list = await call(dispatch, 'recycleList', { id })
  ok(list.value.entries.length === 2, `bin: recycleList returns the session's entries (got ${list.value.entries.length})`)
  // 恢复：从插件回收站还原到原位，系统废纸篓副本清除
  writeFileSync(join(process.env.DSH_SM_TRASH_DIR, 't.txt'), 'os copy') // 走 rename 时 trashPath 可知
  const restored = await call(dispatch, 'recycleRestore', { entryId: fileEntry.entryId })
  ok(restored.ok === true && restored.value?.entryId === fileEntry.entryId, `bin: restore ok (got ${JSON.stringify(restored)})`)
  ok(readFileSync(join(cwd, 'orig.txt'), 'utf8') === 'bin-content-42', 'bin: file restored to the original position with original content')
  ok(existsSync(join(process.env.DSH_SM_TRASH_DIR, 'orig.txt')) === false, 'bin: OS-trash copy of orig.txt removed on restore')
  ok(JSON.parse(readFileSync(join(binDir, 'index.json'), 'utf8')).entries.filter(entry => entry.sessionId === id).length === 1, 'bin: restored entry consumed from the index (dir entry remains)')
  // 目录条目恢复
  const dirEntry = entries.find(entry => entry.originalPath === 'mydir')
  const dirRestored = await call(dispatch, 'recycleRestore', { entryId: dirEntry.entryId })
  ok(dirRestored.ok === true, `bin: directory restore ok (got ${JSON.stringify(dirRestored)})`)
  ok(readFileSync(join(cwd, 'mydir', 'x.txt'), 'utf8') === 'inner-x', 'bin: directory entry restored as a tree')
  // 目标已存在 → 不覆盖
  writeFileSync(join(cwd, 'orig.txt'), 'user data now')
  mkdirSync(join(binDir, fileEntry.entryId, 'payload'), { recursive: true })
  writeFileSync(join(binDir, fileEntry.entryId, 'payload', 'orig.txt'), 'bin-content-42')
  writeFileSync(join(binDir, 'index.json'), JSON.stringify({ entries: [fileEntry] }))
  const conflict = await call(dispatch, 'recycleRestore', { entryId: fileEntry.entryId })
  ok(conflict.ok === false && conflict.error?.code === 'target-exists', `bin: restore refuses to overwrite an existing target (got ${JSON.stringify(conflict)})`)
  ok(readFileSync(join(cwd, 'orig.txt'), 'utf8') === 'user data now', 'bin: existing target untouched')
  // entryId 穿越
  const evil = await call(dispatch, 'recycleRestore', { entryId: '../evil' })
  ok(evil.ok === false, 'bin: entryId traversal rejected')

  // 索引里的 originalPath 是磁盘上的不可信输入：恢复时不得写出工作区之外
  {
    const outside = JSON.parse(JSON.stringify(fileEntry))
    outside.originalPath = '../escaped.txt'
    mkdirSync(join(binDir, outside.entryId), { recursive: true })
    writeFileSync(join(binDir, outside.entryId, 'meta.json'), JSON.stringify(outside))
    writeFileSync(join(binDir, 'index.json'), JSON.stringify({ entries: [outside] }))
    const escaped = await call(dispatch, 'recycleRestore', { entryId: outside.entryId })
    ok(escaped.ok === false && escaped.error?.code === 'unsafe-path', `bin: index path escaping the workspace is rejected (got ${JSON.stringify(escaped.error)})`)
    ok(!existsSync(join(homedir(), 'escaped.txt')) && !existsSync(join(home, 'escaped.txt')), 'bin: nothing written outside the workspace')
  }

  // 内容损坏：必须在写盘之前校验，否则工作区会留下损坏文件且重试被 target-exists 卡死
  {
    const corrupted = JSON.parse(JSON.stringify(fileEntry))
    corrupted.originalPath = 'corrupt-target.txt'
    corrupted.name = 'corrupt-target.txt'
    corrupted.sha256 = sha256Hex('the original bytes')
    mkdirSync(join(binDir, corrupted.entryId, 'payload'), { recursive: true })
    writeFileSync(join(binDir, corrupted.entryId, 'payload', corrupted.name), 'TAMPERED BYTES')
    writeFileSync(join(binDir, 'index.json'), JSON.stringify({ entries: [corrupted] }))
    const bad = await call(dispatch, 'recycleRestore', { entryId: corrupted.entryId })
    ok(bad.ok === false && bad.error?.code === 'bin-corrupted', `bin: corrupted payload refused (got ${JSON.stringify(bad.error)})`)
    ok(!existsSync(join(cwd, 'corrupt-target.txt')), 'bin: corrupted payload never reaches the workspace')
    // 条目保留，修好内容后仍可恢复（不会被 target-exists 卡死）
    writeFileSync(join(binDir, corrupted.entryId, 'payload', corrupted.name), 'the original bytes')
    const retry = await call(dispatch, 'recycleRestore', { entryId: corrupted.entryId })
    ok(retry.ok === true && readFileSync(join(cwd, 'corrupt-target.txt'), 'utf8') === 'the original bytes', `bin: retry after repair succeeds (got ${JSON.stringify(retry.error ?? retry.value?.entryId)})`)
  }

  // 并发索引写入不得丢条目（读-改-写必须串行）
  {
    writeFileSync(join(cwd, 'c1.txt'), 'c1')
    writeFileSync(join(cwd, 'c2.txt'), 'c2')
    writeFileSync(join(cwd, 'c3.txt'), 'c3')
    const [r1, r2, r3] = await Promise.all([
      call(dispatch, 'deleteResources', { id, paths: ['c1.txt'] }),
      call(dispatch, 'deleteResources', { id, paths: ['c2.txt'] }),
      call(dispatch, 'deleteResources', { id, paths: ['c3.txt'] }),
    ])
    ok([r1, r2, r3].every(result => result.value.results[0]?.ok === true), 'bin: concurrent deletes all succeed')
    const ids = [r1, r2, r3].map(result => result.value.results[0].entryId)
    const index = JSON.parse(readFileSync(join(binDir, 'index.json'), 'utf8')).entries
    ok(ids.every(entryId => index.some(entry => entry.entryId === entryId)), `bin: no concurrent index update is lost (index has ${index.length}, need 3)`)
  }

  removeSessionFromCorpus(id)
}

{
  // 用户在资源页删除文件后：资源视图不再把它当普通资源（status=trashed），
  // 下次 diff 不重复记录；从回收站恢复后行回归；会话清理不复活用户主动删除的内容
  const id = 'session-usrtrash'
  const cwd = makeSession(id)
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'usr.txt'), 'user deleted me')
  await call(dispatch, 'track', { ids: [id] })

  let resources = await call(dispatch, 'resources', { id })
  let row = resources.value.resources.find(entry => entry.identifier === 'usr.txt')
  ok(row !== undefined && row.status !== 'trashed', `usertrash: file starts as an ordinary resource (got ${row?.status})`)

  const del = await call(dispatch, 'deleteResources', { id, paths: ['usr.txt'] })
  const entryId = del.value.results[0]?.entryId
  ok(del.value.results[0]?.ok === true, 'usertrash: file moved to the bin')
  ok(!existsSync(join(cwd, 'usr.txt')), 'usertrash: gone from the workspace')

  resources = await call(dispatch, 'resources', { id })
  row = resources.value.resources.find(entry => entry.identifier === 'usr.txt')
  ok(row !== undefined && row.status === 'trashed', `usertrash: view reports it as trashed (got ${row?.status})`)
  ok(row.trashed === true && row.binEntryId === entryId, 'usertrash: row carries the trashed flag + bin entry id')

  // tracker 已遗忘该路径 → 下次 diff 不会把这个删除再记一次
  const changesBefore = (await call(dispatch, 'changes', { id })).value.total
  await call(dispatch, 'track', { ids: [id] })
  const changesAfter = (await call(dispatch, 'changes', { id })).value.total
  ok(changesAfter === changesBefore, `usertrash: the next diff does not journal the removal twice (${changesBefore} → ${changesAfter})`)

  // 恢复 → 文件回到原位 + 行不再标记为 trashed（不靠 diff：文件真的回到磁盘上）
  await call(dispatch, 'recycleRestore', { entryId })
  resources = await call(dispatch, 'resources', { id })
  row = resources.value.resources.find(entry => entry.identifier === 'usr.txt')
  ok(row !== undefined && row.status !== 'trashed', `usertrash: restoring revives the resource row (got ${row?.status})`)
  ok(readFileSync(join(cwd, 'usr.txt'), 'utf8') === 'user deleted me', 'usertrash: content restored to the original path')

  // 用户再删一次，然后触发会话清理：cleanup 不得复活用户主动删除的文件
  await call(dispatch, 'deleteResources', { id, paths: ['usr.txt'] })
  ok(!existsSync(join(cwd, 'usr.txt')), 'usertrash: file trashed again before cleanup')
  const cleanup = await call(dispatch, 'cleanup', { ids: [id], mode: 'rollback-only' })
  ok(cleanup.value.results[0]?.ok === true, 'usertrash: cleanup ok')
  ok(!existsSync(join(cwd, 'usr.txt')), 'usertrash: cleanup did NOT resurrect the user-trashed file')
  const trashed = cleanup.value.results[0]?.actions?.find(action => action.reason === 'user-trashed')
  ok(trashed !== undefined && trashed.outcome === 'skipped', 'usertrash: cleanup reports the path as a preserved user-trashed skip')

  removeSessionFromCorpus(id)
}

{
  // 删除整个目录树：子路径也必须标记为 trashed，否则它们会当成普通资源
  // 继续显示，且下一次 diff 会把它们重新记成普通删除
  const id = 'session-treetrash'
  const cwd = makeSession(id)
  // baseline first: tree/base.txt is a pre-existing file, everything created
  // afterwards belongs to the session
  mkdirSync(join(cwd, 'tree'), { recursive: true })
  writeFileSync(join(cwd, 'tree', 'base.txt'), 'baseline content')
  await call(dispatch, 'track', { ids: [id] })
  mkdirSync(join(cwd, 'tree', 'sub'), { recursive: true })
  writeFileSync(join(cwd, 'tree', 'new.txt'), 'session created')
  writeFileSync(join(cwd, 'tree', 'sub', 'deep.txt'), 'nested created')
  await call(dispatch, 'track', { ids: [id] })

  let rows = (await call(dispatch, 'resources', { id })).value.resources
  ok(['tree/new.txt', 'tree/sub', 'tree/sub/deep.txt'].every(path => rows.some(entry => entry.identifier === path)), `treetrash: the session-created tree is tracked as resources (got ${rows.map(entry => entry.identifier).join(', ')})`)
  ok(rows.find(entry => entry.identifier === 'tree/sub/deep.txt')?.status !== 'trashed', 'treetrash: nested file starts as an ordinary resource')

  const del = await call(dispatch, 'deleteResources', { id, paths: ['tree'] })
  ok(del.value.results[0]?.ok === true, `treetrash: directory trashed (got ${JSON.stringify(del.value.results[0]?.error)})`)
  ok(!existsSync(join(cwd, 'tree')), 'treetrash: the whole directory is gone from the workspace')

  rows = (await call(dispatch, 'resources', { id })).value.resources
  for (const path of ['tree/new.txt', 'tree/sub', 'tree/sub/deep.txt']) {
    const entry = rows.find(candidate => candidate.identifier === path)
    ok(entry !== undefined && entry.status === 'trashed', `treetrash: ${path} reads as trashed (got ${entry?.status})`)
    ok(entry.trashed === true, `treetrash: ${path} carries the trashed flag so the view hides it`)
  }

  // 下次 diff 不得把树里的路径重新记成普通删除
  const before = (await call(dispatch, 'changes', { id })).value.total
  await call(dispatch, 'track', { ids: [id] })
  const after = (await call(dispatch, 'changes', { id })).value.total
  ok(after === before, `treetrash: the next diff does not re-journal the tree (${before} → ${after})`)

  // 清理同样不得复活这棵树
  const cleanup = await call(dispatch, 'cleanup', { ids: [id], mode: 'rollback-only' })
  ok(cleanup.value.results[0]?.ok === true, 'treetrash: cleanup ok')
  ok(!existsSync(join(cwd, 'tree')), 'treetrash: cleanup did NOT resurrect the trashed tree')
  ok(!existsSync(join(cwd, 'tree', 'base.txt')), 'treetrash: the baseline file inside the tree stays in the bin (not restored)')

  removeSessionFromCorpus(id)
}

// --- OS 废纸篓 helper：成败以结果判定（helper 退出码不可信） -----------------------
{
  const { createTrash } = await import(new URL('../lifecycle/trash.js', import.meta.url).href)
  const helperDir = join(home, 'fake-helpers')
  mkdirSync(helperDir, { recursive: true })
  const fakePowerShell = join(helperDir, 'powershell.exe')
  const savedMode = process.env.DSH_SM_OPEN_MODE
  const savedPath = process.env.PATH
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    delete process.env.DSH_SM_OPEN_MODE // 要真的 spawn，而不是记录模式
    process.env.PATH = `${helperDir}:${savedPath}`
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const victim = join(home, 'helper-victim.txt')

    // 1) helper 静默失败（退出码 0，但文件没动）→ 必须报错，不能谎报成功
    writeFileSync(fakePowerShell, '#!/bin/sh\nexit 0\n')
    chmodSync(fakePowerShell, 0o755)
    writeFileSync(victim, 'still here')
    let failure = null
    try {
      await createTrash().moveToTrash(victim)
    } catch (error) {
      failure = error
    }
    ok(failure?.code === 'trash-failed', `os trash: a helper that leaves the file in place reports failure, not success (got ${failure?.code ?? 'success'})`)
    ok(existsSync(victim), 'os trash: the untouched file is still on disk')

    // 2) helper 真的移走文件 → 必须判成功（结果校验不能误杀正常路径）
    writeFileSync(fakePowerShell, `#!/bin/sh\nrm -f ${JSON.stringify(victim)}\n`)
    chmodSync(fakePowerShell, 0o755)
    const moved = await createTrash().moveToTrash(victim)
    ok(moved?.via === 'recycle-bin', `os trash: a helper that really moves the file still reports success (got ${moved?.via ?? 'n/a'})`)
    ok(!existsSync(victim), 'os trash: the moved file is gone from the workspace')
  } finally {
    if (savedPlatform !== undefined) Object.defineProperty(process, 'platform', savedPlatform)
    process.env.PATH = savedPath
    if (savedMode === undefined) delete process.env.DSH_SM_OPEN_MODE
    else process.env.DSH_SM_OPEN_MODE = savedMode
  }
}

// --- dispose -----------------------------------------------------------------------
// exercise the real unload path (store flush + timer teardown) on every instance
for (const app of allApps) {
  for (const disposer of app.disposers ?? []) {
    await (typeof disposer === 'function' ? disposer() : undefined)
  }
}

rmSync(home, { recursive: true, force: true })
console.log(`LIFECYCLE OK — ${checks} checks passed`)
