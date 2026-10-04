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
//   Case 6  env var created               → cleanup unsets it
//   Case 7  env var modified (+secret)    → cleanup restores / reports conflict
//   Case 8  crash mid-cleanup             → restart resumes and finishes
//   Case 9  cleanup run twice             → idempotent, no damage
//   Case 10 external conflict             → detected, not silently overwritten;
//                                           force mode overwrites explicitly
//
// Plus: download attribution, move/rename, resources/changes/cleanupStatus
// views, legacy (untracked) session behavior, restore-cancels-pending-cleanup.
//
// Run: node scripts/smoke-lifecycle.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const services = {
  sessionController: { list: async () => ({ items: [] }) },
  sessionQuery: {
    listSessions: async () => headers().map(header => ({ header, live: true, persisted: true })),
    readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: { version: 4, id, createdAt: NOW } } })),
  },
  sessionPersistence: { list: async () => headers().map(header => ({ header, revision: 'r1', sizeBytes: 100, eventCount: 1 })) },
  workspaceRegistry: {
    get archivedSessionIds() { return [...workspace.archived] },
    archiveSession: async (id, options) => {
      if (!workspaces.has(id)) throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' })
      workspace.archived.add(id)
      if (options?.stopActivity === true) workspace.stopped.push(id)
    },
    unarchiveSession: async (id) => { workspace.archived.delete(id) },
  },
}

function bootWith(configOverrides = {}) {
  const eventListeners = {}
  const captured = {}
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: (name, listener) => { (eventListeners[name] ??= []).push(listener); return () => {} },
    effect: (execute) => execute(),
    get: name => services[name],
    connection: { rpc: { handle: (channel, dispatch) => { captured.dispatch = dispatch; return () => {} } } },
  }
  const config = hostModule.Config(configOverrides)
  hostModule.apply(ctx, config)
  return {
    dispatch: captured.dispatch,
    emit(sessionId, event) {
      for (const listener of eventListeners['session/event'] ?? []) listener({ id: sessionId }, event)
    },
    async toolCall(sessionId, name, args) {
      this.emit(sessionId, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify(args) }, time: Date.now() })
    },
    async toolResult(sessionId) {
      this.emit(sessionId, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'toolResult', content: [] } }, time: Date.now() })
    },
  }
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
const trackingDir = id => join(home, 'dsh-session-manager', 'tracking', id)

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
const manage = await import(new URL('../session-manage.js', import.meta.url)).then(m => m)

const app = boot()
const dispatch = app.dispatch

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
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'B')
  await call(dispatch, 'track', { ids: [id] })

  const resources = await call(dispatch, 'resources', { id })
  const configRow = resources.value.resources.find(row => row.identifier === 'config.json')
  ok(configRow?.ownership === 'session_modified', `case2: modify stamped session_modified, got ${configRow?.ownership}`)

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case2: delete ok')
  ok(read(join(cwd, 'config.json')) === 'A', `case2: config.json restored to A, got ${JSON.stringify(read(join(cwd, 'config.json')))}`)
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
  ok(existsSync(join(cwd, 'node_modules')), 'case4: node_modules root itself survives (it held pre-existing nothing, but the dir entry is session-created → may be pruned; presence is acceptable)')
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

  const resources = await call(dispatch, 'resources', { id })
  ok(resources.value.resources.some(row => row.resourceType === 'dependency' && row.ownership === 'preexisting'), 'case5: baseline dependency appears as preexisting (via baseline deps row)')
  // (the dep view derives from journal records; with none, the package stays untouched — the real assertion is below)

  await call(dispatch, 'delete', { ids: [id] })
  ok(existsSync(join(cwd, 'node_modules', 'axios')), 'case5: pre-existing axios still installed after cleanup')
  ok(read(join(cwd, 'package.json')).includes('axios'), 'case5: package.json still declares axios')
  removeSessionFromCorpus(id)
}

// --- Case 6: env var created → unset on cleanup --------------------------------
{
  const id = 'session-case6'
  makeSession(id)
  delete process.env.DSM_LIFE_FOO
  await call(dispatch, 'track', { ids: [id] })

  await app.toolCall(id, 'bash', { command: 'export DSM_LIFE_FOO=123' })
  ok(await waitFor(async () => 'DSM_LIFE_FOO' in process.env && (await call(dispatch, 'changes', { id })).value.total >= 1), 'case6: env applied at record time and journaled')
  const changes = await call(dispatch, 'changes', { id })
  const setRecord = changes.value.changes.find(record => record.resourceType === 'environment_variable')
  ok(setRecord?.action === 'set' && setRecord.before === null && setRecord.after?.value === '123', 'case6: set journaled with before=null')

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case6: delete ok')
  ok(!('DSM_LIFE_FOO' in process.env), 'case6: session-created env var unset by cleanup')
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
  ok(await waitFor(async () => (await call(dispatch, 'changes', { id })).value.total >= 2), 'case7: both env mutations journaled')
  const changes = await call(dispatch, 'changes', { id })
  const barRecord = changes.value.changes.find(record => record.resource?.name === 'DSM_LIFE_BAR')
  const tokenRecord = changes.value.changes.find(record => record.resource?.name === 'DSM_LIFE_TOKEN')
  ok(barRecord?.before?.value === 'old' && barRecord.after?.value === 'new', 'case7: non-secret values journalled in plaintext')
  ok(tokenRecord?.before?.redacted === true && tokenRecord.before.value === undefined && tokenRecord.before.hash !== undefined, 'case7: secret value redacted, existence+fingerprint kept')

  const result = await call(dispatch, 'delete', { ids: [id] })
  ok(result.value.results[0]?.ok === true, 'case7: delete ok')
  ok(process.env.DSM_LIFE_BAR === 'old', `case7: non-secret env restored to old, got ${process.env.DSM_LIFE_BAR}`)
  // the secret's plaintext was never journalled (requirement §十四), so its
  // rollback cannot be automated: cleanup records the conflict and leaves the
  // decision to the user instead of guessing (safe mode)
  ok(process.env.DSM_LIFE_TOKEN === 'sekrit-new', 'case7: secret var untouched by automated rollback')
  const status = await call(dispatch, 'cleanupStatus', { ids: [id] })
  const tokenConflict = status.value.results[0]?.cleanup?.conflicts?.find(conflict => conflict.phase === 'env' && conflict.name === 'DSM_LIFE_TOKEN')
  ok(tokenConflict?.reason?.startsWith('secret-unrecoverable'), 'case7: secret-unrecoverable conflict recorded')
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
  await restarted.dispatch('__warmup__', {}).catch(() => {}) // no-op; bootstrap ran inside apply()
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

// --- Case 10: external conflict → detected, not silently overwritten -----------
{
  const id = 'session-case10'
  const cwd = makeSession(id)
  writeFileSync(join(cwd, 'config.json'), 'A')
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'B') // session's change
  await call(dispatch, 'track', { ids: [id] })
  writeFileSync(join(cwd, 'config.json'), 'C') // someone else's later change

  const result = await call(dispatch, 'delete', { ids: [id] })
  const summary = result.value.results[0]?.cleanup
  ok(summary?.ok === false && summary.state === 'rollback_failed', `case10: cleanup reported failure, got ${JSON.stringify(summary)}`)
  ok(summary?.conflicts >= 1, 'case10: conflict recorded')
  ok(read(join(cwd, 'config.json')) === 'C', `case10: external change NOT overwritten (still C), got ${read(join(cwd, 'config.json'))}`)
  ok(existsSync(trackingDir(id)), 'case10: journal kept for retry/inspection')

  const status = await call(dispatch, 'cleanupStatus', { ids: [id] })
  ok(status.value.results[0]?.cleanup?.state === 'rollback_failed', 'case10: cleanupStatus reports rollback_failed')
  ok(status.value.results[0]?.cleanup?.conflicts?.[0]?.reason === 'externally-modified-after-session', 'case10: conflict reason is explicit')

  // force cleanup: user's explicit decision → pre-session content wins
  const forceApp = forceBoot()
  const forced = await call(forceApp.dispatch, 'cleanup', { ids: [id], mode: 'resume' })
  ok(forced.value.results[0]?.ok === true, `case10: forced resume ok, got ${JSON.stringify(forced.value.results[0])}`)
  ok(read(join(cwd, 'config.json')) === 'A', `case10: force restored pre-session content A, got ${read(join(cwd, 'config.json'))}`)
  removeSessionFromCorpus(id)
}

// force boot: a plugin instance configured with conflictMode 'force'
function forceBoot() {
  return bootWith({ conflictMode: 'force', autoResume: false })
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
  await restarted.dispatch('__warmup__', {}).catch(() => {})
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

// --- dispose -----------------------------------------------------------------------
for (const { disposer } of []) await disposer // no disposers captured in boot()

rmSync(home, { recursive: true, force: true })
console.log(`LIFECYCLE OK — ${checks} checks passed`)
