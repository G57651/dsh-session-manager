// Functional smoke test for the host half, run offline with Node alone.
//
// It boots apply() against a mock ctx whose services are backed by fixture
// data in a temp $DSH_HOME, then drives every RPC endpoint through the real
// dispatcher — including the error paths and the destructive-path safety
// guard. Run: node scripts/smoke-host.mjs

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const home = mkdtempSync(join(tmpdir(), 'dsm-smoke-'))
process.env.DSH_HOME = home

// --- fixture session corpus -------------------------------------------------

const projectKey = '--tmp-project--'
const sessionsRoot = join(home, 'sessions', projectKey)
const sessionIds = ['session-aaa', 'session-bbb', 'session-ccc']
for (const id of sessionIds) mkdirSync(join(sessionsRoot, id), { recursive: true })
for (const id of sessionIds) {
  writeFileSync(join(sessionsRoot, id, 'session.v4.jsonl.zstd'), 'x'.repeat(2048))
}
const NOW = Date.now()
const headers = {
  'session-aaa': { version: 4, id: 'session-aaa', createdAt: NOW - 5_000, cwd: '/tmp/proj', isSeeded: false },
  'session-bbb': { version: 4, id: 'session-bbb', createdAt: NOW - 4_000, cwd: '/tmp/proj', isSeeded: false },
  'session-ccc': { version: 4, id: 'session-ccc', createdAt: NOW - 3_000, cwd: '/tmp/proj', isSeeded: false },
}
const titles = { 'session-aaa': 'AAA 会话' }
let unsafeLocate = false

const workspace = { archived: new Set(['session-ccc']), stopped: [] }

const services = {
  sessionController: {
    list: async () => ({
      items: [
        { sessionId: 'session-aaa', updatedAt: NOW - 1_000, running: false, blank: false, agentAvailable: true, cwd: '/tmp/proj' },
        { sessionId: 'session-ccc', updatedAt: NOW - 2_000, running: true, blank: false, agentAvailable: true, cwd: '/tmp/proj', origin: 'subagent' },
      ],
    }),
  },
  sessionQuery: {
    listSessions: async () => Object.values(headers).map(header => ({ header, live: false, persisted: true })),
    readTitleSnapshots: async ids => ids.map(id => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: headers[id] ?? { version: 4, id, createdAt: 0 }, ...(titles[id] === undefined ? {} : { title: { title: titles[id], updatedAt: 1 } }) },
    })),
  },
  sessionPersistence: {
    list: async () => sessionIds.map(id => ({ header: headers[id], revision: 'r1', sizeBytes: 2048, eventCount: 10 })),
    stat: async id => existsSync(join(sessionsRoot, id)) ? { header: headers[id], revision: 'r1', sizeBytes: 2048, eventCount: 10 } : undefined,
    locate: (header) => {
      if (unsafeLocate === true) return { kind: 'jsonl', path: '/etc/passwd/evil' }
      if (existsSync(join(sessionsRoot, header.id))) return { kind: 'jsonl', path: join(sessionsRoot, header.id, 'session.v4.jsonl.zstd') }
      throw new Error('not found')
    },
  },
  workspaceRegistry: {
    get archivedSessionIds() { return [...workspace.archived] },
    archiveSession: async (id, options) => {
      if (headers[id] === undefined) throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' })
      workspace.archived.add(id)
      if (options?.stopActivity === true) workspace.stopped.push(id)
    },
    unarchiveSession: async (id) => { workspace.archived.delete(id) },
  },
}

const eventListeners = {}
const disposers = []
const captured = {}
const warnings = []
const ctx = {
  logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {}, error: () => {} },
  on: (name, listener) => { eventListeners[name] = listener; return () => {} },
  effect: (execute, label) => { const disposer = execute(); disposers.push({ disposer, label }); return disposer },
  get: name => services[name],
  connection: {
    rpc: {
      handle: (channel, dispatch, options) => {
        captured.channel = channel
        captured.dispatch = dispatch
        captured.options = options
        return () => {}
      },
    },
  },
}

// --- checks -----------------------------------------------------------------

let checks = 0
function ok(condition, message) {
  if (!condition) {
    console.error(`SMOKE FAIL: ${message}`)
    console.error(`(temp home kept for inspection: ${home})`)
    process.exit(1)
  }
  checks += 1
}

const host = await import(new URL('../index.js', import.meta.url).href)
const config = host.Config({})

host.apply(ctx, config)
ok(captured.channel === '/dsh-session-manager', `channel is /dsh-session-manager, got ${captured.channel}`)
ok(captured.options?.authority === 'loopback', 'rpc handle registered with authority loopback')
const dispatch = captured.dispatch

async function call(endpoint, payload) {
  const result = await dispatch(endpoint, payload)
  ok(result !== null && typeof result === 'object' && typeof result.ok === 'boolean', `${endpoint} returned a strict { ok } result`)
  return result
}

// config
{
  const result = await call('config', {})
  ok(result.ok === true, 'config ok')
  ok(result.value.confirmPurge === true && result.value.autoRefresh === true && result.value.maxBatchSize === 200, 'config carries schema defaults')
}

// list all — controller rows + record-only rows merged, cwd-less record included
let result = await call('list', { view: 'all' })
ok(result.ok === true, 'list all ok')
ok(result.value.rows.length === 3, `list all has 3 rows (merged corpus), got ${result.value.rows.length}`)
const bbbRow = result.value.rows.find(row => row.id === 'session-bbb')
ok(bbbRow !== undefined && bbbRow.cwd === '/tmp/proj', 'record-only row merged with header cwd')
ok(result.value.rows.find(row => row.id === 'session-aaa')?.title === 'AAA 会话', 'title folded from sessionQuery')
const cccRow = result.value.rows.find(row => row.id === 'session-ccc')
ok(cccRow.archived === true && cccRow.running === true && cccRow.origin === 'subagent', 'ccc flagged archived+running+subagent')
ok(result.value.counts.all === 3 && result.value.counts.archived === 1 && result.value.counts.deleted === 0, `counts all/archived/deleted = 3/1/0, got ${JSON.stringify(result.value.counts)}`)
ok(result.value.rows[0].id === 'session-aaa', 'rows sorted newest-first')

// list archived
result = await call('list', { view: 'archived' })
ok(result.value.rows.length === 1 && result.value.rows[0].id === 'session-ccc', 'archived view has only ccc')

// archive with per-id failure
result = await call('archive', { ids: ['session-aaa', 'session-unknown'] })
ok(result.ok === true, 'archive batch ok envelope')
const archiveResults = Object.fromEntries(result.value.results.map(entry => [entry.id, entry]))
ok(archiveResults['session-aaa'].ok === true, 'aaa archived')
ok(archiveResults['session-unknown'].ok === false && archiveResults['session-unknown'].error === 'session-not-found', 'unknown id reports session-not-found')
ok(workspace.stopped.includes('session-aaa'), 'archive stops activity')

// soft delete bbb — manifest written, hidden from all, visible in deleted view
result = await call('delete', { ids: ['session-bbb'] })
ok(result.ok === true && result.value.results[0].ok === true, 'soft delete ok')
ok(existsSync(join(home, 'dsh-session-manager-deleted.json')), 'manifest file written')
result = await call('list', { view: 'all' })
ok(result.value.rows.every(row => row.id !== 'session-bbb'), 'deleted row hidden from all view')
result = await call('list', { view: 'deleted' })
ok(result.value.rows.length === 1 && result.value.rows[0].id === 'session-bbb', 'deleted view lists bbb')
ok(result.value.rows[0].wasArchived === false && result.value.rows[0].missing === false, 'bbb trash row carries wasArchived=false and exists on disk')
ok(result.value.counts.all === 2 && result.value.counts.archived === 2 && result.value.counts.deleted === 1, 'deleted view still reports real all/archived counts')
ok(existsSync(join(sessionsRoot, 'session-bbb')), 'soft delete keeps the session directory')

// restore bbb
result = await call('restore', { ids: ['session-bbb'] })
ok(result.ok === true && result.value.results[0].ok === true, 'restore ok')
result = await call('list', { view: 'all' })
ok(result.value.rows.some(row => row.id === 'session-bbb'), 'bbb back in all view')
ok(!workspace.archived.has('session-bbb'), 'bbb unarchived on restore')
result = await call('restore', { ids: ['session-bbb'] })
ok(result.value.results[0].ok === false && result.value.results[0].error === 'not-deleted', 'restore of non-deleted reports not-deleted')

// deleting an already-archived session restores to archived (wasArchived=true)
result = await call('delete', { ids: ['session-ccc'] })
result = await call('restore', { ids: ['session-ccc'] })
ok(workspace.archived.has('session-ccc'), 'ccc restored back to archived because it was archived before deletion')

// purge: archive + rm directory + manifest cleanup
result = await call('delete', { ids: ['session-aaa'] })
ok(existsSync(join(sessionsRoot, 'session-aaa')), 'aaa on disk before purge')
result = await call('purge', { ids: ['session-aaa'] })
ok(result.ok === true && result.value.results[0].ok === true, `purge ok, got ${JSON.stringify(result.value.results)}`)
ok(!existsSync(join(sessionsRoot, 'session-aaa')), 'aaa session directory removed from disk')
result = await call('list', { view: 'deleted' })
ok(result.value.rows.every(row => row.id !== 'session-aaa'), 'aaa dropped from trash manifest')
result = await call('list', { view: 'all' })
ok(result.value.rows.every(row => row.id !== 'session-aaa'), 'purged id filtered from all view despite stale corpus entry')
ok(result.value.counts.all === 2, `counts exclude the purged id, got all=${result.value.counts.all}`)

// purge guard: locate() escaping the sessions root must be refused
await call('delete', { ids: ['session-bbb'] })
unsafeLocate = true
result = await call('purge', { ids: ['session-bbb'] })
unsafeLocate = false
ok(result.value.results[0].ok === false && result.value.results[0].error === 'unsafe-path', 'purge refuses paths outside the sessions root')
ok(existsSync(join(sessionsRoot, 'session-bbb')), 'bbb directory untouched by the refused purge')

// purge of a header-less manifest entry just cleans the entry
result = await call('purge', { ids: ['session-zzz-gone'] })
ok(result.value.results[0].ok === true && result.value.results[0].freedBytes === 0, 'purge of missing session cleans the manifest entry')

// title event keeps the cache current
await call('restore', { ids: ['session-bbb'] })
eventListeners['session/event']({ id: 'session-bbb' }, { type: 'session/title', data: { title: 'BBB 新标题' }, time: NOW })
result = await call('list', { view: 'all' })
ok(result.value.rows.find(row => row.id === 'session-bbb')?.title === 'BBB 新标题', 'session/title event updates the title cache')

// errors
ok((await dispatch('nope', {})).ok === false, 'unknown endpoint -> ok:false')
ok((await dispatch('archive', {})).error === 'no-ids', 'empty batch -> no-ids')
{
  const mixed = await dispatch('archive', { ids: ['a', 42] })
  ok(mixed.ok === true && mixed.value.results[0].id === 'a' && mixed.value.results[0].error === 'session-not-found', 'non-string ids filtered; unknown remainder reports per-id session-not-found')
}
{
  const strictConfig = host.Config({ maxBatchSize: 1 })
  const ctx2 = { ...ctx, connection: { rpc: { handle: (channel, dispatch2) => { captured.second = dispatch2; return () => {} } } } }
  host.apply(ctx2, strictConfig)
  const second = captured.second
  ok((await second('archive', { ids: ['session-aaa', 'session-bbb'] })).error === 'too-many-ids', 'batch above maxBatchSize rejected')
}

// direct webServer fallback registers a route when the connection seam refuses
{
  const routes = []
  const ctx3 = {
    ...ctx,
    connection: { rpc: { handle: () => { throw new Error('seam refused') } } },
    get: (name) => name === 'webServer' ? { register: (route) => { routes.push(route); return () => {} } } : services[name],
  }
  host.apply(ctx3, config)
  ok(routes.length === 1 && routes[0].path === '/dsh-session-manager', 'fallback webServer route registered')
}

// dispose flushes stores without error
for (const { disposer } of disposers) await (typeof disposer === 'function' ? disposer() : undefined)
ok(existsSync(join(home, 'dsh-session-manager-titles.json')), 'title cache flushed on dispose')

rmSync(home, { recursive: true, force: true })
console.log(`SMOKE OK — ${checks} checks passed`)
