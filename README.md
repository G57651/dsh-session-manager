# dsh-session-manager

DeepSeek Harness Web UI 会话管理插件：在主页侧边栏新增一个「会话管理」面板，提供全部 / 已归档 / 已删除三个视图、手动 + 自动刷新，以及批量管理（归档 / 取消归档 / 删除 / 恢复 / 彻底删除）。

0.2.0 起插件同时是一个 **Session Resource Lifecycle Manager（会话资源生命周期管理器）**：会话在其工作目录里创建 / 修改 / 删除的文件、安装的依赖、设置的环境变量、发起的下载都会被记录到按会话隔离的 Change Journal；删除会话时按 Journal 反向清理或回滚这些资源，最后才销毁 Journal。

## 功能

- **全部**：未删除的所有会话（含已归档，带「已归档」徽标），显示标题、相对更新时间、大小、工作目录；行悬停有归档/删除快捷操作。
- **已归档**：原生归档会话（`ctx.workspaceRegistry`），可批量取消归档。
- **已删除**：插件自建回收站清单。删除为**软删除**（借原生归档从主列表隐藏 + 回收站记录；0.1.4 起会话目录同样被移除，恢复仅还原列表行、不还原磁盘数据）；可批量恢复、可彻底删除（二次确认后停活动 → 资源回滚 → 移除 `$DSH_HOME/sessions` 下的会话目录）。
- **资源生命周期跟踪（0.2.0）**，见下文「资源生命周期」：
  - **Baseline**：插件首次看到会话时对其工作目录做有界扫描（文件数 / 深度 / 排除目录均受配置约束），基线内一切资源记为 `preexisting`，永不因会话删除而被移除。
  - **Change Journal**：`tool/call` 事件驱动（shell 命令解析 export/unset、后台进程、下载意图）+ `tool/result` 触发的防抖工作区 diff + 删除前的最终 diff，全部以 append-only JSONL 逐条落盘。
  - **Ownership**：每条变更在记录时刻对照 Baseline 判定归属（`session_created` / `session_modified` / `session_deleted` / `session_installed` / `session_configured` / `preexisting`）并冻结进记录。
  - **Cleanup Engine**：删除 / 彻底删除时执行 `卸载会话新装依赖 → 恢复被删文件 → 恢复被改文件（含配置）→ 移除会话新建文件与目录 → 恢复环境变量 → 校验 → 删会话目录 → 删 Journal` 的完整流程；每一步先做状态校验（当前 hash ≠ Journal 预期 → 记为 CONFLICT，安全模式下跳过而不静默覆盖），幂等可重入。
  - **崩溃恢复**：清理状态机（`cleanup.json`）先于动作落盘；进程崩溃 / 重启后自动续跑未完成的清理，绝不留下半删除状态。
- **刷新**：手动刷新按钮；同时监听 `api-session/added|removed|status|activity` 远程事件自动同步（可在配置中关闭）。
- **批量管理**：显式进入选择模式（复选框 + 全选 / 反选 + 底部浮动操作栏），操作集随当前视图变化。
- 中英双语（跟随宿主语言）、明暗主题自动跟随（仅使用 `--dsw-alias-*` 语义 token）。

## 资源生命周期（0.2.0）

### 数据布局

```text
$DSH_HOME/dsh-session-manager/tracking/<encoded-session-id>/
├── baseline.json     # 首次见到的有界工作区快照（含依赖快照）
├── changes.jsonl     # append-only 变更日志（一条一行）
├── cleanup.json      # 清理状态机 + 最近一次清理的结果 / 冲突 / 失败
└── snapshots/        # 内容寻址 blob（sha256），存 modify/delete 的 before 内容
```

### RPC 端点（host 半，`/dsh-session-manager` 通道）

原有 `list / archive / unarchive / delete / restore / purge / config` 全部保持兼容（`delete` / `purge` / `restore` 的返回值新增了可选的 `cleanup` / `journalRemoved` 字段，旧客户端忽略即可）。新增：

| 端点 | 入参 | 说明 |
|------|------|------|
| `changes` | `{ id, limit? }` | 该会话的 Journal 尾部 |
| `resources` | `{ id }` | Baseline（preexisting）+ Journal 推导的资源视图，含当前状态 |
| `cleanupStatus` | `{ ids }` | 每个会话的清理状态机快照（状态 / 冲突 / 失败明细） |
| `cleanup` | `{ ids, mode }` | `rollback-only`（默认，回滚资源保留会话）/ `resume`（续跑未完成清理）/ `full`（回滚 + 删会话目录 + 删 Journal） |
| `track` | `{ ids }` | 立即执行一次 diff（运维 / 调试用） |

### 归属权与冲突

- 基线中存在的资源：会话删除它 → 恢复；修改它 → 恢复基线内容；会话新建的资源：直接移除；会话新装的依赖（`node_modules` 适配器）：卸载目录。升级过已有依赖 / 卸载过已有依赖会被记录，但自动降级 / 重装不被尝试（在冲突报告中说明原因）。
- 回滚每个资源前先校验「当前 hash == Journal 最后的 after hash」；不一致说明会话结束后又被其他进程改过 → 记入 `conflicts`（`cleanupStatus` 可查），安全模式（默认）下跳过，`conflictMode: 'force'` 时才以基线内容覆盖。
- 环境变量按名做敏感识别（TOKEN/SECRET/KEY/PASSWORD/...）：敏感值只存存在性 + SHA-256 指纹，绝不落明文；敏感变量的自动回滚不可为（指纹可判等但值不可恢复），记为冲突交由人工处理。
- 会话空闲超过 `trackingIdleWindowMs` 后删除时跳过最终 diff——空闲期的工作区变更按外部修改处理，不会被记到会话头上。

### 旧会话兼容

升级前创建的会话没有 tracking 目录：`changes` / `resources` 报告 `tracked: false`，删除走原有路径（`cleanup.skipped: 'legacy-untracked'`），绝不把工作区里的既有文件当成它会话产生的。

## 手动安装

> ### ⚠️ 必须通过 Plugins 面板安装
>
> **手工把文件复制进 `~/.dsh/profiles/<profile>/node_modules/` 不会生效。** 插件管理器在安装成功后会把这个包名追加到 profile `package.json` 的 `dsh.profile.bundles`；宿主只加载该列表里登记过的 bundle 层。没有这条登记的包就是死代码——文件躺在 `node_modules` 里，插件不加载、不报错，并会在 profile 依赖重整时被无声删除。

**方式 A：Web UI 从 tarball 安装（推荐）**

1. 打开 DeepSeek Harness → 侧边栏 **Plugins** 面板 → 安装。
2. 在输入框（无障碍标签「包名或地址」）填 tarball 的**绝对路径**：

   ```
   /Users/<你的用户名>/Downloads/dsh-session-manager-0.1.2.tgz
   ```

3. 安装完成后在 Plugins 面板**启用**该插件——宿主会同时完成 `dsh.profile.bundles` 登记。
4. 刷新 Web UI（`http://127.0.0.1:19387`），侧边栏出现「会话管理」入口。

**必须是绝对路径。** 安装框只接受绝对路径：`./x.tgz` 与 `~/Downloads/x.tgz` 都会被直接拒绝（`a local path must be absolute`）——`~` 不被 `node:path.isAbsolute` 认可，请写完整路径。

**方式 B：Web UI 从 GitHub 仓库安装**

在同一个输入框填：

```
github:G57651/dsh-session-manager
```

仓库自带构建产物（`client.js` 已提交），无需本地构建。安装时需能访问 npm registry（拉取 `@deepseek-ai/schemastery` 依赖）。

**方式 C：Web UI 从本地目录安装**

```sh
git clone https://github.com/G57651/dsh-session-manager.git /绝对路径/dsh-session-manager
```

再在输入框填 clone 出来的**绝对目录路径**（同样不能写相对路径或 `~`）。

**⚠️ 不要按包名安装**

本插件**尚未发布到 npm**，且包名 `dsh-session-manager` 在公共 registry 上**已被另一位作者占用**（latest 0.5.3，对方发布的版本序列中同样包含 0.1.1）。

- 在安装框填 `dsh-session-manager` → pnpm 按 registry 包名解析，会**静默装回别人的包**：安装成功、不报任何错，但那是删除 / 归档 / 跨工作区移动 / 收藏 / 标签 / 备注那一套，与本插件功能完全不同。
- 在安装框填 `@g57651/dsh-session-manager` → 404，因为本包未发布。这是预期结果，不是配置错误。

本包使用 `@g57651` 命名空间，只应通过上面的 tarball / GitHub / 本地目录三种方式安装。

**方式 D：dsh CLI（仅当你另有独立 CLI 环境）**

桌面 App 的安装包内**不含 `dsh` 可执行文件**（PATH、`/usr/local/bin`、`/opt/homebrew/bin`、App bundle 内均无），所以下面命令在桌面 App 默认安装下不可用，仅供已有独立 CLI 者参考：

```sh
dsh plugin --profile desktop add github:G57651/dsh-session-manager
dsh plugin --profile desktop add ./dsh-session-manager
```

注意 CLI 与安装框的路径规则不同：CLI 会先把相对路径锚定为绝对路径（`anchorPathSpec`），因此 `./dsh-session-manager` 在 CLI 下合法，在安装框下会被拒。

**与 `@gehennawu/dsh-service` 并存**：两者功能有重叠且互不相干（各自的回收站清单不互通）。同时启用会出现两个会话管理入口，建议在 Plugins 页停用其一。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖本插件行的 `config`，或在插件管理器的 bundle 配置里修改：

| 字段 | 默认 | 说明 |
|------|------|------|
| `confirmPurge` | `true` | 彻底删除前是否弹出确认框（客户端行为） |
| `autoRefresh` | `true` | 是否监听会话事件自动刷新列表 |
| `maxBatchSize` | `200` | 单次批量操作接受的 id 数上限 |
| `titleFetchLimit` | `300` | 每次列表请求补拉冷会话标题的数量上限 |
| `trackingEnabled` | `true` | 资源生命周期跟踪总开关（关闭后行为回到 0.1.x） |
| `autoCleanup` | `true` | delete/purge 时是否执行资源回滚 |
| `autoResume` | `true` | 启动时是否续跑未完成的清理 |
| `trackingPollMs` | `0` | 周期性工作区 diff 间隔；0 = 仅事件驱动 + 删除前最终 diff |
| `trackingIdleWindowMs` | `300000` | 会话事件空闲多久后视为「已安静」，删除时跳过最终 diff |
| `trackingMaxFiles` | `5000` | 基线/diff 扫描的文件数上限 |
| `trackingMaxDepth` | `12` | 基线/diff 扫描的目录深度上限 |
| `trackingMaxSnapshotBytes` | `8388608` | 单文件 before 内容快照上限，超出只记 hash（不可自动恢复） |
| `trackingExclude` | `[]` | 额外排除的目录名（默认已排除 node_modules/.git/dist 等） |
| `conflictMode` | `'safe'` | `safe` 跳过冲突资源；`force` 记录冲突后仍以基线内容覆盖 |

## 数据文件

- `$DSH_HOME/dsh-session-manager-deleted.json` — 回收站清单（`{id, title, cwd, deletedAt, wasArchived}`）。
- `$DSH_HOME/dsh-session-manager-titles.json` — 会话标题缓存（含负缓存；实时会话经 `session/title` 事件保持最新）。
- `$DSH_HOME/dsh-session-manager/tracking/<id>/` — 每会话的 `baseline.json` / `changes.jsonl` / `cleanup.json` / `snapshots/`（0.2.0）。

以上文件都由插件自维护；tracking 目录在清理验证完成后随 Journal 一起删除，卸载插件后可手动删除其余文件。

## 开发与验证

```sh
node scripts/build-client.mjs        # 组装 client.js（纯 Node，无外部依赖）
node scripts/smoke-host.mjs          # host 半功能冒烟（隔离临时 $DSH_HOME，66 项断言）
node scripts/smoke-lifecycle.mjs     # 资源生命周期冒烟：需求 Case 1-10 + 下载/移动/旧会话/恢复取消（130 项断言）
```

> 0.1.2 起 `scripts/` 仅存在于源码仓库，不随 tarball 发布——请 clone 仓库后在仓库根目录运行。

宿主半 RPC 通道为 `/dsh-session-manager`，端点：`list / archive / unarchive / delete / restore / purge / config` + `changes / resources / cleanupStatus / cleanup / track`，批量端点全部接受 `ids` 数组并返回逐条结果。

## 实现说明与已知限制

- **源码语言**：host 半与 client 半均为纯 ESM JavaScript（JSDoc 标注），与已验证的第三方插件先例一致；未用 TypeScript 是因为本插件需在无网络的机器上构建（无编译器可用），client 半由 `scripts/build-client.mjs` 按 `src/client/` 源约定组装成 `window.__ModuleLoader__.load` CJS 单文件。生命周期模块在 `lifecycle/`（types / journal / snapshots / baseline / cleanup / manager + trackers），与 SessionManager 域逻辑（`session-manage.js`）分离。
- **变更捕获的边界**：跟踪是「事件 + diff」混合式（requirement §六）——`tool/call` 解析 shell 命令中的 `export`/`unset`/后台进程/下载意图，`tool/result` 触发防抖工作区 diff，删除前补一次最终 diff（仅对窗口期内仍活跃的会话）。子进程内部的临时文件、管道、不落盘的副作用无法观测；工作区之外的文件（`$DSH_HOME` 自身、其他目录）不在资源边界内。
- **环境变量**：host 半只能观测和恢复**自己进程**的 env（`scope: 'host-process'`）。工具子 shell 里的 `export` 随子进程消亡，记录它只为审计与生命周期语义；敏感名（TOKEN/SECRET/KEY/...）的值永不落 Journal，其「修改」无法自动回滚，记为冲突。
- **依赖**：默认只带 `node_modules` 适配器（npm/pnpm/yarn 共享的磁盘布局即真相）；pip 等按 `lifecycle/trackers/deps.js` 的适配器接口扩展。卸载 = 移除包目录（不 spawn npm，离线安全、幂等）；package.json/lockfile 由文件级回滚恢复。已有依赖的自动降级/重装不做，仅报告。
- **大文件**：超过 `trackingMaxSnapshotBytes` 的文件只记 hash 不存快照，涉及它的 modify/delete 无法自动恢复，清理报告 `snapshot-unavailable`。
- **并发**：同一会话的清理在进程内有互斥，跨进程用 `cleanup.json` 的 owner pid + 时效判定锁归属；冲突保护使多会话改同一文件时后删者不会静默覆盖前者的外部修改。
- **客户端 UI**：本版未改 client 半；`list` 行新增的 `tracked` 字段与新端点对旧客户端无影响。资源视图当前经 RPC 查询（`resources` / `changes` / `cleanupStatus`）。
- **删除语义**：官方层无删除 API。软删除 = 清单标记 + 原生归档隐藏 + 资源回滚；彻底删除 = 资源回滚 + 停活动 + 移除会话目录 + 销毁 Journal（有 `locate()` 定位 + `$DSH_HOME/sessions` 路径守卫 + id 校验三重防护，拒绝越界路径）。
- **幽灵行清理（v0.1.1 修复）**：官方层无删除 API，`api-session/removed` 只由 `session/disposed`（活会话拆卸）发出，而移除会话目录不触发拆卸——所以官方侧边栏既拿不到移除事件，`workspaceRegistry.archivedSessionIds` 与工作区 `sessionIds` 里的条目也无人清理，残留直到进程重启（此时 `bootstrap()` 重扫磁盘才剪掉）。彻底删除成功后插件改为三步失效：逐个工作区 `detachSession(id)`（未记账则空操作）→ `workspaceRegistry.unarchiveSession(id)`（不做存在性校验，条目已消失也照常解析）→ `ctx.emit('api-session/removed', id)` 转发给客户端，客户端 `handleSessionRemoved` 直接丢弃该行。因此无需重启，侧边栏即时同步。此外把 id 记入进程级已清除集合，各视图无条件过滤，作为兜底。
  - **残留限制**：`sessionQuery` 语料库与 `sessionController` 是进程内缓存，`sessions` 服务没有对外提供驱逐接口（`enter()` 对已存在的会话直接抛错），目录移除不会让缓存失活。进程重启后重扫磁盘会彻底清干净，但同进程内的客户端重连（如刷新 Web 页面）会重新拉到残留条目。桌面端侧边栏为长驻视图、不做整表重拉，不受影响。
- **归档/删除无远程事件**：这两个操作后列表由 RPC 返回值本地刷新；归档会话是当前激活会话时，原生 UI 会自动切走主面板（官方行为）。
- 兼容目标 `engines.dsh: ">=0.1.7-rc.0"`（声明性字段，实测于 0.1.7-rc.2）。

## 变更记录

### 0.2.0（Session Resource Lifecycle Manager）

- **新增资源生命周期层**（`lifecycle/`，纯 ESM + JSDoc，与 `session-manage.js` 域逻辑分离）：
  - `types.js` — 资源类型 / 动作 / 归属权 / 清理状态词汇表 + 秘密识别 + 路径守卫。
  - `journal.js` — 每会话 append-only JSONL 变更日志（容忍撕裂尾行，回放辅助）。
  - `snapshots.js` — 内容寻址（sha256）快照 blob 存储，按大小上限决定可恢复性。
  - `baseline.js` — 有界工作区扫描与首次见者恒定的基线（含依赖快照）。
  - `trackers/` — files（diff 引擎，识别 created/modified/deleted/moved/renamed/permission_changed）、deps（Adapter/Strategy，内置 node_modules 适配器）、env（export/unset 解析 + 秘密脱敏）、download（URL 归因）、process（后台进程记录）。
  - `cleanup.js` — 清理状态机（active → delete_requested → rolling_back → rollback_verified/rollback_failed → session_deleted → complete），幂等回滚 + 冲突检测 + 崩溃续跑。
  - `manager.js` — 编排层：事件接线、归属权判定、删除/恢复钩子、启动恢复、changes/resources/cleanupStatus 视图。
- **删除/彻底删除升级为完整清理流程**：卸载会话新装依赖 → 恢复被删/被改文件（含配置、快照回写 + hash 校验）→ 移除会话新建文件与目录（非空目录保守跳过）→ 恢复环境变量 → 校验 → 删会话目录 → 验证通过才销毁 Journal。每步先状态校验，外部改动被检测为冲突且默认跳过。
- **崩溃恢复**：清理状态机先于动作落盘（`cleanup.json`，含 owner pid + 锁时效）；重启自动续跑；恢复（restore）会取消未完成清理，避免把用户要回的会话删掉。
- **RPC 新端点**：`changes` / `resources` / `cleanupStatus` / `cleanup`（rollback-only / resume / full）/ `track`；`list` 行新增 `tracked` 字段；`delete` / `purge` / `restore` 返回值新增可选 `cleanup` / `journalRemoved` 字段——全部向后兼容。
- **新增配置**（均可 volatile 热更）：`trackingEnabled` / `autoCleanup` / `autoResume` / `trackingPollMs` / `trackingIdleWindowMs` / `trackingMaxFiles` / `trackingMaxDepth` / `trackingMaxSnapshotBytes` / `trackingExclude` / `conflictMode`。
- **安全**：环境变量敏感名值脱敏（只存存在性 + SHA-256 指纹）；快照按大小上限；Journal 在清理验证前不可销毁。
- **旧会话兼容**：无 tracking 目录的会话按 legacy 处理（`legacy-untracked`），只做原有删除路径，不追溯归属任何工作区资源。
- **测试**：新增 `scripts/smoke-lifecycle.mjs`（130 项断言，覆盖需求 Case 1-10 与下载归因、移动/重命名、旧会话、恢复取消清理）；`scripts/smoke-host.mjs` 66 项断言保持通过。
- **真机验证**：npm 发布版宿主 `@deepseek-ai/dsh@0.2.0-rc.2` + 真实 `dsh plugin add` 安装流程 + 真实 `session/create` 会话，经 RPC over HTTP 驱动端到端生命周期（基线 → 跟踪 → 删除回滚 → 冲突保护 → 崩溃恢复续跑）共 25 项断言全部通过；测试宿主与真实桌面数据完全隔离。

### 0.1.5（重构版，对外行为与接口不变）

- **修复 volatile 配置读取**（对照开发文档 §3.5「volatile 字段用 `.get()` 读取」）：0.1.4 起 4 个配置字段标了 `.volatile()`，但 host 半仍按普通值直读——schemastery 交给 `apply` 的是 `{ get() }` 稳定引用，导致 `confirmPurge === true` 恒为 false（**彻底删除确认框不再弹出**）、`autoRefresh` 恒为 false（自动刷新永不启用）、批量 `maxBatchSize` 上限失效、`titleFetchLimit` 经 `Math.max(0, 引用)` 得 NaN（冷会话标题永不补拉）。现在每次 RPC 操作前经 `configValue` / `readConfig` 快照解析（与 one-click-restart 同一套模式），volatile 变更无需重挂载即可在下次请求生效。
- **修复回退直连路由的 413 分支**：`readRequestBody(req)` 漏传 `res`，超限请求注释中描述的「立即以 413 终止响应」永远不会执行；现已传入 `res`。
- **消除死代码**：`softDeleteSessions` 的 `purge` 选项分支无任何调用方（永久删除由 `purgeSessions` → `removeSessionDir` 承担），移除。
- **消除重复**：`archiveSessions` / `unarchiveSessions` 合并为共享的 `mutateArchiveState`；`withBatch` 改为常规 async 并去掉多余的 `Promise.resolve` 包装。
- host/client 两半的 RPC 契约、端点、错误码、配置字段与默认值全部不变。

### 0.1.3

- **package.json**：`version` 0.1.2 → 0.1.3，声明兼容 DeepSeek Harness 0.2.0-rc.1；`engines.node` 采用仓库收紧值 `^22.19 || >=24`（0.1.2 tarball 里是 `>=22`，advisory 字段，无运行时影响）。
- 0.2.0-rc.1 兼容性核对（对照宿主源码 `packages/boot/app-boot/src/plugin-compatibility.ts` 的 peer 预检、`packages/host/webserver` 的 `WebRoute{kind,path,handler}`、`packages/client/connection` 的 rpc-host、`packages/client/ui-sidebar`/`ui-slots`/`store`/`ui-primitives` 客户端契约）：本插件未声明任何 `@deepseek-ai/dsh-*` 命名空间 peer（仅 `@deepseek-ai/schemastery ^3.18.3`，不在预检范围），预检天然放行；宿主侧用到的服务与 API 在 0.2.0-rc.1 均未变化，代码零改动。

### 0.1.2

- **package.json**：`@deepseek-ai/schemastery` 同时声明进 `peerDependencies` 与 `devDependencies`（开发规范 7.3 双声明要求）。
- **package.json**：移除 `scripts` 字段（`build:client` / `smoke` 只在源码仓库提供，tarball 安装后执行必然 ENOENT）。
- **index.js**：回退 RPC 路由强制 `Content-Type: application/json`，其他媒体类型以 415 拒绝——跨站表单 POST 无法携带该媒体类型，伪造请求到不了分发器；直接 curl 调试需自带 `-H 'Content-Type: application/json'`。
- **index.js**：日志改走规范 API——`ctx.logger` 可调用时取具名 logger（`ctx.logger('dsh-session-manager')`），宿主仅提供 `{ warn, info }` 对象时回退；修复旧代码在可调用语义下全部日志静默丢失的问题。
