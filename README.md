# dsh-session-manager

> **会话资源生命周期管理器（Session Resource Lifecycle Manager）—— DeepSeek Harness 插件。**
>
> 不再是「管理 Session 这一行」的侧边栏面板。0.2.0 起本插件完成架构升级，0.4.x 进一步补齐资源视图、删除回收链路与归档/删除后的页面稳定性：**Session 创建了什么、修改了什么、删除了什么、安装了什么、配置了什么，全程记录；Session 删除时，按变更记录反向清理这些变化——最后才删除变更记录本身。**

一句话：**Session 对世界做了什么，本插件就管到它做完什么为止。**

旧版本的 RPC 契约、调用方与 Web 客户端**完全兼容，可直接升级**。旧会话自动识别为 legacy，行为可整体回退（见「配置」）。

---

## 一、它解决什么问题

一个 Session 跑完，留下的不只是对话记录，还有：

- 新建的文件 / 目录
- 改过的配置（`package.json` / `.env` / `tsconfig.json` …）
- 装上的依赖（`node_modules/axios` …）
- 删掉的基线文件
- 起的后台进程（`nohup … &`）
- 设置过的环境变量

DeepSeek Harness 原生只管「Session 这一行」的归档 / 删除 / 恢复。本插件把**会话对工作区的副作用**纳入生命周期管理：全程留痕、删除反向清理、冲突可见、可恢复。

## 二、生命周期模型

```
Session
├── Baseline          插件首次看到会话时的有界工作区快照（文件哈希 + 内容 + 依赖快照）
├── Resources         会话涉及的资源，统一抽象，Tracker 可扩展
├── Change Journal    按会话隔离的 append-only 变更日志（JSONL）
└── Cleanup State     清理状态机，先于动作落盘（cleanup.json），崩溃可续
```

**跟踪链路**（事件 + diff 混合式，不依赖单一文件监视器）：

```
Session Context
    ↓
Command / Process Context      tool/call 事件：解析 export/unset、后台进程、下载意图（含 URL 归因）
    ↓
Resource Tracking              tool/result 触发防抖工作区 diff + 可选周期扫描
    ↓
Change Journal                 逐条 append-only 落盘 + 删除前最终 diff（仅对空闲窗口内仍活跃的会话）
```

### 资源与动作

不同资源类型只实现适用的动作：

| 资源类型 | 记录的动作 | 删除 Session 时的回滚语义 |
|---|---|---|
| `file` | created / modified / deleted / moved / renamed / permission_changed | 会话新建 → 移除；修改 → 恢复基线内容；删除 → 从快照恢复 |
| `directory` | created | 会话新建 → 空目录移除（非空保守跳过） |
| `configuration` | 修改（package.json、.env、tsconfig 等知名配置） | 按基线快照恢复 |
| `download` | downloaded（记录源 URL / 目标 / 时间 / 大小 / 哈希） | 同 file：新建则删，覆盖了原有文件则按基线恢复 |
| `dependency` | installed / uninstalled / upgraded（Adapter/Strategy，内置 `node_modules` 适配器） | 会话新装 → 卸载；已有依赖 → **绝不动**（升级/卸过仅报告） |
| `environment_variable` | set / unset（含 before / after / scope） | **仅审计**：值一律只存存在性 + 指纹；宿主 env 从不被写入，清理也不写（报告 `host-env-untouched`） |
| `process` | spawned（nohup / 后台 `&`） | 记录在案；存活进程由宿主停活动机制处理 |

### 归属权（Ownership）

判断一个资源到底是不是当前 Session 产生的，**记录时刻对照 Baseline 判定并冻结**：

| 归属 | 场景 | 删除 Session 时 |
|---|---|---|
| `session_created` | 基线里没有，会话建了它 | 直接移除 |
| `session_modified` | 基线里就有，会话改了它 | 恢复修改前状态，**而不是删除文件** |
| `session_deleted` | 基线里就有，会话删了它 | 按 before 快照恢复 |
| `session_installed` | 会话装的新依赖 | 卸载 |
| `session_configured` | 会话改了知名配置文件 | 按快照恢复 |
| `preexisting` | 基线即有的资源 | **永不因会话删除而被移除** |

## 三、Cleanup / Rollback Engine

删除 / 彻底删除时的执行顺序（每步先做状态校验，全部幂等可重入）：

```
active → delete_requested → rolling_back → rollback_verified / rollback_failed
                                   ↓
                             session_deleted → complete
```

1. **最终 diff**：删除前补记空闲窗口内仍活跃会话的尾部变更（疑似外部修改的，保守保留不回滚）。
2. **依赖阶段**：卸载会话新装依赖；已有依赖绝不动；升级仅报告（无离线重装）。
3. **路径阶段**：新建 → 移除；修改/删除 → 按基线快照恢复；**用户主动删除的资源不复活**（见下）。
4. **环境阶段**：只读，仅报告（`host-env-untouched`）。
5. **进程阶段**：报告存活进程。
6. **验证阶段**：重新 diff 工作区，确认所有期望状态达成；未达成记 conflict/failure。

**冲突检测**：每条记录的 `expectedAfter` 与磁盘当前哈希比对；不一致即 `conflict`，safe 模式跳过并报告，force 模式覆盖并标记 `executed: true`。

**崩溃恢复**：状态机每步先落盘 `cleanup.json`；进程被 `kill -9`、重启后自动续跑未完成阶段，最终销毁日志。

## 四、资源视图与删除回收链路（0.4.x）

会话资源弹窗按类型分组展示全部会话产物，每行带归属权 / 状态胶囊，并提供：

- **打开**：仅本机文件管理器（Finder / Explorer / Linux 文件管理器），无应用选择器。
- **批量选择**：全选 / 反选 / 删除所选 / 打开所选。
- **单行删除 / 批量删除**：删除 = **双写**——先复制内容 + 元数据进**插件内回收站**，再移入**系统废纸篓**。失败逐条报错，绝不破坏原文件。
- **回收站区块**：列出本会话已删除的条目，每条带「恢复」按钮。

### 用户主动删除的资源

用户从资源弹窗删除一个文件时，插件：

1. 写一条带 `metadata.trashed` 的 `deleted` 日志记录，并从内存跟踪状态 `forget` 该路径（防下次 diff 重复记录）。
2. 资源视图将该行标记为 `status: trashed`（**仅当文件确实不在磁盘上**——恢复后自动翻回 present，无需等 diff）。
3. 会话清理时**跳过**这类路径（`reason: user-trashed`）：用户主动删的不复活，可从回收站恢复。

### 从回收站恢复

恢复 = 从插件内回收站把内容写回原位 + 校验 SHA-256 + 清掉系统废纸篓里的已知副本。目标已存在 → 拒绝（绝不覆盖）。entryId 走格式与包含性双重校验，拒绝任何路径穿越。

## 五、归档/删除后的页面稳定性（0.4.2）

归档或删除**活跃**会话时，宿主会 `startSession` 新建会话并把中央面板切到对话页。本插件在 `archive` / `deleteSoft` / `purge` 操作期间开 2 秒抑制窗口：`panelInfo` 订阅若发现活动面板被宿主切走且仍在窗口内，就 `selectPanel(PANEL_ID)` 选回本面板。**用户手动切走（窗口外）不干预。**

## 六、RPC API

通道 `/dsh-session-manager`。所有端点返回严格 `{ ok: boolean, ... }`。

| 端点 | 入参 | 作用 |
|---|---|---|
| `list` | `{ view: 'all' \| 'archived' \| 'deleted' }` | 会话列表，合并宿主 corpus 与 manifest，标题缓存折叠 |
| `archive` / `unarchive` | `{ ids: string[] }` | 归档 / 取消归档，含 `stopActivity` |
| `delete` / `restore` | `{ ids: string[] }` | 软删除（进 manifest）/ 恢复 |
| `purge` | `{ ids: string[] }` | 彻底删除（清 manifest 墓碑） |
| `track` | `{ ids: string[] }` | 显式触发一次 baseline/diff |
| `changes` | `{ id, limit? }` | 变更日志（最近 N 条） |
| `resources` | `{ id }` | 资源视图（行 + status + 归属 + 基线） |
| `cleanupStatus` | `{ ids: string[] }` | 清理状态机当前态 |
| `cleanup` | `{ ids: string[], mode: 'rollback-only' \| 'full' \| 'resume' }` | 触发清理 |
| `deleteResources` | `{ id, paths: string[] }` | 用户删除文件（双写回收站 + 废纸篓） |
| `recycleList` | `{ id? }` | 回收站条目（按会话过滤） |
| `recycleRestore` | `{ entryId }` | 回收站还原到原位 |
| `openResource` | `{ id, path }` | 在 OS 文件管理器中显示 |
| `config` | `{}` | 当前配置快照 |

## 七、配置

全部 `volatile()`——改完即时生效，不重载插件。

| 配置 | 默认 | 说明 |
|---|---|---|
| `confirmPurge` | `true` | 彻底删除前二次确认 |
| `autoRefresh` | `true` | 会话事件驱动自动刷新列表 |
| `maxBatchSize` | `200` | 单批最大操作会话数 |
| `titleFetchLimit` | `300` | 标题批量拉取上限 |
| `trackingEnabled` | `true` | 资源跟踪总开关 |
| `autoCleanup` | `true` | 删除会话时自动跑清理 |
| `autoResume` | `true` | 启动时自动续跑未完成清理 |
| `trackingPollMs` | `0` | 周期扫描间隔；`0` = 纯事件驱动 |
| `trackingIdleWindowMs` | `300000` | 会话安静多久后最终 diff 视为「疑似外部修改」 |
| `trackingMaxFiles` | `5000` | 单次 diff 哈希预算上限（全树仍会走完，只限哈希） |
| `trackingMaxDepth` | `12` | 扫描深度上限 |
| `trackingMaxSnapshotBytes` | `8388608` | 单文件快照大小上限 |
| `trackingExclude` | `[]` | 额外排除路径（追加到默认排除集，不替换） |
| `conflictMode` | `'safe'` | 冲突处理：`safe` 跳过报告 / `force` 覆盖标记 |

## 八、数据布局

```
$DSH_HOME/dsh-session-manager/
├── tracking/<encoded-session-id>/
│   ├── baseline.json        有界快照（cwd / files{path→{sha256,size,mode}} / dirs / dependencies / capturedAt）
│   ├── changes.jsonl        append-only 变更日志
│   ├── cleanup.json         清理状态机
│   └── snapshots/           内容寻址 blob（SHA-256）
├── recycle/
│   ├── index.json           回收站条目索引（会话 / 原路径 / 类型 / 指纹 / 时间）
│   └── <entryId>/
│       ├── meta.json        单条元数据（workspaceCwd / trashPath）
│       └── payload/…        原文件 / 原目录树
└── dsh-session-manager-titles.json    标题缓存

$DSH_HOME/dsh-session-manager-deleted.json    软删除 manifest（墓碑）
```

## 九、安全姿态

- **路径包含性**：所有资源路径 `resolve(cwd, rel)` 后做 `isInsideRoot`（词法包含性判定：`rel` 逃出 cwd 即拒）。删除走 `rename`、复制走 `cp`（默认不解引用），因此工作区内的符号链接只会移动/复制链接本身，不会顺着它操作链接目标。
- **entryId 校验**：`/^bin_[a-z0-9]+_[a-z0-9]+$/` + 包含性双重校验，拒绝穿越；索引里的 `originalPath` 在恢复时**再次**做包含性校验（索引是磁盘上的不可信输入）。
- **原子性**：恢复用排他创建（`writeFile flag:'wx'` / `cp force:false`）保证「不覆盖」不可被 TOCTOU 绕过；索引读-改-写串行化，删除失败会回滚自己的回收站副本（不留幽灵条目）。
- **快照哈希**：仅接受 `/^[0-9a-f]{64}$/`，杜绝通过日志哈希逃逸。
- **进程派生**：opener 走 `execFile` + ARGV 数组，**永不**拼 shell 字符串。
- **环境变量**：全部值脱敏（仅存存在性 + 指纹），宿主 env 从不被写入。
- **凭据脱敏**：命令/URL 落盘前抹掉任意方案的 userinfo 与敏感参数（含 `X-Amz-Signature` 一类带厂商前缀的签名参数）。
- **恢复不覆盖**：目标已存在 → 拒绝，绝不覆盖用户当前数据。
- **保守失败**：清理遇非空目录、快照缺失、冲突 → 跳过并报告，不暴力删除。

## 十、安装

```bash
# 方式一：DeepSeek Harness 插件市场（推荐）
# 方式二：本地开发链接
cd ~/.dsh/profiles/desktop
pnpm add @g57651/dsh-session-manager
# 或直接符号链接到仓库
ln -s /path/to/dsh-session-manager node_modules/@g57651/dsh-session-manager
```

要求：Node `^22.19 || >=24`，DeepSeek Harness `>=0.1.7-rc.0`。

## 十一、开发与验证

```bash
# 客户端 bundle 重建（含 useStore 选择器静态校验）
node scripts/build-client.mjs

# 离线全量回归（无外部依赖）
node scripts/smoke-host.mjs        # 66 项：RPC 契约 + manifest + 归档/删除/恢复
node scripts/smoke-lifecycle.mjs   # 356 项：十场景 + 资源视图 + 回收站 + 用户删除链路
```

测试 seams：`DSH_SM_TRASH_DIR` 重定向废纸篓、`DSH_SM_OPEN_MODE=log` 记录命令而不弹出 Finder，保证跑测试不污染真机。

## 十二、实现说明与已知限制

- **rc.1 无 corpus 失效 API**：彻底删除后官方侧边栏可能仍显示该行（缓存），重启后消失。本插件 manifest 已落墓碑。
- **升级即兼容**：旧会话无 tracking 目录 → 识别为 legacy，资源视图空，清理跳过，行为可整体回退。
- **birthtime 优先**：基线漏扫的既有文件按 birthtime 静默采纳为 `preexisting`，绝不误删。
- **大工作区**：`trackingMaxFiles` 只限哈希预算，全树仍走完；未变文件按 `size+mtime+mode` 复用，0 读 0 哈希。
- **env 仅审计**：环境变量改动只记录、不回写宿主，清理只报告 `host-env-untouched`。
- **同工作区双会话的归属边界**：两个会话同时打开同一个 cwd 时，「谁先 diff 到谁记名下」。会话安静超过 `trackingIdleWindowMs` 后，删除时的最终 diff 记录的变更走**保守保留**分支（`external-suspect`），所以常见场景（先开着的会话早已空闲、另一会话后来创建文件）不会误删；但两个会话都在活跃期时，归属仍可能被先 diff 的一方认领——需要跨会话归属登记才能彻底解决，属已知设计边界。
- **跨会话隔离**：跟踪目录、日志、回收站条目、清理都按会话隔离（已覆盖测试：同名文件、同名相对路径、并发操作互不影响）。

---

## 变更记录

### 0.4.2 — 会话资源删除链路修复 + 归档/删除后页面稳定

- **问题 1**：会话资源页回收站功能缺失。补 `api.recycleList` / `recycleRestore`、`openResources` 并行拉取回收站、`restoreBin` 方法 + 导出。
- **问题 2**：删除后资源页不同步。客户端：`deleteSelected` 改 try/finally，刷新不可被通知失败中断（`createController` 补 `const t = ctx.locale.bind(NS)` 修复 8 处通知路径的 `ReferenceError`，详见问题 4）。主机侧：`deleteResources` 写带 `metadata.trashed` 的 `deleted` 日志记录 + `forget` 路径（防重复记录）；`getResources` 标记 `status=trashed`；cleanup 跳过 `user-trashed`，不复活用户主动删除的文件。
- **问题 3**：批量选择无法批量删除。同问题 4 根因（`deleteSelected` 在 `t('res.batchDeleted')` 抛 `ReferenceError` 中断刷新），绑 `t` + try/finally 后批量链路完整；失败路径保留所选以便重试。
- **问题 4**：点击删除未实际删除。`createController` 内 8 处通知路径引用未绑定 `t`，`deleteSelected` 删完文件后于 `t('res.batchDeleted')` 抛 `ReferenceError`，刷新被跳过；且 `deleteOne` 未从控制器导出，行内「删除」点击即 `TypeError`，无 RPC 发出。补 `const t = ctx.locale.bind(NS)` + 补齐 `deleteOne` 导出。
- **问题 5**：从回收站恢复后资源页不显示。客户端过滤改为只看 `status==='trashed'`（恢复后文件回磁盘 → status 翻回 present → 行重现），不再看恒为 true 的 `row.trashed` 日志标志（恢复不写新日志，标志会永久隐藏该行）。
- **问题 6**：移除「清除选择」按钮与 locale 键（反选已能清空全选）。
- **问题 7**：归档/删除活跃会话时宿主跳转新会话页。插件在 `archive` / `deleteSoft` / `purge` 操作期间开 2s 抑制窗口，`panelInfo` 订阅若发现面板被宿主切走且仍在窗口内则 `selectPanel(PANEL_ID)` 重选本面板；用户手动切走（窗口外）不干预。

### 0.4.1 — 插件内回收站：删除双写 + 恢复到原位

- 用户删除文件 = 双写（插件内回收站内容+元数据 + 系统废纸篓）。
- 恢复 = 写回原位 + SHA-256 校验 + 清掉系统废纸篓副本；目标已存在拒绝；entryId 穿越拒绝。

### 0.4.0 — 资源删除：移入本机废纸篓 + 弹窗批量删除

- 资源弹窗批量管理（全选 / 反选 / 删除所选 / 打开所选）。
- 删除移入 OS 废纸篓（macOS / Windows / Linux 三平台）。
- 仅保留本机文件管理器为打开方式，移除所有应用选择器。

### 0.3.x — 稳定性与正确性

- 大工作区跟踪死锁修复（全树扫描 + 哈希预算）。
- 跟踪目录复活防护、基线漏扫的 birthtime 采纳、env 解析只读、双编码 session ID 修复等。

### 0.2.0 — 架构升级：会话资源生命周期管理器

- 从「管理 Session 这一行」升级为「管理 Session 对世界做了什么」。
- Baseline / Change Journal / Cleanup Engine 三件套；事件 + diff 混合跟踪；归属权对照基线冻结。

### 0.1.x — 初版侧边栏会话管理面板

- 全部 / 已归档 / 已删除视图、批量管理、标题缓存。

---

## License

MIT
