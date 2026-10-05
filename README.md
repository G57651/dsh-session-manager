# dsh-session-manager

**DeepSeek Harness 插件：会话资源生命周期管理器（Session Resource Lifecycle Manager）+ Web 侧边栏会话管理面板。**

> **核心语义**：Session 创建了什么，就记录什么；修改了什么，就记录什么；删除了什么，就记录什么；安装了什么，就记录什么；配置了什么，就记录什么。**Session 删除时，不仅删除 Session 本身，还要按变更记录反向清理这些变化——最后才删除变更记录。**

0.2.0 起插件完成架构升级：从「管理 Session 这一行」升级为「管理这个 Session 对世界做了什么」。旧版本的 RPC 契约、调用方与 Web 客户端**完全兼容，可直接升级**（旧会话自动识别为 legacy，行为可整体回退，见「配置」）。

---

## 一、生命周期模型

```
Session
├── Baseline          插件首次看到会话时的有界工作区快照（文件哈希 + 内容 + 依赖快照）
├── Resources         会话涉及的资源，统一抽象，Tracker 可扩展
├── Change Journal    按会话隔离的 append-only 变更日志（JSONL）
└── Cleanup State     清理状态机，先于动作落盘（cleanup.json）
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

**资源与动作**（不同资源类型只实现适用的动作）：

| 资源类型 | 记录的动作 | 删除 Session 时的回滚语义 |
|---|---|---|
| `file` | created / modified / deleted / moved / renamed / permission_changed | 会话新建 → 移除；修改 → 恢复基线内容；删除 → 从快照恢复 |
| `directory` | created | 会话新建 → 空目录移除（非空保守跳过） |
| `configuration` | 修改（package.json、.env、tsconfig 等知名配置） | 按基线快照恢复 |
| `download` | downloaded（记录源 URL / 目标 / 时间 / 大小 / 哈希） | 同 file：新建则删，覆盖了原有文件则按基线恢复 |
| `dependency` | installed / uninstalled / upgraded（Adapter/Strategy，内置 `node_modules` 适配器） | 会话新装 → 卸载；已有依赖 → **绝不动**（升级/卸过仅报告） |
| `environment_variable` | set / unset（含 before / after / scope） | 会话新建 → unset；修改 → 恢复原值；敏感值见「安全」 |
| `process` | spawned（nohup / 后台 `&`） | 记录在案；存活进程由宿主停活动机制处理 |

**归属权（Ownership）**——判断一个资源到底是不是当前 Session 产生的，记录时刻对照 Baseline 判定并冻结：

| 归属 | 场景 | 删除 Session 时 |
|---|---|---|
| `session_created` | 基线里没有，会话建了它 | 直接移除 |
| `session_modified` | 基线里就有，会话改了它 | 恢复修改前状态，**而不是删除文件** |
| `session_deleted` | 基线里就有，会话删了它 | 按 before 快照恢复 |
| `session_installed` | 会话装的新依赖 | 卸载 |
| `session_configured` | 会话改了知名配置文件 | 按快照恢复 |
| `preexisting` | 基线即有的资源 | **永不因会话删除而被移除** |

## 二、Cleanup / Rollback Engine

删除 / 彻底删除时的执行顺序（每步先做状态校验，全部幂等可重入）：

```
 1. Lock Session（状态机落盘，跨进程锁：owner pid + 时效）
 2. 停止 Session 活动（复用宿主 archiveSession stopActivity）
 3. 最终 diff（空闲超窗的会话跳过——空闲期变更按外部修改处理）
 4. 加载 Change Journal
 5. 卸载会话新装的依赖
 6. 恢复被删除的资源（快照回写 + 哈希校验）
 7. 恢复被修改的资源（含配置、权限位）
 8. 移除会话新建的资源（文件先于目录，目录最深优先）
 9. 恢复环境变量（before=null → unset；修改 → 恢复原值）
10. 校验清理结果（独立 verify 阶段）
11. 落盘 cleanup 结果（rollback_verified / rollback_failed）
12. 删除 Session 数据（会话目录）
13. ✅ 验证通过后才销毁 Change Journal（rollback_failed 时 Journal 保留供重试）
```

**冲突保护**：回滚每个资源前校验「当前 hash == Journal 预期 after hash」。不一致 = 会话结束后又被其他进程改过 → 记入 `conflicts`（含 expected / current / reason），**安全模式跳过，绝不静默覆盖**；`conflictMode: 'force'` 才以基线内容覆盖。多会话改同一文件时，后删者不会破坏先者的外部修改。

**崩溃恢复**：清理状态机（`active → delete_requested → rolling_back → rollback_verified / rollback_failed → session_deleted → complete`）**先于动作落盘**；进程崩溃 / 机器重启后自动识别未完成清理并续跑，绝不留半删除状态。恢复（restore）会取消未完成清理——不会把用户刚恢复的会话删掉。

**安全**：敏感环境变量（TOKEN / SECRET / KEY / PASSWORD / ...）的**值永不落 Journal**——只存存在性 + SHA-256 指纹；其自动回滚不可为时如实记为冲突，交人工处理。

**旧会话兼容**：升级前创建的会话没有 tracking 目录，自动按 `legacy-untracked` 处理：只走原有删除路径，**绝不把工作区既有文件当成它创建的**。

## 三、数据布局

```
$DSH_HOME/dsh-session-manager/tracking/<encoded-session-id>/
├── baseline.json     # 首次见到的有界工作区快照（含依赖快照）
├── changes.jsonl     # append-only 变更日志（一条一行，容忍撕裂尾行）
├── cleanup.json      # 清理状态机 + 最近一次结果 / 冲突 / 失败
└── snapshots/        # 内容寻址 blob（sha256），modify/delete 的 before 内容
```

扫描边界：严格限定会话 cwd（文件数 / 深度 / 排除目录 / 单文件快照大小均受配置约束），默认排除 `node_modules` / `.git` / `dist` 等，**绝不扫描宿主机全局**。

## 四、RPC API

host 半经 `/dsh-session-manager` 通道服务（全部接受批量 `ids`，返回逐条结果；原有 7 端点行为不变）：

| 端点 | 入参 | 说明 | 引入 |
|---|---|---|---|
| `list` | `{ view }` | 三视图行 + 计数；行新增 `tracked` 字段 | 0.1.0 |
| `archive` / `unarchive` | `{ ids }` | 原生归档 / 取消 | 0.1.0 |
| `delete` | `{ ids }` | 软删除：清单 + 停活动 + **资源回滚** + 移除会话目录 | 0.1.0 |
| `restore` | `{ ids }` | 恢复列表行 + 取消未完成清理 | 0.1.0 |
| `purge` | `{ ids }` | 彻底删除：资源回滚 + 移除会话目录 + 墓碑 | 0.1.0 |
| `config` | `{}` | 客户端配置 | 0.1.0 |
| `changes` | `{ id, limit? }` | 该会话的 Journal 尾部 | **0.2.0** |
| `resources` | `{ id }` | **仅本次会话产生的资源**（新增 / 修改 / 删除 / 安装 / 配置，含当前状态）；既有内容只在基线摘要中计数，不逐条列出 | **0.2.0** |
| `cleanupStatus` | `{ ids }` | 每会话清理状态机快照（冲突 / 失败明细） | **0.2.0** |
| `cleanup` | `{ ids, mode }` | `rollback-only`（回滚资源保留会话）/ `resume` / `full` | **0.2.0** |
| `track` | `{ ids }` | 立即执行一次 diff（运维 / 调试） | **0.2.0** |

`delete` / `purge` / `restore` 返回值新增可选 `cleanup` / `journalRemoved` 字段——旧客户端忽略即可。

## 五、配置

在 profile 的 `cordis.patch.yml` 覆盖本插件行的 `config`，或在插件管理器的 bundle 配置里修改。**全部字段 volatile 热更，改完无需重挂载。**

| 字段 | 默认 | 说明 | 引入 |
|---|---|---|---|
| `confirmPurge` | `true` | 彻底删除前确认框（客户端行为） | 0.1.0 |
| `autoRefresh` | `true` | 监听会话事件自动刷新列表（客户端行为） | 0.1.0 |
| `maxBatchSize` | `200` | 单次批量操作 id 数上限 | 0.1.0 |
| `titleFetchLimit` | `300` | 每次列表补拉冷会话标题上限 | 0.1.0 |
| `trackingEnabled` | `true` | 资源生命周期跟踪总开关（`false` 即回到 0.1.x 行为） | **0.2.0** |
| `autoCleanup` | `true` | delete/purge 时执行资源回滚 | **0.2.0** |
| `autoResume` | `true` | 启动时续跑未完成清理 | **0.2.0** |
| `trackingPollMs` | `0` | 周期性 diff 间隔；0 = 仅事件驱动 + 删除前最终 diff | **0.2.0** |
| `trackingIdleWindowMs` | `300000` | 最终 diff 可疑阈值：会话安静超过该时长后，删除时最终 diff 捕获的变更按外部修改保护、不自动回滚 | **0.2.0** |
| `trackingMaxFiles` | `5000` | 基线/diff 扫描文件数上限 | **0.2.0** |
| `trackingMaxDepth` | `12` | 基线/diff 扫描深度上限 | **0.2.0** |
| `trackingMaxSnapshotBytes` | `8388608` | 单文件 before 内容快照上限 | **0.2.0** |
| `trackingExclude` | `[]` | 额外排除的目录名 | **0.2.0** |
| `conflictMode` | `'safe'` | 冲突处理：`safe` 跳过 / `force` 记录后覆盖 | **0.2.0** |

## 六、数据文件

- `$DSH_HOME/dsh-session-manager-deleted.json` — 回收站清单（`{id, title, cwd, deletedAt, wasArchived}`）。
- `$DSH_HOME/dsh-session-manager-titles.json` — 会话标题缓存（含负缓存；实时会话经 `session/title` 事件保持最新）。
- `$DSH_HOME/dsh-session-manager/tracking/<id>/` — 每会话的 `baseline.json` / `changes.jsonl` / `cleanup.json` / `snapshots/`（0.2.0）。

以上文件都由插件自维护；tracking 目录在清理验证完成后随 Journal 一起删除，卸载插件后可手动删除其余文件。

## 七、安装

> ### ⚠️ 必须通过 Plugins 面板安装
>
> **手工把文件复制进 `~/.dsh/profiles/<profile>/node_modules/` 不会生效。** 插件管理器在安装成功后会把包名追加到 profile `package.json` 的 `dsh.profile.bundles`；宿主只加载该列表里登记过的 bundle 层——没有这条登记的包就是死代码，不加载、不报错，并会在依赖重整时被无声删除。另外 profile 需包含提供宿主服务层（`connection` / `workspaceRegistry` 等）的 web/desktop app bundle，纯 `dsh-base` 的裸 profile 会让插件静默 PENDING。

**方式 A：Web UI 从 tarball 安装（推荐）**

1. 打开 DeepSeek Harness → 侧边栏 **Plugins** 面板 → 安装。
2. 在输入框（无障碍标签「包名或地址」）填 tarball 的**绝对路径**：

   ```
   /Users/<你的用户名>/Downloads/dsh-session-manager-0.2.0.tgz
   ```

3. 安装完成后在 Plugins 面板**启用**该插件——宿主会同时完成 `dsh.profile.bundles` 登记。
4. 刷新 Web UI，侧边栏出现「会话管理」入口。

**必须是绝对路径。** 安装框只接受绝对路径：`./x.tgz` 与 `~/Downloads/x.tgz` 都会被直接拒绝（`~` 不被 `node:path.isAbsolute` 认可）。

**方式 B：Web UI 从 GitHub 仓库安装**

在同一个输入框填：

```
github:G57651/dsh-session-manager
```

仓库自带构建产物（`client.js` 已提交），无需本地构建。安装时需能访问 npm registry（拉取 `@deepseek-ai/schemastery` 依赖）。也可直接从 [GitHub Releases](https://github.com/G57651/dsh-session-manager/releases) 下载 tarball 后按方式 A 安装。

**方式 C：Web UI 从本地目录安装**

```sh
git clone https://github.com/G57651/dsh-session-manager.git /绝对路径/dsh-session-manager
```

再在输入框填 clone 出来的**绝对目录路径**（同样不能写相对路径或 `~`）。

**⚠️ 不要按包名安装**

本插件**尚未发布到 npm**，且包名 `dsh-session-manager` 在公共 registry 上**已被另一位作者占用**（latest 0.5.3，对方的版本序列中同样包含 0.1.1）。

- 在安装框填 `dsh-session-manager` → pnpm 按 registry 包名解析，会**静默装回别人的包**：安装成功、不报任何错，但那是另一套功能。
- 在安装框填 `@g57651/dsh-session-manager` → 404，因为本包未发布。这是预期结果，不是配置错误。

本包使用 `@g57651` 命名空间，只应通过上面的 tarball / GitHub / 本地目录三种方式安装。

**方式 D：dsh CLI（仅当你另有独立 CLI 环境）**

桌面 App 的安装包内**不含 `dsh` 可执行文件**（PATH、`/usr/local/bin`、App bundle 内均无），所以下面命令在桌面 App 默认安装下不可用，仅供已有独立 CLI 者参考：

```sh
dsh plugin --profile desktop add github:G57651/dsh-session-manager
dsh plugin --profile desktop add ./dsh-session-manager
```

注意 CLI 与安装框的路径规则不同：CLI 会先把相对路径锚定为绝对路径（`anchorPathSpec`），因此 `./dsh-session-manager` 在 CLI 下合法，在安装框下会被拒。

**与 `@gehennawu/dsh-service` 并存**：两者功能有重叠且互不相干（各自的回收站清单不互通）。同时启用会出现两个会话管理入口，建议在 Plugins 页停用其一。

## 八、开发与验证

```sh
node scripts/build-client.mjs        # 组装 client.js（纯 Node，无外部依赖）
node scripts/smoke-host.mjs          # host 半功能冒烟（隔离临时 $DSH_HOME，66 项断言）
node scripts/smoke-lifecycle.mjs     # 资源生命周期冒烟：需求 Case 1-10 + 下载/移动/旧会话/恢复取消（130 项断言）
```

> `scripts/` 仅存在于源码仓库，不随 tarball 发布——请 clone 仓库后在仓库根目录运行。

**真机验证（v0.2.0 已完成）**：npm 发布版宿主 `@deepseek-ai/dsh@0.2.0-rc.2` + 真实 `dsh plugin add` 安装流程 + 真实 `session/create` 会话，经 RPC over HTTP 驱动端到端生命周期（基线 → 跟踪 → 删除回滚 → 冲突保护 → kill -9 后重启自动续跑）共 25 项断言全部通过；测试宿主与真实桌面数据完全隔离。

兼容目标 `engines.dsh: ">=0.1.7-rc.0"`（声明性字段，实测于 0.1.7-rc.2 与 0.2.0-rc.2）。

## 九、实现说明与已知限制

**源码与架构**

- host 半与 client 半均为纯 ESM JavaScript（JSDoc 标注）——本插件需在无网络的机器上构建（无编译器可用），client 半由 `scripts/build-client.mjs` 按 `src/client/` 源约定组装成 `window.__ModuleLoader__.load` CJS 单文件。
- 0.2.0 起代码分两层：`lifecycle/`（types / journal / snapshots / baseline / cleanup / manager + trackers）承载资源生命周期，`session-manage.js` 保留会话域逻辑；`index.js` 只做 RPC 接线。依赖适配器（npm/pip/…）按 `lifecycle/trackers/deps.js` 的 Adapter 接口扩展，不与核心耦合。

**变更捕获的边界**

- 跟踪是「事件 + diff」混合式：`tool/call` 解析 shell 命令、`tool/result` 触发防抖 diff、删除前补最终 diff。子进程内部的临时文件、管道、不落盘副作用无法观测；工作区之外的文件（`$DSH_HOME` 自身、其他目录）不在资源边界内。
- host 半只能观测 / 恢复**自身进程**的环境变量（`scope: 'host-process'`）；工具子 shell 里的 `export` 随子进程消亡，记录仅为审计与生命周期语义。
- 真机实测注意：宿主会为会话发出 title 等后台事件，它们会计入「活跃」判定——外部修改若落在空闲窗口（`trackingIdleWindowMs`，默认 5 分钟）内，删除时会按会话变更参与校验。需要更保守边界可将该值调小。
- 依赖卸载 = 移除包目录（离线安全、幂等，package.json/lockfile 由文件级回滚恢复）；已有依赖的自动降级/重装不做，仅报告。pip 等其它管理器按适配器接口扩展。
- 超过 `trackingMaxSnapshotBytes` 的文件只记哈希，无法自动恢复（清理报告 `snapshot-unavailable`）。

**面板语义（0.1.x 起）**

- 删除语义：官方层无删除 API。软删除 = 清单标记 + 原生归档隐藏（0.1.4 起会话目录同样被移除，恢复仅还原列表行、不还原磁盘数据）；彻底删除 = 资源回滚 + 停活动 + 移除会话目录 + 销毁 Journal（有 `locate()` 定位 + `$DSH_HOME/sessions` 路径守卫 + id 校验三重防护，拒绝越界路径）。
- 幽灵行清理（v0.1.1 修复）：移除会话目录不触发拆卸，官方侧边栏拿不到移除事件——彻底删除后插件改为三步失效（逐工作区 `detachSession` → `unarchiveSession` → `api-session/removed` 转发），无需重启即消失。残留限制：`sessionQuery` 语料库与 `sessionController` 是进程内缓存，同进程内重连（如刷新页面）可能重新拉到残留条目，进程重启后彻底清理。
- 归档/删除无远程事件：这两个操作后列表由 RPC 返回值本地刷新；归档当前激活会话时原生 UI 会自动切走主面板（官方行为）。
- client 半本版未改：资源视图（`resources` / `changes` / `cleanupStatus`）当前经 RPC 查询，尚未接入面板 UI。

## 变更记录

### 0.2.3（资源视图只列会话产物）

- **`resources` 视图不再列出会话前已存在的文件**：此前基线里的全部既有文件（标「原有」）会出现在资源弹窗里，工作区大时被无关行淹没。现在视图**只输出本次会话产生的变化**——`session_created` / `session_modified` / `session_deleted` / `session_installed` / `session_configured` 的 Journal 记录；被会话修改 / 删除过的既有文件仍会列出（它们是会话产生的变化，回滚语义不变），**未被触碰的既有文件完全不出现**，只在基线摘要里计一个数（`baseline.fileCount`）。
- 语义与需求一致：任务开始前基线快照（`session/created` 即建）→ 事件 + diff 对比 → 视图只列对比出的会话产物；清理行为不受影响（本就只回滚会话拥有的资源）。
- 测试：`smoke-lifecycle.mjs` 187 项断言（新增"未触碰既有文件不列出 / 无 preexisting 行"用例）。

### 0.2.2（修复面板黑屏）

- **修复点击「会话管理」面板整页黑屏**：0.2.1 新增资源视图时，store 的 `init()` 漏声明 `detail` 字段——`useStore(s => s.detail)` 返回 `undefined`，`detail !== null` 判定为真导致资源弹窗以 `undefined` 挂载，渲染抛错使 React 整树卸载（表现为面板黑屏，侧边栏入口仍在）。补上 `detail: null` 即恢复。
- **构建期防回归**：`build-client.mjs` 现在校验每一条 `useStore(s => s.X)` 选择器都必须在 store `init()` 中声明，缺失即构建失败；新增 `scripts` 外的渲染冒烟（真实 react + 真实 client-store 驱动面板全部状态：加载 / 行列表 / 资源弹窗七类资源 / legacy / 冲突 / 批量栏 / purge 确认框）。
- host 半无变化；从 0.2.1 直接升级。

### 0.2.1（跟踪自愈 + 资源视图面板）

- **修复真机场景下删除不清理的核心缺口**：0.2.0 的事件驱动跟踪依赖 `tool/result` 触发的防抖 diff，插件重挂载 / 宿主重启后防抖丢失、或会话从未被观测时，删除会被判为 `legacy-untracked` 而跳过清理。0.2.1 三路闭合：
  - 监听宿主 `session/created` 事件——新会话在创建瞬间（工作区还是干净时）立即建立基线；
  - 启动时对宿主语料内的全部已知会话做**错峰基线扫描**；
  - `list` RPC 对每个行内会话自愈基线（已存在时只是一次 stat 读）——打开一次面板即可补齐跟踪。
- **删除时的最终 diff 不再被空闲窗口跳过**（0.2.0 的门控会让闲置会话删除时不清理——正是"删了没效果"的另一半原因）。改为**总是执行**，并把最终 diff 捕获的每条记录标记 `{finalDiff, idleMs}`：会话安静超过 `trackingIdleWindowMs` 后才出现的变更按**外部修改保护**（安全模式跳过并在报告中标注 `external-suspect`；`conflictMode: 'force'` 才覆盖）。活动时间持久化到 `activity.json`，判定跨重启 / 重挂载依然成立。
- **修复基线扫描与崩溃恢复的竞争**：恢复流程完成后写入 purge 墓碑（与 purge 流程一致），基线扫描跳过存在未完成清理（RESUMABLE）或已被 purge 的会话——不再出现"恢复刚销毁的 Journal 又被扫描重建"。
- **新增面板资源视图（需求）**：每行新增「资源」按钮 → 弹窗按类型分组展示该会话的全部资源（文件 / 配置 / 下载 / 目录 / 依赖 / 环境变量 / 进程），逐项标注归属与当前状态，含基线摘要、清理状态与冲突提示；中英双语。
- **测试**：`smoke-lifecycle.mjs` 增至 **181 项断言**，新增事件驱动路径（session/created → tool/result 防抖 diff → 删除清理）、final diff 挽救漏 diff、可疑记录保护外部修改、force 覆盖、列表自愈等用例；`smoke-host.mjs` 66 项保持通过。

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
- **真机验证**：npm 发布版宿主 `@deepseek-ai/dsh@0.2.0-rc.2` + 真实 `dsh plugin add` 安装流程 + 真实 `session/create` 会话，经 RPC over HTTP 驱动端到端生命周期（基线 → 跟踪 → 删除回滚 → 冲突保护 → kill -9 后重启自动续跑）共 25 项断言全部通过；测试宿主与真实桌面数据完全隔离。

### 0.1.5（重构版，对外行为与接口不变）

- **修复 volatile 配置读取**（对照开发文档 §3.5「volatile 字段用 `.get()` 读取」）：0.1.4 起 4 个配置字段标了 `.volatile()`，但 host 半仍按普通值直读——schemastery 交给 `apply` 的是 `{ get() }` 稳定引用，导致 `confirmPurge === true` 恒为 false（**彻底删除确认框不再弹出**）、`autoRefresh` 恒为 false（自动刷新永不启用）、批量 `maxBatchSize` 上限失效、`titleFetchLimit` 经 `Math.max(0, 引用)` 得 NaN（冷会话标题永不补拉）。现在每次 RPC 操作前经 `configValue` / `readConfig` 快照解析（与 one-click-restart 同一套模式），volatile 变更无需重挂载即可在下次请求生效。
- **修复回退直连路由的 413 分支**：`readRequestBody` 漏传 `res`，超限请求注释中描述的「立即以 413 终止响应」永远不会执行；现已传入 `res`。
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
