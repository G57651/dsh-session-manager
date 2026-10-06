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
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// never pop real Finder/Explorer windows during the smoke run
process.env.DSH_SM_OPEN_MODE = 'log'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'dsm-life-'))
process.env.DSH_HOME = home

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

// --- dispose -----------------------------------------------------------------------
// exercise the real unload path (store flush + timer teardown) on every instance
for (const app of allApps) {
  for (const disposer of app.disposers ?? []) {
    await (typeof disposer === 'function' ? disposer() : undefined)
  }
}

rmSync(home, { recursive: true, force: true })
console.log(`LIFECYCLE OK — ${checks} checks passed`)
