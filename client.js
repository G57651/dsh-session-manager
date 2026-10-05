window.__ModuleLoader__.load({
	id: "@g57651/dsh-session-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var __modules = {
			"./styles.css.js": function (require, module, exports) {
				module.exports = { cssText: "/* dsh-session-manager — client styles, injected as a style tag by apply().\n   Class prefix .dsm- avoids collisions with the host. Colors, borders, and\n   radii ride --dsw-alias-* / --dsw-radius-* semantic tokens only, so light and\n   dark follow the host theme automatically; no theme selectors live here. */\n\n.dsm-page {\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n  box-sizing: border-box;\n  height: 100%;\n  min-width: 0;\n  min-height: 0;\n  padding: 24px clamp(20px, 4vw, 44px) 40px;\n  overflow: hidden;\n}\n\n.dsm-head {\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n}\n\n.dsm-headRow {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n}\n\n.dsm-title {\n  margin: 0;\n  font-size: 20px;\n  font-weight: 600;\n  letter-spacing: -0.01em;\n  color: var(--dsw-alias-label-primary);\n}\n\n.dsm-headActions {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.dsm-tabs {\n  width: min(460px, 100%);\n}\n\n.dsm-tabCount {\n  opacity: 0.65;\n}\n\n.dsm-list {\n  display: flex;\n  flex: 1 1 auto;\n  flex-direction: column;\n  min-height: 0;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-md);\n  overflow-x: hidden;\n  overflow-y: auto;\n  scrollbar-gutter: stable;\n  --dsh-scrollbar-width: 9px;\n  --dsh-scrollbar-thumb-border: 2px;\n}\n\n.dsm-row {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 10px 14px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n  transition: background 120ms ease;\n}\n\n.dsm-row:last-child {\n  border-bottom: none;\n}\n\n.dsm-row:hover,\n.dsm-rowSelected {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dsm-rowClickable {\n  cursor: pointer;\n}\n\n.dsm-checkCell {\n  display: flex;\n  flex: none;\n  align-items: center;\n}\n\n/* Keep the primitive checkbox's accessible label but hide its visible text:\n   the row title right next to it already says what this is. */\n.dsm-checkCell label > span {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n  clip: rect(0 0 0 0);\n  white-space: nowrap;\n}\n\n.dsm-rowMain {\n  display: flex;\n  flex: 1;\n  min-width: 0;\n  flex-direction: column;\n  gap: 3px;\n}\n\n.dsm-rowTitleLine {\n  display: flex;\n  min-width: 0;\n  align-items: center;\n  gap: 6px;\n}\n\n.dsm-rowTitle {\n  overflow: hidden;\n  font-size: 13px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.dsm-rowTitleMuted {\n  color: var(--dsw-alias-label-secondary);\n  font-weight: 400;\n}\n\n.dsm-pill {\n  flex: none;\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-secondary);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 999px;\n}\n\n.dsm-pillRunning {\n  color: var(--dsw-alias-link);\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.dsm-pillMissing {\n  color: var(--dsw-alias-state-error-primary);\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.dsm-rowMeta {\n  overflow: hidden;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.dsm-rowActions {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: 4px;\n  opacity: 0;\n  transition: opacity 120ms ease;\n}\n\n.dsm-row:hover .dsm-rowActions,\n.dsm-row:focus-within .dsm-rowActions {\n  opacity: 1;\n}\n\n.dsm-dangerButton.dsm-dangerButton {\n  color: var(--dsw-alias-state-error-primary);\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.dsm-dangerFill.dsm-dangerFill {\n  background: var(--dsw-alias-state-error-primary);\n  color: var(--dsw-alias-bg-base);\n}\n\n.dsm-batchBar {\n  position: sticky;\n  bottom: 0;\n  z-index: 2;\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  margin-top: auto;\n  padding: 10px 14px;\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: var(--dsw-radius-md);\n  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.08);\n}\n\n.dsm-batchCount {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dsm-batchOps {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 6px;\n}\n\n.dsm-stateBox {\n  display: flex;\n  flex: 1;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 56px 24px;\n  text-align: center;\n}\n\n.dsm-stateIcon {\n  color: var(--dsw-alias-label-tertiary);\n  opacity: 0.7;\n}\n\n.dsm-stateTitle {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n}\n\n.dsm-stateHint {\n  margin: 0;\n  max-width: 420px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.dsm-notice {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 8px 12px;\n  font-size: 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: var(--dsw-radius-sm);\n}\n\n.dsm-noticeError {\n  color: var(--dsw-alias-state-error-primary);\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.dsm-noticeInfo {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dsm-noticeClose {\n  flex: none;\n  padding: 0 4px;\n  font-size: 14px;\n  line-height: 1;\n  color: inherit;\n  background: none;\n  border: none;\n  cursor: pointer;\n}\n\n.dsm-purgeList {\n  margin: 0;\n  padding: 0;\n  list-style: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dsm-purgeList li {\n  padding: 3px 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.dsm-skeletonRow {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 12px 14px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n}\n\n.dsm-skeletonRow:last-child {\n  border-bottom: none;\n}\n\n.dsm-skeletonBar {\n  height: 10px;\n  border-radius: 4px;\n  background: var(--dsw-alias-interactive-bg-hover);\n  animation: dsm-pulse 1.4s ease-in-out infinite;\n}\n\n.dsm-skeletonBarShort {\n  width: 40%;\n}\n\n@keyframes dsm-pulse {\n  0%,\n  100% {\n    opacity: 0.55;\n  }\n  50% {\n    opacity: 1;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .dsm-skeletonBar {\n    animation: none;\n  }\n\n  .dsm-row,\n  .dsm-rowActions {\n    transition: none;\n  }\n}\n\n/* --- resource detail modal (0.2.x) ---------------------------------------- */\n\n.dsm-resBody {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  max-height: 56vh;\n  overflow: auto;\n  min-width: min(560px, 72vw);\n}\n\n.dsm-resMetaLine {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: baseline;\n  gap: 4px 14px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dsm-resCwd {\n  overflow-wrap: anywhere;\n}\n\n.dsm-resConflicts {\n  padding: 8px 10px;\n  font-size: 12px;\n  color: var(--dsw-alias-state-error-primary);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: var(--dsw-radius-md);\n}\n\n.dsm-resGroup {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.dsm-resGroupTitle {\n  margin: 6px 0 2px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dsm-resGroupList {\n  display: flex;\n  flex-direction: column;\n}\n\n.dsm-resRow {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 5px 0;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n}\n\n.dsm-resRow:last-child {\n  border-bottom: none;\n}\n\n.dsm-resMain {\n  flex: 1 1 auto;\n  min-width: 0;\n}\n\n.dsm-resId {\n  font-size: 13px;\n  color: var(--dsw-alias-label-primary);\n  overflow-wrap: anywhere;\n}\n\n.dsm-resExtra {\n  margin-top: 1px;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow-wrap: anywhere;\n}\n\n.dsm-resPills {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: 6px;\n}\n\n.dsm-pillOwn {\n  color: var(--dsw-alias-link);\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.dsm-resHint {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dsm-resHintError {\n  color: var(--dsw-alias-state-error-primary);\n}\n" };
			},
			"./locales.js": function (require, module, exports) {

				// dsh-session-manager — client dictionaries. `zh` is the key source of truth;
				// `en` must declare the same key set. Placeholders use {name} syntax.

				// Build convention (scripts/build-client.mjs): declarations are plain `const`,
				// and the single trailing `export { ... }` becomes the module's exports.

				const zh = {  'panel': '会话管理',
				  'view.label': '会话视图',
				  'view.all': '全部',
				  'view.archived': '已归档',
				  'view.deleted': '已删除',
				  'action.refresh': '刷新',
				  'action.batch': '批量管理',
				  'action.doneSelect': '完成',
				  'action.cancel': '取消',
				  'action.retry': '重试',
				  'action.closeModal': '关闭',
				  'action.dismiss': '关闭提示',
				  'action.archive': '归档',
				  'action.unarchive': '取消归档',
				  'action.delete': '删除',
				  'action.restore': '恢复',
				  'action.purge': '彻底删除',
				  'action.resources': '资源',
				  'batch.bar': '批量操作',
				  'batch.selected': '已选 {n} 项',
				  'batch.all': '全选',
				  'batch.invert': '反选',
				  'batch.cancel': '取消选择',
				  'batch.archive': '归档所选',
				  'batch.unarchive': '取消归档所选',
				  'batch.delete': '删除所选',
				  'batch.restore': '恢复所选',
				  'batch.purge': '彻底删除所选',
				  'row.untitled': '无标题会话',
				  'row.select': '选择会话：{title}',
				  'badge.archived': '已归档',
				  'badge.running': '运行中',
				  'badge.subagent': '子会话',
				  'badge.missing': '已丢失',
				  'time.now': '刚刚',
				  'time.minutesAgo': '{n} 分钟前',
				  'time.hoursAgo': '{n} 小时前',
				  'time.daysAgo': '{n} 天前',
				  'loading.text': '正在加载会话…',
				  'empty.all.title': '暂无会话',
				  'empty.all.hint': '在左侧新建对话后，会话会出现在这里。',
				  'empty.archived.title': '没有已归档的会话',
				  'empty.archived.hint': '归档的会话会从主列表移到这里，可随时取消归档。',
				  'empty.deleted.title': '回收站是空的',
				  'empty.deleted.hint': '删除的会话先进入回收站，可随时恢复或彻底删除。',
				  'error.list': '会话列表加载失败',
				  'error.generic': '操作失败',
				  'error.request': '请求失败（{reason}）',
				  'notice.partial': '{n} 项操作失败（{reason}）',
				  'notice.degraded': '部分会话服务不可用，列表可能不完整。',
				  'notice.stale': '已删除的会话可能仍出现在官方侧栏，重启后消失。',
				  'purge.title': '彻底删除 {n} 个会话？',
				  'purge.description': '所选会话的全部记录将从磁盘移除，此操作无法恢复。',
				  'purge.confirm': '彻底删除',
				  'purge.more': '以及另外 {n} 个会话',
				  'res.title': '会话资源',
				  'res.loading': '正在加载资源…',
				  'res.cleanup': '清理状态',
				  'res.cleanup.active': '跟踪中',
				  'res.cleanup.requested': '待清理',
				  'res.cleanup.running': '清理中',
				  'res.cleanup.failed': '清理未完成（存在冲突）',
				  'res.cleanup.verified': '已回滚',
				  'res.cleanup.sessionDeleted': '会话已删除',
				  'res.cleanup.complete': '已完成',
				  'res.cleanup.none': '无清理记录',
				  'res.cleanup.legacy': '未跟踪',
				  'res.baselineFiles': '基线文件 {n} 个',
				  'res.truncated': '工作区过大，部分内容未纳入跟踪',
				  'res.conflicts': '⚠ 有 {n} 个资源因外部改动被保护而未回滚，详见 cleanupStatus',
				  'res.legacy': '该会话没有资源跟踪记录（旧版本创建），无法展示它产生过的资源。',
				  'res.empty': '没有记录到资源变化。',
				  'res.lastAction': '动作',
				  'res.group.file': '文件',
				  'res.group.configuration': '配置',
				  'res.group.download': '下载',
				  'res.group.directory': '目录',
				  'res.group.dependency': '依赖',
				  'res.group.env': '环境变量',
				  'res.group.process': '进程',
				  'res.own.created': '会话新建',
				  'res.own.modified': '会话修改',
				  'res.own.deleted': '会话删除',
				  'res.own.installed': '会话安装',
				  'res.own.configured': '会话配置',
				  'res.own.preexisting': '原有',
				  'res.status.matches': '与基线一致',
				  'res.status.differs': '已偏离基线',
				  'res.status.present': '存在',
				  'res.status.missing': '已不存在',
				  'res.status.actions': '见动作',
				  'res.status.info': '记录',
				  'res.status.unknown': '未知',
				  'res.status.unreadable': '不可读',
				}

				const en = {
				  'panel': 'Sessions',
				  'view.label': 'Session views',
				  'view.all': 'All',
				  'view.archived': 'Archived',
				  'view.deleted': 'Trash',
				  'action.refresh': 'Refresh',
				  'action.batch': 'Batch',
				  'action.doneSelect': 'Done',
				  'action.cancel': 'Cancel',
				  'action.retry': 'Retry',
				  'action.closeModal': 'Close',
				  'action.dismiss': 'Dismiss',
				  'action.archive': 'Archive',
				  'action.unarchive': 'Unarchive',
				  'action.delete': 'Delete',
				  'action.restore': 'Restore',
				  'action.purge': 'Delete forever',
				  'action.resources': 'Resources',
				  'batch.bar': 'Batch actions',
				  'batch.selected': '{n} selected',
				  'batch.all': 'Select all',
				  'batch.invert': 'Invert',
				  'batch.cancel': 'Clear',
				  'batch.archive': 'Archive selected',
				  'batch.unarchive': 'Unarchive selected',
				  'batch.delete': 'Delete selected',
				  'batch.restore': 'Restore selected',
				  'batch.purge': 'Delete selected forever',
				  'row.untitled': 'Untitled session',
				  'row.select': 'Select session: {title}',
				  'badge.archived': 'Archived',
				  'badge.running': 'Running',
				  'badge.subagent': 'Subagent',
				  'badge.missing': 'Missing',
				  'time.now': 'just now',
				  'time.minutesAgo': '{n}m ago',
				  'time.hoursAgo': '{n}h ago',
				  'time.daysAgo': '{n}d ago',
				  'loading.text': 'Loading sessions…',
				  'empty.all.title': 'No sessions yet',
				  'empty.all.hint': 'Start a conversation and it will show up here.',
				  'empty.archived.title': 'Nothing archived',
				  'empty.archived.hint': 'Archived sessions move here out of the main list; unarchive any time.',
				  'empty.deleted.title': 'Trash is empty',
				  'empty.deleted.hint': 'Deleted sessions rest here until you restore or delete them forever.',
				  'error.list': 'Failed to load the session list',
				  'error.generic': 'The operation failed',
				  'error.request': 'Request failed ({reason})',
				  'notice.partial': '{n} item(s) failed ({reason})',
				  'notice.degraded': 'Some session services are unavailable; this list may be incomplete.',
				  'notice.stale': 'Deleted sessions can still show in the official sidebar until a restart.',
				  'purge.title': 'Delete {n} session(s) forever?',
				  'purge.description': 'Their records will be removed from disk. This cannot be undone.',
				  'purge.confirm': 'Delete forever',
				  'purge.more': 'and {n} more',
				  'res.title': 'Session resources',
				  'res.loading': 'Loading resources…',
				  'res.cleanup': 'Cleanup',
				  'res.cleanup.active': 'Tracking',
				  'res.cleanup.requested': 'Cleanup requested',
				  'res.cleanup.running': 'Cleaning up',
				  'res.cleanup.failed': 'Cleanup incomplete (conflicts)',
				  'res.cleanup.verified': 'Rolled back',
				  'res.cleanup.sessionDeleted': 'Session deleted',
				  'res.cleanup.complete': 'Complete',
				  'res.cleanup.none': 'No cleanup recorded',
				  'res.cleanup.legacy': 'Untracked',
				  'res.baselineFiles': '{n} baseline files',
				  'res.truncated': 'Workspace too large; part of it is not tracked',
				  'res.conflicts': '⚠ {n} resource(s) preserved because of external edits — see cleanupStatus',
				  'res.legacy': 'This session has no resource tracking (created on an older version); what it produced cannot be shown.',
				  'res.empty': 'No resource changes recorded.',
				  'res.lastAction': 'Actions',
				  'res.group.file': 'Files',
				  'res.group.configuration': 'Configuration',
				  'res.group.download': 'Downloads',
				  'res.group.directory': 'Directories',
				  'res.group.dependency': 'Dependencies',
				  'res.group.env': 'Environment variables',
				  'res.group.process': 'Processes',
				  'res.own.created': 'Created by session',
				  'res.own.modified': 'Modified by session',
				  'res.own.deleted': 'Deleted by session',
				  'res.own.installed': 'Installed by session',
				  'res.own.configured': 'Configured by session',
				  'res.own.preexisting': 'Pre-existing',
				  'res.status.matches': 'Matches baseline',
				  'res.status.differs': 'Differs from baseline',
				  'res.status.present': 'Present',
				  'res.status.missing': 'Gone',
				  'res.status.actions': 'See actions',
				  'res.status.info': 'Recorded',
				  'res.status.unknown': 'Unknown',
				  'res.status.unreadable': 'Unreadable',
				}


				module.exports = {  zh, en  };
			},
		};
		var __cache = {};
		function __req(name) {
			if (!(name in __cache)) {
				var m = { exports: {} };
				__modules[name](require, m, m.exports);
				__cache[name] = m.exports;
			}
			return __cache[name];
		}
		const { createElement, useCallback, useEffect, useMemo } = require("react")
		const { Button, Checkbox, Modal, Pill, SegmentedTabs } = require("@deepseek-ai/dsh-client-ui-primitives")
		const { IconArchiveOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, IconUnarchiveOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives")
		const { defineStore } = require("@deepseek-ai/dsh-client-store")
		const { zh, en } = __req("./locales.js")
		const { cssText } = __req("./styles.css.js")
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
		      config: { confirmPurge: true, autoRefresh: true, maxBatchSize: 200, titleFetchLimit: 300 },
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
		      // resource detail modal (0.2.x): one open detail at a time
		      openDetail: (draft, id) => { draft.detail = { id, loading: true, data: null, status: null, error: null } },
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

		  function dispose() {
		    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
		    for (const disposer of eventDisposers.splice(0)) {
		      if (typeof disposer === 'function') disposer()
		    }
		  }

		  return { load, ensureLoaded, scheduleRefresh, subscribeEvents, runOp, openResources, dispose }
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

		// ---------------------------------------------------------------------------
		// Resource detail modal — "what did this session produce?"
		// Backed by the `resources` + `cleanupStatus` RPCs; groups the session's
		// baseline and journal-derived resources by type with ownership/status pills.
		// ---------------------------------------------------------------------------

		const RES_GROUP_ORDER = ['file', 'configuration', 'download', 'directory', 'dependency', 'environment_variable', 'process']
		const RES_GROUP_KEY = {
		  file: 'res.group.file',
		  configuration: 'res.group.configuration',
		  download: 'res.group.download',
		  directory: 'res.group.directory',
		  dependency: 'res.group.dependency',
		  environment_variable: 'res.group.env',
		  process: 'res.group.process',
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

		function ResourcesModal({ detail, actions, t }) {
		  const data = detail.data
		  const resources = data?.resources ?? []
		  const groups = new Map()
		  for (const row of resources) {
		    const type = RES_GROUP_ORDER.includes(row.resourceType) ? row.resourceType : 'file'
		    if (groups.has(type) === false) groups.set(type, [])
		    groups.get(type).push(row)
		  }
		  const cleanupState = detail.status?.cleanup?.state ?? (data?.tracked === false ? 'legacy' : 'none')
		  const conflicts = Array.isArray(detail.status?.cleanup?.conflicts) ? detail.status.cleanup.conflicts : []
		  const baseline = data?.baseline ?? null

		  return h(Modal, {
		    open: true,
		    onClose: actions.closeDetail,
		    title: t('res.title'),
		    closeLabel: t('action.closeModal'),
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
		        RES_GROUP_ORDER.map(type => {
		          const rows = groups.get(type)
		          if (rows === undefined || rows.length === 0) return null
		          return h('div', { key: type, className: 'dsm-resGroup' },
		            h('div', { className: 'dsm-resGroupTitle' }, `${t(RES_GROUP_KEY[type])} · ${rows.length}`),
		            h('div', { className: 'dsm-resGroupList' },
		              rows.map(row => h('div', { key: `${row.resourceType}:${row.identifier}`, className: 'dsm-resRow' },
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
		                ),
		              )),
		            ),
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


		module.exports = {  inject, apply  };
		return module.exports;
	},
});
