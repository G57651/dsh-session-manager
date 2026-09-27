// dsh-session-manager — web client half.
//
// Builds into client.js via scripts/build-client.mjs, which serves this file
// through the platform module table (react and @deepseek-ai/* client packages
// are externals) and wraps it in the window.__ModuleLoader__ CJS shell.
//
// Source conventions enforced by the build script:
//   - imports are single-line, at the top of the file;
//   - the only `export` statement is the trailing one, which becomes
//     module.exports.

import { createElement, useCallback, useEffect, useMemo } from 'react'
import { Button, Checkbox, Modal, Pill, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconArchiveOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, IconUnarchiveOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { zh, en } from './locales.js'
import { cssText } from './styles.css.js'

const NS = 'sessionManager'
/** The id shared by the sidebar entry and the main panel it opens. */
const PANEL_ID = 'sessionManager'
const CHANNEL = '/dsh-session-manager'
const VIEWS = ['all', 'archived', 'deleted']
const STYLE_TAG_ID = 'dsh-session-manager-css'

const h = createElement

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function createApi(ctx) {
  const call = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload ?? {})
  return {
    list: view => call('list', { view }),
    archive: ids => call('archive', { ids }),
    unarchive: ids => call('unarchive', { ids }),
    deleteSoft: ids => call('delete', { ids }),
    restore: ids => call('restore', { ids }),
    purge: ids => call('purge', { ids }),
    getConfig: () => call('config', {}),
  }
}

function formatError(error) {
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') return error.message ?? error.code ?? 'internal'
  return 'internal'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createManagerStore() {
  return defineStore({
    init: () => ({
      view: 'all',
      rows: [],
      counts: { all: 0, archived: 0, deleted: 0 },
      loading: true,
      loaded: false,
      error: null,
      notice: null,
      selectMode: false,
      selectedIds: [],
      confirmPurgeIds: null,
      config: { confirmPurge: true, autoRefresh: true, maxBatchSize: 200 },
    }),
    actions: {
      setConfig: (draft, config) => { draft.config = config },
      setView: (draft, view) => {
        draft.view = view
        draft.selectMode = false
        draft.selectedIds = []
        draft.loading = true
      },
      setRows: (draft, rows, counts) => {
        draft.rows = rows
        draft.counts = counts
        draft.loading = false
        draft.loaded = true
        draft.error = null
      },
      setError: (draft, message) => {
        draft.loading = false
        draft.loaded = true
        draft.error = message
      },
      patchRow: (draft, id, patch) => {
        const row = draft.rows.find(candidate => candidate.id === id)
        if (row !== undefined) Object.assign(row, patch)
      },
      setNotice: (draft, notice) => { draft.notice = notice },
      enterSelect: (draft) => { draft.selectMode = true },
      exitSelect: (draft) => {
        draft.selectMode = false
        draft.selectedIds = []
      },
      toggleSelect: (draft, id) => {
        draft.selectedIds = draft.selectedIds.includes(id)
          ? draft.selectedIds.filter(candidate => candidate !== id)
          : [...draft.selectedIds, id]
      },
      selectAll: (draft, ids) => { draft.selectedIds = ids },
      invertSelection: (draft, ids) => {
        draft.selectedIds = ids.filter(id => !draft.selectedIds.includes(id))
      },
      openConfirmPurge: (draft, ids) => { draft.confirmPurgeIds = ids },
      closeConfirmPurge: (draft) => { draft.confirmPurgeIds = null },
    },
  })
}

// ---------------------------------------------------------------------------
// Controller — data loading, event subscription, mutation plumbing
// ---------------------------------------------------------------------------

function createController({ ctx, api, instance }) {
  let loadSeq = 0
  let refreshTimer
  let eventDisposers = []

  async function load(view) {
    const target = view ?? instance.getSnapshot().view
    const seq = ++loadSeq
    const result = await api.list(target)
    if (seq !== loadSeq) return
    if (result?.ok === true) {
      instance.actions.setRows(result.value?.rows ?? [], result.value?.counts ?? { all: 0, archived: 0, deleted: 0 })
    } else {
      instance.actions.setError(formatError(result?.error))
    }
  }

  function ensureLoaded() {
    const snapshot = instance.getSnapshot()
    if (!snapshot.loaded) void load()
  }

  function scheduleRefresh() {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void load()
    }, 400)
  }

  function subscribeEvents() {
    if (eventDisposers.length > 0 || ctx.remote === undefined) return
    eventDisposers.push(ctx.remote.$on('api-session/added', scheduleRefresh))
    eventDisposers.push(ctx.remote.$on('api-session/removed', scheduleRefresh))
    eventDisposers.push(ctx.remote.$on('api-session/status', (sessionId, running) => {
      instance.actions.patchRow(String(sessionId), { running: running === true })
    }))
    eventDisposers.push(ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
      instance.actions.patchRow(String(sessionId), { updatedAt })
    }))
  }

  /** Run one mutation endpoint, refresh, and surface partial failures. */
  async function runOp(name, ids, t) {
    const result = await api[name](ids)
    if (result?.ok !== true) {
      instance.actions.setNotice({ tone: 'error', text: t('error.request', { reason: formatError(result?.error) }) })
      return false
    }
    // The operated-on rows just left this view; start the next batch clean.
    instance.actions.selectAll([])
    await load()
    const failures = (result.value?.results ?? []).filter(entry => entry?.ok !== true)
    if (failures.length > 0) {
      instance.actions.setNotice({
        tone: 'error',
        text: t('notice.partial', { n: failures.length, reason: formatError(failures[0]?.error) }),
      })
    }
    return true
  }

  function dispose() {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    for (const disposer of eventDisposers.splice(0)) {
      if (typeof disposer === 'function') disposer()
    }
  }

  return { load, ensureLoaded, scheduleRefresh, subscribeEvents, runOp, dispose }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const cx = (...parts) => parts.filter(Boolean).join(' ')

function formatRelativeTime(timestamp, t) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const diff = Date.now() - timestamp
  if (diff < 60_000) return t('time.now')
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.max(1, Math.floor(diff / 60_000)) })
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.max(1, Math.floor(diff / 3_600_000)) })
  if (diff < 7 * 86_400_000) return t('time.daysAgo', { n: Math.max(1, Math.floor(diff / 86_400_000)) })
  return new Date(timestamp).toLocaleString()
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

function rowMetaText(row, t) {
  const parts = []
  const updated = formatRelativeTime(row.updatedAt, t)
  if (updated !== '') parts.push(updated)
  const size = formatBytes(row.sizeBytes)
  if (size !== '') parts.push(size)
  if (typeof row.cwd === 'string' && row.cwd !== '') parts.push(row.cwd)
  return parts.join(' · ')
}

function displayTitle(row, t) {
  return typeof row.title === 'string' && row.title !== '' ? row.title : t('row.untitled')
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Panel icon — "bubble list" (speech bubble with list rows), drawn on the
// host icon grid so it sits next to the official sidebar icons without visual
// drift: 16×16 viewBox, fill none, stroke currentColor, Regular 1px /
// Medium 1.3px, flat caps, one-decimal geometry.
// ---------------------------------------------------------------------------

const ICON_SESSION_MANAGER_REGULAR_STROKE = 1
const ICON_SESSION_MANAGER_MEDIUM_STROKE = 1.3

function IconSessionManagerOutlineArtwork({ size = 16, className, strokeWidth }) {
  return h('svg', {
    width: size,
    height: size,
    className,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
    strokeWidth,
  },
    h('path', { d: 'M5 12H4.75C3.51 12 2.5 10.99 2.5 9.75V4.75C2.5 3.51 3.51 2.5 4.75 2.5H11.25C12.49 2.5 13.5 3.51 13.5 4.75V9.75C13.5 10.99 12.49 12 11.25 12H7.7L5 14.3V12Z', stroke: 'currentColor' }),
    h('path', { d: 'M5.1 5.4H10.9', stroke: 'currentColor' }),
    h('path', { d: 'M5.1 8H9.2', stroke: 'currentColor' }),
  )
}

/** One-pixel "bubble list" artwork (sidebar default). */
function IconSessionManagerOutlineRegular(props) {
  return h(IconSessionManagerOutlineArtwork, { ...props, strokeWidth: ICON_SESSION_MANAGER_REGULAR_STROKE })
}

/** 1.3px "bubble list" artwork for dense contexts. */
function IconSessionManagerOutlineMedium(props) {
  return h(IconSessionManagerOutlineArtwork, { ...props, strokeWidth: ICON_SESSION_MANAGER_MEDIUM_STROKE })
}

function PanelIcon(props) {
  return h(IconSessionManagerOutlineRegular, { size: props.size })
}

function Badge({ label, className }) {
  return h(Pill, { className: cx('dsm-pill', className) }, label)
}

function Row({ row, view, t, selectMode, selected, actions, controller, config }) {
  const title = displayTitle(row, t)
  const onToggle = useCallback(() => actions.toggleSelect(row.id), [actions, row.id])
  const purgeOne = useCallback((id) => {
    if (config.confirmPurge === false) void controller.runOp('purge', [id], t)
    else actions.openConfirmPurge([id])
  }, [config.confirmPurge, controller, actions, t])
  const badges = []
  if (row.running === true) badges.push(h(Badge, { key: 'running', label: t('badge.running'), className: 'dsm-pillRunning' }))
  if (row.archived === true) badges.push(h(Badge, { key: 'archived', label: t('badge.archived') }))
  if (row.origin === 'subagent') badges.push(h(Badge, { key: 'subagent', label: t('badge.subagent') }))
  if (row.missing === true) badges.push(h(Badge, { key: 'missing', label: t('badge.missing'), className: 'dsm-pillMissing' }))

  const quickActions = []
  if (row.deleted === true) {
    quickActions.push(h(Button, { key: 'restore', variant: 'ghost', size: 'sm', icon: h(IconUnarchiveOutlineRegular, { size: 14 }), onClick: () => void controller.runOp('restore', [row.id], t) }, t('action.restore')))
    quickActions.push(h(Button, { key: 'purge', variant: 'ghost', size: 'sm', className: 'dsm-dangerButton', icon: h(IconTrashOutlineRegular, { size: 14 }), 'aria-label': t('action.purge'), onClick: () => purgeOne(row.id) }))
  } else {
    if (row.archived === true) {
      quickActions.push(h(Button, { key: 'unarchive', variant: 'ghost', size: 'sm', icon: h(IconUnarchiveOutlineRegular, { size: 14 }), onClick: () => void controller.runOp('unarchive', [row.id], t) }, t('action.unarchive')))
    } else {
      quickActions.push(h(Button, { key: 'archive', variant: 'ghost', size: 'sm', icon: h(IconArchiveOutlineRegular, { size: 14 }), onClick: () => void controller.runOp('archive', [row.id], t) }, t('action.archive')))
    }
    quickActions.push(h(Button, { key: 'delete', variant: 'ghost', size: 'sm', className: 'dsm-dangerButton', icon: h(IconTrashOutlineRegular, { size: 14 }), 'aria-label': t('action.delete'), onClick: () => void controller.runOp('deleteSoft', [row.id], t) }))
  }

  return h('div', {
    className: cx('dsm-row', selectMode && 'dsm-rowClickable', selectMode && selected && 'dsm-rowSelected'),
    role: 'listitem',
    onClick: selectMode ? onToggle : undefined,
  },
    selectMode && h('div', { className: 'dsm-checkCell', onClick: (event) => event.stopPropagation() },
      h(Checkbox, { checked: selected, onChange: onToggle, label: t('row.select', { title }) })),
    h('div', { className: 'dsm-rowMain' },
      h('div', { className: 'dsm-rowTitleLine' },
        h('span', { className: cx('dsm-rowTitle', row.title === null && 'dsm-rowTitleMuted'), title }, title),
        badges,
      ),
      h('div', { className: 'dsm-rowMeta' },
        row.deleted === true
          ? formatRelativeTime(row.deletedAt, t)
          : rowMetaText(row, t)),
    ),
    !selectMode && h('div', { className: 'dsm-rowActions' }, quickActions),
  )
}

function SkeletonList() {
  return h('div', { className: 'dsm-list', 'aria-hidden': true },
    Array.from({ length: 6 }, (_, index) => h('div', { className: 'dsm-skeletonRow', key: index },
      h('div', { className: 'dsm-skeletonBar' }),
      h('div', { className: cx('dsm-skeletonBar', 'dsm-skeletonBarShort') }))),
  )
}

function EmptyState({ view, t }) {
  const key = view === 'deleted' ? 'deleted' : view === 'archived' ? 'archived' : 'all'
  return h('div', { className: 'dsm-stateBox' },
    h('div', { className: 'dsm-stateIcon' }, h(IconSessionManagerOutlineRegular, { size: 28 })),
    h('p', { className: 'dsm-stateTitle' }, t(`empty.${key}.title`)),
    h('p', { className: 'dsm-stateHint' }, t(`empty.${key}.hint`)),
  )
}

function BatchBar({ view, rows, selectedIds, actions, controller, t, config }) {
  const ids = rows.map(row => row.id)
  const noneSelected = selectedIds.length === 0
  const run = (name) => () => void controller.runOp(name, selectedIds, t)
  const ops = []
  if (view === 'all' || view === 'archived') {
    ops.push(h(Button, { key: 'archiveToggle', variant: 'ghost', size: 'sm', disabled: noneSelected, onClick: run(view === 'all' ? 'archive' : 'unarchive') }, view === 'all' ? t('batch.archive') : t('batch.unarchive')))
    ops.push(h(Button, { key: 'delete', variant: 'ghost', size: 'sm', className: 'dsm-dangerButton', disabled: noneSelected, onClick: run('deleteSoft') }, t('batch.delete')))
  } else {
    ops.push(h(Button, { key: 'restore', variant: 'ghost', size: 'sm', disabled: noneSelected, onClick: run('restore') }, t('batch.restore')))
    ops.push(h(Button, { key: 'purge', variant: 'ghost', size: 'sm', className: 'dsm-dangerButton', disabled: noneSelected, onClick: () => (config.confirmPurge === false ? run('purge')() : actions.openConfirmPurge([...selectedIds])) }, t('batch.purge')))
  }
  return h('div', { className: 'dsm-batchBar', role: 'toolbar', 'aria-label': t('batch.bar') },
    h('span', { className: 'dsm-batchCount' }, t('batch.selected', { n: selectedIds.length })),
    h('div', { className: 'dsm-batchOps' },
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => actions.selectAll(ids) }, t('batch.all')),
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => actions.invertSelection(ids) }, t('batch.invert')),
      ops,
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => actions.exitSelect() }, t('batch.cancel')),
    ),
  )
}

function PurgeConfirmModal({ ids, rows, actions, controller, t }) {
  const byId = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows])
  const previews = ids.slice(0, 5).map(id => byId.get(id))
  const restCount = Math.max(0, ids.length - previews.length)
  const confirm = () => {
    actions.closeConfirmPurge()
    void controller.runOp('purge', ids, t)
  }
  return h(Modal, {
    open: true,
    onClose: actions.closeConfirmPurge,
    title: t('purge.title', { n: ids.length }),
    description: t('purge.description'),
    closeLabel: t('action.closeModal'),
    footer: [
      h(Button, { key: 'cancel', variant: 'ghost', size: 'sm', onClick: actions.closeConfirmPurge }, t('action.cancel')),
      h(Button, { key: 'purge', variant: 'primary', size: 'sm', className: 'dsm-dangerFill', onClick: confirm }, t('purge.confirm', { n: ids.length })),
    ],
  },
    h('ul', { className: 'dsm-purgeList' },
      previews.map((row, index) => h('li', { key: ids[index] }, `· ${displayTitle(row ?? { title: null }, t)}`)),
      restCount > 0 && h('li', null, t('purge.more', { n: restCount })),
    ),
  )
}

function SessionManagerPage(props) {
  const { useStore, actions, t, controller } = props
  const view = useStore(s => s.view)
  const rows = useStore(s => s.rows)
  const counts = useStore(s => s.counts)
  const loading = useStore(s => s.loading)
  const error = useStore(s => s.error)
  const notice = useStore(s => s.notice)
  const selectMode = useStore(s => s.selectMode)
  const selectedIds = useStore(s => s.selectedIds)
  const confirmPurgeIds = useStore(s => s.confirmPurgeIds)
  const config = useStore(s => s.config)

  useEffect(() => { controller.ensureLoaded() }, [controller])

  const tabs = VIEWS.map(name => ({
    value: name,
    label: `${t(`view.${name}`)} · ${counts[name] ?? 0}`,
    id: `dsm-tab-${name}`,
    panelId: 'dsm-session-panel',
  }))

  return h('div', { className: 'dsm-page' },
    h('div', { className: 'dsm-head' },
      h('div', { className: 'dsm-headRow' },
        h('h1', { className: 'dsm-title' }, t('panel')),
        h('div', { className: 'dsm-headActions' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), disabled: loading, onClick: () => void controller.load() }, t('action.refresh')),
          h(Button, { variant: selectMode ? 'primary' : 'toolbar', size: 'sm', onClick: () => actions[selectMode ? 'exitSelect' : 'enterSelect']() }, selectMode ? t('action.doneSelect') : t('action.batch')),
        ),
      ),
      h(SegmentedTabs, {
        className: 'dsm-tabs',
        items: tabs,
        value: view,
        onChange: (next) => { actions.setView(next); void controller.load(next) },
        label: t('view.label'),
      }),
    ),
    notice !== null && h('div', { className: cx('dsm-notice', notice.tone === 'error' ? 'dsm-noticeError' : 'dsm-noticeInfo'), role: 'status' },
      h('span', null, notice.text),
      h('button', { className: 'dsm-noticeClose', onClick: () => actions.setNotice(null), 'aria-label': t('action.dismiss') }, '×'),
    ),
    error !== null
      ? h('div', { className: 'dsm-stateBox' },
          h('p', { className: 'dsm-stateTitle' }, t('error.list')),
          h('p', { className: 'dsm-stateHint' }, error),
          h(Button, { variant: 'outline', size: 'sm', onClick: () => void controller.load() }, t('action.retry')))
      : loading && rows.length === 0
        ? h(SkeletonList)
        : rows.length === 0
          ? h(EmptyState, { view, t })
          : h('div', { className: 'dsm-list', id: 'dsm-session-panel', role: 'list' },
              rows.map(row => h(Row, {
                key: row.id,
                row,
                view,
                t,
                selectMode,
                selected: selectedIds.includes(row.id),
                actions,
                controller,
                config,
              }))),
    selectMode && h(BatchBar, { view, rows, selectedIds, actions, controller, t, config }),
    confirmPurgeIds !== null && h(PurgeConfirmModal, { ids: confirmPurgeIds, rows, actions, controller, t }),
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function ensureStyle(css) {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_TAG_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_TAG_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

const inject = ['slots', 'locale', 'layout', 'remote', 'connection']

function apply(ctx) {
  ensureStyle(cssText)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-manager: dictionaries')
  const t = ctx.locale.bind(NS)

  const handle = createManagerStore()
  const instance = handle.create()
  const store = { ...handle, create: () => instance }

  const api = createApi(ctx)
  const controller = createController({ ctx, api, instance })

  void (async () => {
    const result = await api.getConfig()
    if (result?.ok === true && result.value !== null && typeof result.value === 'object') {
      instance.actions.setConfig(result.value)
      if (result.value.autoRefresh === true) controller.subscribeEvents()
    }
  })()

  ctx.slots.inject('main', function* () {
    yield ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        store,
        inject: () => ({ controller, api }),
      },
      SessionManagerPage,
    )
    // Leaving the panel exits selection mode so a stale selection cannot leak
    // into the next visit.
    yield ctx.layout.panelInfo.subscribe(() => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID) instance.actions.exitSelect()
    })
  })

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => t('panel'),
      locale: NS,
    },
    PanelIcon,
  ))

  ctx.effect(() => () => controller.dispose(), 'dsh-session-manager: controller timers and event listeners')
}

export { inject, apply }
