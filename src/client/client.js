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
    resources: id => call('resources', { id }),
    cleanupStatus: id => call('cleanupStatus', { ids: [id] }),
    openResource: (id, path) => call('openResource', { id, path }),
  }
}

// Accepts both the rc.1 failure shape { code, message, details }
// (packages/client/connection/src/rpc.ts:18-28) and the bare string the
// 0.1.x host returned. `message` is preferred over `code` because it is
// the human-readable half; `details` is only kept for logging, never
// rendered, since it is arbitrary JSON.
function formatError(error) {
  if (typeof error === 'string' && error !== '') return error
  if (error !== null && typeof error === 'object') {
    const message = error.message ?? error.code
    if (typeof message === 'string' && message !== '') return message
    if (typeof error.code === 'string' && error.code !== '') return error.code
  }
  return 'internal'
}

/** One-line diagnostic for the browser console; never shown in the panel. */
function describeError(error) {
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : 'unknown'
    const details = error.details === undefined ? '' : ` details=${JSON.stringify(error.details)}`
    return `${code}${details}`
  }
  return String(error)
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
      sources: null,
      noticeDismissed: false,
      config: { confirmPurge: true, autoRefresh: true },
      detail: null,
    }),
    actions: {
      setConfig: (draft, config) => { draft.config = config },
      setView: (draft, view) => {
        draft.view = view
        draft.selectMode = false
        draft.selectedIds = []
        draft.loading = true
      },
      setRows: (draft, rows, counts, sources) => {
        draft.rows = rows
        draft.counts = counts
        // Degraded host corpora (audit P5): the host reports which
        // services answered, so a partial list can say so instead of
        // silently looking complete.
        draft.sources = sources
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
      setNotice: (draft, notice) => {
        // A freshly raised notice is never pre-dismissed, whatever the
        // user did to the previous one.
        draft.noticeDismissed = false
        draft.notice = notice
      },
      dismissNotice: (draft) => { draft.noticeDismissed = true },
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
      // resource detail modal (0.2.x): one open detail at a time; the modal
      // owns its batch selection (open actions go through the OS file manager)
      openDetail: (draft, id) => { draft.detail = { id, loading: true, data: null, status: null, error: null, selected: [], busy: false } },
      toggleDetailSelect: (draft, key) => {
        if (draft.detail === null) return
        draft.detail.selected = draft.detail.selected.includes(key)
          ? draft.detail.selected.filter(candidate => candidate !== key)
          : [...draft.detail.selected, key]
      },
      setDetailSelected: (draft, keys) => {
        if (draft.detail !== null) draft.detail.selected = keys
      },
      setDetailBusy: (draft, busy) => {
        if (draft.detail !== null) draft.detail.busy = busy === true
      },
      setDetailData: (draft, data) => {
        if (draft.detail !== null && draft.detail.id === data?.sessionId) {
          draft.detail.loading = false
          draft.detail.data = data
        }
      },
      setDetailStatus: (draft, status) => {
        if (draft.detail !== null) draft.detail.status = status
      },
      setDetailError: (draft, message) => {
        if (draft.detail !== null) {
          draft.detail.loading = false
          draft.detail.error = message
        }
      },
      closeDetail: (draft) => { draft.detail = null },
    },
  })
}

// ---------------------------------------------------------------------------
// Controller — data loading, event subscription, mutation plumbing
// ---------------------------------------------------------------------------

function createController({ ctx, api, instance }) {
  let loadSeq = 0
  let detailSeq = 0
  let refreshTimer
  let eventDisposers = []

  async function load(view) {
    const target = view ?? instance.getSnapshot().view
    const seq = ++loadSeq
    const result = await api.list(target)
    if (seq !== loadSeq) return
    if (result?.ok === true) {
      instance.actions.setRows(result.value?.rows ?? [], result.value?.counts ?? { all: 0, archived: 0, deleted: 0 }, result.value?.sources ?? null)
    } else {
      console.warn('[dsh-session-manager] list failed:', describeError(result?.error), result?.error?.details ?? '')
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
      console.warn(`[dsh-session-manager] ${name} failed:`, describeError(result?.error), result?.error?.details ?? '')
      instance.actions.setNotice({ tone: 'error', text: t('error.request', { reason: formatError(result?.error) }) })
      return false
    }
    // The operated-on rows just left this view; start the next batch clean.
    instance.actions.selectAll([])
    await load()
    const failures = (result.value?.results ?? []).filter(entry => entry?.ok !== true)
    if (failures.length === 0 && (name === 'deleteSoft' || name === 'purge')) {
      // P3 caveat: the directory is gone, but rc.1 has no API to
      // invalidate the host corpus, so the official sidebar's cached
      // list can keep showing the row until the app restarts.
      instance.actions.setNotice({ tone: 'info', text: t('notice.stale') })
    }
    if (failures.length > 0) {
      const first = failures[0]
      console.warn(`[dsh-session-manager] ${name}: ${failures.length} of ${ids.length} failed:`, describeError(first?.error), first?.error?.details ?? '')
      instance.actions.setNotice({
        tone: 'error',
        // The host has no per-id message field today, but read one when it
        // exists rather than always printing the error code.
        text: t('notice.partial', { n: failures.length, reason: formatError(first?.error?.message ?? first?.error) }),
      })
    }
    return true
  }

  /** Load one session's resource view + cleanup status into the detail modal. */
  async function openResources(id) {
    const seq = ++detailSeq
    instance.actions.openDetail(id)
    const [resources, status] = await Promise.all([
      api.resources(id),
      api.cleanupStatus(id).catch(() => null),
    ])
    if (seq !== detailSeq) return
    if (resources?.ok === true) {
      instance.actions.setDetailData(resources.value)
    } else {
      console.warn('[dsh-session-manager] resources failed:', describeError(resources?.error))
      instance.actions.setDetailError(formatError(resources?.error))
      return
    }
    if (status?.ok === true) instance.actions.setDetailStatus(status.value?.results?.[0] ?? null)
  }

  /** Open one resource: reveal it in the OS file manager. */
  async function openOne(sessionId, path) {
    const result = await api.openResource(sessionId, path)
    if (result?.ok !== true) {
      const message = formatError(result?.error)
      console.warn('[dsh-session-manager] openResource failed:', describeError(result?.error))
      instance.actions.setNotice({ tone: 'error', text: t('res.openFailed', { reason: message }) })
      return false
    }
    return true
  }

  /** Batch-open every selected resource; failures surface per-row. */
  async function openSelected() {
    const detail = instance.getSnapshot().detail
    if (detail === null || detail.busy === true) return
    const rowsByKey = new Map((detail.data?.resources ?? []).map(row => [rowKeyOf(row), row]))
    const targets = detail.selected.map(key => rowsByKey.get(key)).filter(row => row !== undefined)
    if (targets.length === 0) return
    instance.actions.setDetailBusy(true)
    let failures = 0
    for (const row of targets) {
      const opened = await openOne(detail.id, row.identifier)
      if (opened !== true) failures += 1
    }
    instance.actions.setDetailBusy(false)
    if (failures === 0) {
      instance.actions.setNotice({ tone: 'info', text: t('res.batchOpened', { n: targets.length }) })
      instance.actions.setDetailSelected([])
    }
  }

  /** Reveal the session workspace itself in the file manager. */
  async function openWorkspace() {
    const detail = instance.getSnapshot().detail
    if (detail === null) return
    // '.' resolves host-side to the session workspace root (guarded to the cwd)
    await openOne(detail.id, '.')
  }

  function dispose() {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    for (const disposer of eventDisposers.splice(0)) {
      if (typeof disposer === 'function') disposer()
    }
  }

  return { load, ensureLoaded, scheduleRefresh, subscribeEvents, runOp, openResources, openOne, openSelected, openWorkspace, dispose }
}

/** Stable per-row key used by the modal's batch selection. */
function rowKeyOf(row) {
  return `${row.resourceType}:${row.identifier}`
}

/** Path-shaped resources can be opened/revealed; env vars and processes cannot. */
const OPENABLE_TYPES = new Set(['file', 'configuration', 'download', 'directory', 'dependency'])


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
    quickActions.push(h(Button, { key: 'resources', variant: 'ghost', size: 'sm', onClick: () => void controller.openResources(row.id) }, t('action.resources')))
    quickActions.push(h(Button, { key: 'restore', variant: 'ghost', size: 'sm', icon: h(IconUnarchiveOutlineRegular, { size: 14 }), onClick: () => void controller.runOp('restore', [row.id], t) }, t('action.restore')))
    quickActions.push(h(Button, { key: 'purge', variant: 'ghost', size: 'sm', className: 'dsm-dangerButton', icon: h(IconTrashOutlineRegular, { size: 14 }), 'aria-label': t('action.purge'), onClick: () => purgeOne(row.id) }))
  } else {
    quickActions.push(h(Button, { key: 'resources', variant: 'ghost', size: 'sm', onClick: () => void controller.openResources(row.id) }, t('action.resources')))
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
          ? [formatRelativeTime(row.deletedAt, t), typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null].filter(Boolean).join(' · ')
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

// ---------------------------------------------------------------------------
// Resource detail modal — "what did this session produce?"
// Backed by the `resources` + `cleanupStatus` RPCs; groups the session's
// baseline and journal-derived resources by type with ownership/status pills.
// ---------------------------------------------------------------------------

const RES_GROUP_ORDER = ['file', 'configuration', 'download', 'directory', 'dependency', 'environment_variable', 'process', 'other']
const RES_GROUP_KEY = {
  file: 'res.group.file',
  configuration: 'res.group.configuration',
  download: 'res.group.download',
  directory: 'res.group.directory',
  dependency: 'res.group.dependency',
  environment_variable: 'res.group.env',
  process: 'res.group.process',
  other: 'res.group.other',
}
const RES_OWNERSHIP_KEY = {
  session_created: 'res.own.created',
  session_modified: 'res.own.modified',
  session_deleted: 'res.own.deleted',
  session_installed: 'res.own.installed',
  session_configured: 'res.own.configured',
  preexisting: 'res.own.preexisting',
}
const RES_STATUS_KEY = {
  'matches-baseline': 'res.status.matches',
  'differs-from-baseline': 'res.status.differs',
  present: 'res.status.present',
  missing: 'res.status.missing',
  'see-actions': 'res.status.actions',
  informational: 'res.status.info',
  unknown: 'res.status.unknown',
  unreadable: 'res.status.unreadable',
}
const RES_CLEANUP_KEY = {
  active: 'res.cleanup.active',
  delete_requested: 'res.cleanup.requested',
  rolling_back: 'res.cleanup.running',
  rollback_failed: 'res.cleanup.failed',
  rollback_verified: 'res.cleanup.verified',
  session_deleted: 'res.cleanup.sessionDeleted',
  complete: 'res.cleanup.complete',
  none: 'res.cleanup.none',
  legacy: 'res.cleanup.legacy',
}

function ownershipPill(ownership, t) {
  const key = RES_OWNERSHIP_KEY[ownership]
  if (key === undefined) return null
  return h(Badge, { key: 'own', label: t(key), className: ownership === 'preexisting' ? undefined : 'dsm-pillOwn' })
}

function statusPill(status, t) {
  const key = RES_STATUS_KEY[status]
  if (key === undefined) return null
  const positive = status === 'matches-baseline' || status === 'present'
  const negative = status === 'differs-from-baseline' || status === 'missing'
  return h(Badge, {
    key: 'status',
    label: t(key),
    className: positive ? 'dsm-pillOwn' : negative ? 'dsm-pillMissing' : undefined,
  })
}

function ResourcesModal({ detail, actions, controller, t }) {
  const data = detail.data
  const resources = data?.resources ?? []
  const groups = new Map()
  for (const row of resources) {
    const type = RES_GROUP_ORDER.includes(row.resourceType) ? row.resourceType : 'other'
    if (groups.has(type) === false) groups.set(type, [])
    groups.get(type).push(row)
  }
  const openableRows = resources.filter(row => OPENABLE_TYPES.has(row.resourceType))
  const cleanupState = detail.status?.cleanup?.state ?? (data?.tracked === false ? 'legacy' : 'none')
  const conflicts = Array.isArray(detail.status?.cleanup?.conflicts) ? detail.status.cleanup.conflicts : []
  const baseline = data?.baseline ?? null
  const tracked = data?.tracked === true

  return h(Modal, {
    open: true,
    onClose: actions.closeDetail,
    title: t('res.title'),
    closeLabel: t('action.closeModal'),
    className: 'dsm-resDialog',
    contentClassName: 'dsm-resContent',
    footer: [h(Button, { key: 'close', variant: 'primary', size: 'sm', onClick: actions.closeDetail }, t('action.closeModal'))],
  },
    h('div', { className: 'dsm-resBody' },
      detail.loading === true && h('p', { className: 'dsm-resHint' }, t('res.loading')),
      detail.error !== null && h('p', { className: 'dsm-resHint dsm-resHintError' }, t('error.request', { reason: detail.error })),
      detail.loading === false && detail.error === null && data !== null && [
        h('div', { key: 'meta', className: 'dsm-resMetaLine' },
          h('span', { key: 'cleanup' }, `${t('res.cleanup')}: ${t(RES_CLEANUP_KEY[cleanupState] ?? 'res.cleanup.none')}`),
          baseline !== null && h('span', { key: 'files' }, t('res.baselineFiles', { n: baseline.fileCount })),
          baseline?.cwd !== undefined && h('span', { key: 'cwd', className: 'dsm-resCwd' }, baseline.cwd),
          baseline?.truncated === true && h('span', { key: 'trunc' }, t('res.truncated')),
        ),
        conflicts.length > 0 && h('div', { key: 'conflicts', className: 'dsm-resConflicts' },
          t('res.conflicts', { n: conflicts.length })),
        data.tracked === false && h('p', { key: 'legacy', className: 'dsm-resHint' }, t('res.legacy')),
        data.tracked === true && resources.length === 0 && h('p', { key: 'empty', className: 'dsm-resHint' }, t('res.empty')),

        // open toolbar: everything opens in the OS file manager (the only method)
        tracked && h('div', { key: 'toolbar', className: 'dsm-resToolbar' },
          h('span', { key: 'hint', className: 'dsm-resToolbarHint' }, t('res.fileManagerHint')),
          h(Button, { key: 'ws', variant: 'ghost', size: 'sm', disabled: detail.busy === true, onClick: () => void controller.openWorkspace() }, t('res.openWorkspace')),
          h(Button, {
            key: 'selectAll',
            variant: 'ghost',
            size: 'sm',
            disabled: openableRows.length === 0,
            onClick: () => actions.setDetailSelected(openableRows.map(row => rowKeyOf(row))),
          }, t('res.selectAll')),
          h(Button, {
            key: 'invert',
            variant: 'ghost',
            size: 'sm',
            disabled: openableRows.length === 0,
            onClick: () => actions.setDetailSelected(openableRows.map(row => rowKeyOf(row)).filter(key => detail.selected.includes(key) === false)),
          }, t('res.invert')),
          h(Button, {
            key: 'batch',
            variant: 'ghost',
            size: 'sm',
            disabled: detail.selected.length === 0 || detail.busy === true,
            onClick: () => void controller.openSelected(),
          }, t('res.openSelected', { n: detail.selected.length })),
        ),

        RES_GROUP_ORDER.map(type => {
          const rows = groups.get(type)
          if (rows === undefined || rows.length === 0) return null
          const openable = OPENABLE_TYPES.has(type)
          return h('div', { key: type, className: 'dsm-resGroup' },
            h('div', { className: 'dsm-resGroupTitle' }, `${t(RES_GROUP_KEY[type])} · ${rows.length}`),
            h('div', { className: 'dsm-resGroupList' },
              rows.map(row => {
                const key = rowKeyOf(row)
                const selected = detail.selected.includes(key)
                return h('div', { key, className: cx('dsm-resRow', openable === true && 'dsm-resRowOpenable', selected === true && 'dsm-resRowSelected') },
                  openable === true && h('div', { className: 'dsm-resCheck' },
                    h(Checkbox, {
                      checked: selected,
                      onChange: () => actions.toggleDetailSelect(key),
                      label: t('res.select', { name: row.identifier }),
                    })),
                  h('div', { className: 'dsm-resMain' },
                    h('div', { className: 'dsm-resId' }, row.identifier),
                    h('div', { className: 'dsm-resExtra' }, [
                      row.actions !== undefined && row.actions.length > 0 ? `${t('res.lastAction')}: ${row.actions.join(', ')}` : null,
                      typeof row.url === 'string' ? row.url : null,
                      row.before !== undefined && row.before !== null ? `v${row.before} → ${row.after ?? '—'}` : null,
                    ].filter(Boolean).join(' · ')),
                  ),
                  h('div', { className: 'dsm-resPills' },
                    ownershipPill(row.ownership, t),
                    statusPill(row.status, t),
                    openable === true && h(Button, {
                      key: 'open',
                      variant: 'ghost',
                      size: 'sm',
                      'aria-label': t('res.open'),
                      disabled: detail.busy === true,
                      onClick: () => void controller.openOne(detail.id, row.identifier),
                    }, t('res.open')),
                  ),
                )
              })),
          )
        }),
      ],
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
  const detail = useStore(s => s.detail)
  const config = useStore(s => s.config)
  const sources = useStore(s => s.sources)
  const noticeDismissed = useStore(s => s.noticeDismissed)
  const degraded = sources !== null && sources.available !== true

  useEffect(() => { controller.ensureLoaded() }, [controller])
  // Style self-heal: apply() injects the stylesheet once per page, but a
  // page that booted through a failed plugin bundle can end up without
  // the tag. Re-assert it on every panel mount (idempotent: one
  // getElementById when present) so the panel never renders unstyled.
  useEffect(() => { ensureStyle(cssText) }, [])

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
    notice !== null && !noticeDismissed && h('div', { className: cx('dsm-notice', notice.tone === 'error' ? 'dsm-noticeError' : 'dsm-noticeInfo'), role: 'status' },
      h('span', null, notice.text),
      h('button', { className: 'dsm-noticeClose', onClick: () => actions.dismissNotice(), 'aria-label': t('action.dismiss') }, '×'),
    ),
    // rc.1 keeps no corpus-invalidation API, so a session deleted on
    // disk can still be listed by the official sidebar until the next
    // restart (audit P3). Said once here, not per row.
    degraded && h('div', { className: 'dsm-notice dsm-noticeInfo', role: 'status' }, h('span', null, t('notice.degraded'))),
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
    detail !== null && h(ResourcesModal, { detail, actions, controller, t }),
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
      return
    }
    // the schema default is autoRefresh: true — a failed config call must not
    // silently turn event-driven refresh off
    controller.subscribeEvents()
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
