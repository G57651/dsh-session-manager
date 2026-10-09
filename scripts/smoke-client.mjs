// Functional smoke test for the CLIENT half, run offline with Node alone.
//
// It boots the built client.js bundle against stubbed platform modules (react,
// ui-primitives, the snapshot store) and a mock ctx, then drives the resource
// delete batch through the real controller: the per-file progress transitions,
// the outcome dialog for success/partial/failure, and the stale-modal guard.
// Run: node scripts/build-client.mjs && node scripts/smoke-client.mjs

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await readFile(resolve(root, 'client.js'), 'utf8')

let failures = 0
function ok(condition, label) {
  if (condition === true) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.error(`FAIL  ${label}`)
}

// --- platform stubs ---------------------------------------------------------

// createElement doubles as a synchronous renderer: a function type is invoked
// with its children folded into props, so the walk below sees the fully
// rendered tree instead of element descriptors.
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
  if (typeof type === 'function') {
    if (type === Fragment) return { type: 'Fragment', props: props ?? {}, children: flat }
    return type({ ...(props ?? {}), children: flat })
  }
  return { type, props: props ?? {}, children: flat }
}

function Fragment(props) {
  return { type: 'Fragment', props: props ?? {}, children: (props?.children ?? []).flat(Infinity) }
}

function component(name) {
  return (props) => ({ type: name, props, children: props.children ?? [] })
}

const reactStub = {
  createElement,
  Fragment,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useLayoutEffect: () => {},
  useState: (value) => [value, () => {}],
}

// A draft-mutating store with the same surface defineStore gives the plugin:
// actions(...) run against a clone, the new state is the snapshot, subscribers
// hear every commit.
function defineStoreStub(decl) {
  return {
    spec: decl,
    create() {
      let state = decl.init()
      const listeners = new Set()
      const store = {
        update: (mutate) => {
          const draft = structuredClone(state)
          mutate(draft)
          state = draft
          for (const listener of [...listeners]) listener()
        },
        getSnapshot: () => state,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
      const actions = {}
      for (const key of Object.keys(decl.actions)) {
        actions[key] = (...params) => store.update(draft => decl.actions[key](draft, ...params))
      }
      return { actions, getSnapshot: () => store.getSnapshot(), subscribe: fn => store.subscribe(fn), store }
    },
  }
}

const primitivesStub = {}
for (const name of ['Button', 'Checkbox', 'Modal', 'Pill', 'SegmentedTabs', 'IconArchiveOutlineRegular', 'IconRefreshOutlineRegular', 'IconTrashOutlineRegular', 'IconUnarchiveOutlineRegular']) {
  primitivesStub[name] = component(name)
}

// ensureStyle() needs a document that already carries the tag
globalThis.document = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild: () => {} } }

const loaded = []
const stubRequire = (specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === '@deepseek-ai/dsh-client-store') return { defineStore: defineStoreStub }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  return {}
}
new Function('window', 'require', bundle)(
  { __ModuleLoader__: { load: definition => loaded.push(definition) } },
  stubRequire,
)
const face = loaded[0].factory(stubRequire)

// --- mock ctx ---------------------------------------------------------------

const SESSION = 'session-aaa'
const RPC = '/dsh-session-manager'
const resources = [
  { resourceType: 'file', identifier: '/tmp/project/a.txt', ownership: 'session_created', status: 'present' },
  { resourceType: 'file', identifier: '/tmp/project/fail.txt', ownership: 'session_created', status: 'present' },
  { resourceType: 'environment_variable', identifier: 'FOO', ownership: 'session_configured', status: 'present' },
]

let rpcCalls = []
let deleteCalls = 0
let onFirstDelete = null
let failMode = 'one'

function envelope(value) {
  return { ok: true, value }
}

const connection = {
  rpc: {
    async call(channel, endpoint, payload) {
      if (channel !== RPC) return { ok: false, error: { code: 'bad-channel', message: channel, details: {} } }
      rpcCalls.push({ endpoint, payload })
      switch (endpoint) {
        case 'config': return envelope({ confirmPurge: true, autoRefresh: false })
        case 'list': return envelope({ rows: [{ id: SESSION, title: 'A', cwd: '/tmp/project', updatedAt: Date.now(), archived: false, deleted: false, running: false }], counts: { all: 1, archived: 0, deleted: 0 }, sources: { available: true } })
        case 'resources': return envelope({ sessionId: SESSION, tracked: true, resources, baseline: { fileCount: 3, cwd: '/tmp/project' } })
        case 'cleanupStatus': return envelope({ results: [{ cleanup: { state: 'active' } }] })
        case 'recycleList': return envelope({ entries: [] })
        case 'deleteResources': {
          deleteCalls += 1
          if (onFirstDelete !== null) { const hook = onFirstDelete; onFirstDelete = null; hook() }
          const path = payload.paths[0]
          const failed = failMode !== 'none' && path.endsWith('fail.txt')
          return envelope({ results: [{ ok: !failed, path, error: failed ? { code: 'EPERM', message: 'permission denied', details: {} } : undefined }] })
        }
        default: return { ok: false, error: { code: 'unhandled', message: endpoint, details: {} } }
      }
    },
  },
}

const dictionaries = {}
const ctx = {
  connection,
  remote: undefined,
  // the host runs an effect immediately and keeps its disposer; skipping the
  // call would leave the locale dictionary unregistered
  effect: (fn) => { if (typeof fn === 'function') fn() },
  locale: {
    register: (ns, dict) => { dictionaries[ns] = dict },
    bind: (ns) => (key, params) => {
      // the namespace registers { zh, en }; the host resolves the active
      // locale, so the stub reads zh with en as fallback
      const dict = dictionaries[ns] ?? {}
      const zh = dict.zh ?? {}
      const en = dict.en ?? {}
      const template = typeof zh[key] === 'string' ? zh[key]
        : typeof en[key] === 'string' ? en[key] : key
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in (params ?? {}) ? String(params[name]) : match))
    },
  },
  layout: { panelInfo: { subscribe: () => () => {}, getSnapshot: () => ({ activePanelId: 'sessionManager' }) }, selectPanel: () => {} },
  slots: {
    // the host accepts both a generator (main, which also yields a disposer)
    // and a plain function (the sidebar entry); drive both shapes here
    inject: (name, fn) => {
      const produced = fn()
      if (produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function') {
        for (const value of produced) if (value !== undefined) slots.push(value)
        return
      }
      if (produced !== undefined) slots.push(produced)
    },
    register: (spec, component) => ({ spec, component }),
  },
}
const slots = []

face.apply(ctx)

const main = slots.find(entry => entry.spec?.name === 'main')
ok(main !== undefined, 'the panel registered a main slot')
const { controller, api } = main.spec.inject()
const instance = main.spec.store.create()

// --- render walk ------------------------------------------------------------

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  // every node carries its children on .children (the component
  // stubs copy props.children there), so descending props too would visit
  // each subtree twice and double every match
  walk(node.children, visit)
}

function renderPage(snapshot) {
  const useStore = (selector) => selector(snapshot)
  return main.component({ useStore, actions: instance.actions, t: ctx.locale.bind('sessionManager'), controller })
}

function findNode(tree, predicate, found = []) {
  walk(tree, node => { if (predicate(node)) found.push(node) })
  return found
}

// --- 1. the batch advances the progress bar per file ------------------------

await controller.openResources(SESSION)
const progressLog = []
instance.subscribe(() => {
  const progress = instance.getSnapshot().detail?.progress ?? null
  const last = progressLog[progressLog.length - 1]
  if (JSON.stringify(last?.progress) !== JSON.stringify(progress)) progressLog.push({ progress })
})

failMode = 'one'
instance.actions.setDetailSelected(['file:/tmp/project/a.txt', 'file:/tmp/project/fail.txt', 'environment_variable:FOO'])
await controller.deleteSelected()

const steps = progressLog.map(entry => entry.progress === null ? 'idle' : `${entry.progress.done}/${entry.progress.total}`)
ok([...new Set(steps)].join(' ') === 'idle 0/2 1/2 2/2', `progress stepped once per file (${steps.join(' → ')})`)
ok(steps[steps.length - 1] === 'idle', 'the bar is taken away when the batch settles')
ok(deleteCalls === 2, `only the two path-shaped resources were deleted (${deleteCalls} RPCs)`)

const afterOneFail = instance.getSnapshot().detail
ok(afterOneFail?.result?.tone === 'partial', 'one failure → partial result dialog')
ok(afterOneFail?.result?.total === 2 && afterOneFail?.result?.deleted === 1, 'result counts the batch (2 selected, 1 deleted)')
ok(afterOneFail?.result?.failures?.length === 1 && afterOneFail.result.failures[0].reason === 'permission denied', 'result carries the failure path and reason')
ok(JSON.stringify(afterOneFail?.selected) === JSON.stringify(['file:/tmp/project/fail.txt']), 'the failed row stays selected for a retry')
ok(afterOneFail?.busy === false && afterOneFail.progress === null, 'busy and progress cleared after the batch')

// --- 2. the dialog renders INSIDE the modal, above the covered page ---------

const treeFail = renderPage(instance.getSnapshot())
const bar = findNode(treeFail, node => node.props?.className === 'dsm-resProgress')
ok(bar.length === 0, 'no progress bar once the batch settled')
const dialog = findNode(treeFail, node => node.type === 'Modal' && node.props?.title === '部分删除失败')
ok(dialog.length === 1, 'the failure dialog renders while the resources modal is open')
ok(findNode(dialog[0], node => node.props?.className === 'dsm-resultPath').length === 1, 'the failure names the path')
ok(findNode(dialog[0], node => node.props?.className === 'dsm-resultReason').length === 1, 'the failure names the reason')

// --- 3. all-good batch still confirms ---------------------------------------

instance.actions.clearDetailResult()
failMode = 'none'
deleteCalls = 0
instance.actions.setDetailSelected(['file:/tmp/project/a.txt', 'file:/tmp/project/fail.txt'])
await controller.deleteSelected()
const afterAllOk = instance.getSnapshot().detail
ok(afterAllOk?.result?.tone === 'success' && afterAllOk.result.failures.length === 0, 'success batch raises the dialog too')
ok(deleteCalls === 2, 'success batch issued one RPC per file')
const treeOk = renderPage(instance.getSnapshot())
ok(findNode(treeOk, node => node.type === 'Modal' && node.props?.title === '删除完成').length === 1, 'the success dialog renders in the modal')

// --- 4. mid-batch progress renders as a bar ---------------------------------

instance.actions.clearDetailResult()
instance.actions.setDetailProgress({ done: 1, total: 4 })
const treeRun = renderPage(instance.getSnapshot())
const running = findNode(treeRun, node => node.props?.className === 'dsm-resProgress')
ok(running.length === 1, 'the progress bar renders while a batch runs')
const aria = running[0].props
ok(aria.role === 'progressbar' && aria['aria-valuenow'] === 1 && aria['aria-valuemax'] === 4, 'the bar exposes progressbar semantics (1/4)')
const fill = findNode(running[0], node => node.props?.className === 'dsm-resProgressFill')
ok(fill.length === 1 && fill[0].props.style.width === '25%', 'the fill tracks the ratio (25%)')
const label = findNode(running[0], node => node.type === 'span' && node.props?.className === 'dsm-resProgressText')[0]?.children?.[0]
ok(label === '正在删除 1/4', `the bar counts files in words (${JSON.stringify(label)})`)
instance.actions.setDetailProgress(null)

// --- 5. every file failing reads as a failure -------------------------------

instance.actions.clearDetailResult()
failMode = 'one'
resources.push({ resourceType: 'file', identifier: '/tmp/project/fail2.txt', ownership: 'session_created', status: 'present' })
instance.actions.setDetailSelected(['file:/tmp/project/fail.txt', 'file:/tmp/project/fail2.txt'])
await controller.deleteSelected()
ok(instance.getSnapshot().detail?.result?.tone === 'error', 'all-failed batch → 删除失败 dialog')

// --- 6. a modal closed mid-batch must not get a stale dialog ----------------

instance.actions.clearDetailResult()
failMode = 'none'
onFirstDelete = () => instance.actions.closeDetail()
await controller.openResources(SESSION)
instance.actions.setDetailSelected(['file:/tmp/project/a.txt'])
await controller.deleteSelected()
ok(instance.getSnapshot().detail === null, 'the user closed the modal during the batch')
onFirstDelete = null

// --- 7. one row's delete button goes through the same path ------------------

instance.actions.openDetail(SESSION)
failMode = 'one'
deleteCalls = 0
await controller.deleteOneRow({ resourceType: 'file', identifier: '/tmp/project/fail.txt' })
const rowResult = instance.getSnapshot().detail?.result
ok(deleteCalls === 1, 'a row delete is one RPC')
ok(rowResult?.tone === 'error' && rowResult.total === 1 && rowResult.failures.length === 1, 'a row delete gets the dialog as well')

// --- 8. deleting the session's row from the list is untouched ---------------

rpcCalls = []
await controller.runOp('deleteSoft', [SESSION], ctx.locale.bind('sessionManager'))
ok(rpcCalls.some(entry => entry.endpoint === 'delete'), 'session delete still routes to the delete endpoint')


console.log(failures === 0 ? '\nsmoke-client: all checks passed' : `\nsmoke-client: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
