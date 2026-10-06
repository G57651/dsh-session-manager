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
| `environment_variable` | set / unset（含 before / after / scope） | **仅审计**：值一律只存存在性 + 指纹；宿主 env 从不被写入，清理也不写（报告 `host-env-untouched`） |
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
 9. 环境变量定级（只读报告：宿主 env 从不被写入）
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

host 半经 `/dsh-session-manager` 通道服务（批量端点接受 `ids` 数组；`changes`/`resources`/`openResource` 为单 id；原有 7 端点行为不变）：

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
| `openResource` | `{ id, path }` | 在本机文件管理器中显示会话资源（访达定位 / 资源管理器选中）；路径仅限该会话工作区内 | **0.3.0** |

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

- `$DSH_HOME/dsh-session-manager-deleted.json` — 回收站清单（`{id, title, cwd, deletedAt, wasArchived, purged}`；`purged` 是重启后仍生效的墓碑标记）。
- `$DSH_HOME/dsh-session-manager-titles.json` — 会话标题缓存（含负缓存；实时会话经 `session/title` 事件保持最新）。
- `$DSH_HOME/dsh-session-manager/tracking/<id>/` — 每会话的 `baseline.json` / `changes.jsonl` / `cleanup.json` / `activity.json`（会话活动时钟）/ `snapshots/`（0.2.0+；目录以 0700 创建，快照含文件内容，随 Journal 一并销毁）。

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
node scripts/smoke-lifecycle.mjs     # 资源生命周期冒烟：Case 1-10 + 审计回归套件（284 项断言）
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
- host 半**只记录**环境变量变更、**绝不改写宿主进程 env**：工具子 shell 里的 `export` 随子进程消亡，把解析值写回宿主会让会话命令污染 harness 自身的运行环境（PATH / NODE_OPTIONS 等）。**所有 env 值一律脱敏**（存在性 + SHA-256 指纹，明文永不落盘；`DATABASE_URL` 这类“名字无害”的值同样如此）；运行性变量（PATH、NODE_OPTIONS、LD_*/DYLD_*、HOME、DSH_HOME 等）直接排除出跟踪；只有显式 `export` 才算持久变更（`FOO=bar cmd` 前缀不记录）；清理阶段对 env 只做定级报告，**不写任何值**。
- 真机实测注意：宿主会为会话发出 title 等后台事件，它们会计入「活跃」判定——外部修改若落在空闲窗口（`trackingIdleWindowMs`，默认 5 分钟）内，删除时会按会话变更参与校验。需要更保守边界可将该值调小。
- 依赖卸载 = 移除包目录（离线安全、幂等，package.json/lockfile 由文件级回滚恢复）；已有依赖的自动降级/重装不做，仅报告。pip 等其它管理器按适配器接口扩展。
- 超过 `trackingMaxSnapshotBytes` 的文件只记哈希，无法自动恢复（清理报告 `snapshot-unavailable`）。
- **哈希预算（0.3.8 语义）**：全树始终遍历（不再有条目截断导致的跟踪死锁——大工作区上新建/修改/删除照常跟踪）；`trackingMaxFiles` 只封顶**内容哈希**：超出预算的文件仍记录存在性（无哈希），被修改时无法恢复内容（如实报告）；预算外的既有文件由 birthtime 判定并收养，绝不被清理移除。真机截断场景实测：既有文件全部保留、会话新建文件照常清理。

**面板语义（0.1.x 起）**

- 删除语义：官方层无删除 API。软删除 = 清单标记 + 原生归档隐藏（0.1.4 起会话目录同样被移除，恢复仅还原列表行、不还原磁盘数据）；彻底删除 = 资源回滚 + 停活动 + 移除会话目录 + 销毁 Journal（有 `locate()` 定位 + `$DSH_HOME/sessions` 路径守卫 + id 校验三重防护，拒绝越界路径）。
- 幽灵行清理（v0.1.1 修复）：移除会话目录不触发拆卸，官方侧边栏拿不到移除事件——彻底删除后插件改为两步失效（逐工作区 `detachSession` → `api-session/removed` 转发；刻意不做 unarchive——它会把已消失的 id 重新发布给下一次语料读取），无需重启即消失。残留限制：`sessionQuery` 语料库与 `sessionController` 是进程内缓存，同进程内重连（如刷新页面）可能重新拉到残留条目，进程重启后彻底清理。
- 归档/删除无远程事件：这两个操作后列表由 RPC 返回值本地刷新；归档当前激活会话时原生 UI 会自动切走主面板（官方行为）。
- **Journal 内容**（0.3.7 起）：下载 URL 去除凭据/签名参数、后台命令遮蔽 `Authorization` 头与密钥式赋值后才落盘；快照库按内容存储（含文件原文），目录 0700、随 Journal 销毁。
- **打开资源**：仅调用本机文件管理器——macOS `open -R`（访达定位）、Windows `explorer /select`（资源管理器选中）、Linux `xdg-open`（打开父目录）；所有 spawn 均为 argv 数组（无 shell 拼接），可打开路径严格限制在会话工作区内。

## 变更记录

### 0.3.9（资源弹窗布局修复 + 一键清除选择）

- **修复资源行被勾选框标签挤扁**：行内勾选框的无障碍标签文本就是完整路径（会话删除的文件路径很长），未约束宽度时吞掉整行宽度，把路径列挤压成一字宽竖排。现在沿用批量操作栏的既有模式：视觉隐藏标签文本、保留无障碍名，路径回到宽列正常显示。
- **批量选择补「一键清除」**：工具栏新增「清除选择」（无选中时禁用），与全选 / 反选并列。
- 渲染冒烟新增断言（清除按钮存在、路径列存在）；离线 295 项断言不受影响。

### 0.3.8（第三轮审计：修复大工作区跟踪死锁——本轮最重要发现）

- **修复：工作区一旦填满哈希预算，跟踪即整体失效**。旧扫描器用「条目数上限」截断遍历：基线一旦收录满 `trackingMaxFiles`（5000，你的 default-workspace 正是如此）个文件，之后会话创建/修改/删除的**所有**文件都落在截断线之外——每一轮 diff 都看不见它们，Journal 永远为空，删除会话清理不到任何东西（资源弹窗显示"没有记录到资源变化"）。重构扫描器：**全树遍历（预算只封顶内容哈希）**，已知未变文件（size+mtime+mode 相同）直接复用上一轮条目（零读取零哈希），预算耗尽后仍记录存在性（无哈希，如实报告截断）；预算外的既有文件由 birthtime 收养保护。
- **性能**（5000 文件实测）：无变化 diff 548ms → **174ms**（已知未变文件不再重读内容）；50 新文件 diff 540ms/journaled 0（死锁）→ 151ms/**journaled 50**；450 条 Journal 后 diff 128ms 无退化。
- 第三轮审计其余发现均为验证通过或低危记录（符号链接收养语义、`_no-cwd` 布局由扫描式定位天然覆盖、RPC 契约与真实宿主源码逐项一致）。
- 测试：`smoke-lifecycle.mjs` 增至 **295 项断言**（新增满预算死锁回归用例：预算耗尽后创建/修改仍被跟踪、删除行为正确）；真机复验：驱动 29/29、agent 回合 8/8、崩溃恢复通过。

### 0.3.7（第二轮技能化审计：15 处隐形 bug 修复）

第二轮 `code-review` + `diagnosing-bugs` 审计聚焦「修复回归验证 / 未覆盖角落与并发 / 安全与隐私 / 测试有效性」，全部红灯先行：

- **会话新建目录从来清理不掉**：`rm(recursive:false)` 对任何目录都抛 `EISDIR`，`ENOTEMPTY` 保守分支是死代码——改用 `rmdir`（空目录契约）。
- **显式 resume 跳过回滚**：`cleanup` RPC 的 `resume` 对 `delete_requested`/`rolling_back` 状态直接拆除并销毁 Journal，从不执行回滚——现在这三态一律先回滚、失败即止。
- **Journal 并发序号全为 0**：`nextSeq` 是读-改-写无串行化（env/process 记录与 diff 并发写入时全部拿到 seq 0）——append 改为单链串行；撕裂尾行不再吞掉下一条记录（写前补换行修复）。
- **密钥泄漏面**：下载 URL 的 `user:pass@` 与签名/token 查询参数会原文进入 Journal 与 RPC——现在落盘前脱敏；后台命令中的 `Authorization: Bearer …` 与密钥式赋值同样遮蔽；**环境变量值一律脱敏**（不再依赖名字启发式，`DATABASE_URL=postgres://user:pw@…` 类不再明文）。
- **快照库路径逃逸**：Journal 可构造的 `sha256`（如 `../x`）能读到快照目录之外的文件——现在只接受 64 位十六进制。
- **符号链接越过工作区**：`isInsideRoot` 是词法检查，经符号链接父目录的恢复/删除会作用于工作区之外——写入/删除前追加 `realpath` 包含性复核。
- **权限变更不被恢复**：仅 chmod 的既有文件在清理时命中 `already-restored`，权限原样保留——现在 mode 不一致同样执行恢复。
- **显式 cleanup 被 autoCleanup 门控**：`autoCleanup:false` 下 `cleanup` RPC 返回 skipped——显式请求现在绕过该门控；同时**清理被跳过时 delete/purge 保留 tracking 目录**（否则显式清理的唯一依据被销毁）。
- **并发 diff 重复记账**：防抖 diff、显式 track、列表自愈、删除前最终 diff 并发时同一修改会被记录 2–3 次——按会话共享在途 diff。
- **卸载后仍在写入**：HMR 重挂载后旧实例的在途 diff 继续追加——`disposed` 守卫停止写入；同会话的 prepareRemoval 加在途锁。
- **归档失败留下假墓碑**：archive 抛错时 delete 已写入回收站条目，会话被隐藏却未删除——失败即回滚条目。
- **进程误判与漏判**：URL 查询里的 `&`、`make &&` 会被当成后台启动；`cmd1 &
cmd2` 漏判——改为按行单 `&` 判定。
- **下载归因错配**：一条下载意图被贴到第一个创建的文件——现在按 `-o/--output` 或 URL 文件名提示优先匹配。
- **pnpm 符号链接依赖不被跟踪**：`node_modules/<pkg>` 为符号链接时适配器跳过——现在接受（卸载只删链接，不动 store）。
- **env 解析**：`FOO=bar cmd` 前缀被误记（现在只有显式 `export` 才算持久）、`export A=1 B=2` 漏掉第二个、`"x;y"` 被错误拆分。
- 文档/注释同步：env 语义、purge 不归档、幽灵行两步失效、activity.json、284 项断言数等；`build-client` 的选择器检查改为支持无空格/任意参数名且只认顶层 init 键。
- 测试：`smoke-lifecycle.mjs` 增至 **284 项断言**（第二轮新增 15 组回归用例，并发去重与 env 解析用例均经验证可红）；真机复验：驱动 29/29、agent 回合 8/8、崩溃恢复、截断 5/5。

### 0.3.6（技能化双轴审计：7 处隐形 bug 修复 + 死代码清理）

用 `code-review` 技能（mattpocock/skills，双轴隔离并行审计：Standards 规范/坏味道 × Spec 需求符合度）与 `diagnosing-bugs` 技能（红灯反馈循环先行）对全部约 7300 行代码做了一轮完整审计，按纪律先写红灯用例再修复：

- **环境清理不再写宿主 env**：env 阶段从「按指纹匹配时执行 unset/恢复」改为**纯报告**——插件从不改写宿主环境，清理自然也不写；所有 env 记录只做审计与分类（`already-at-original-value` / `host-env-untouched`）。
- **remove 分支的冲突检查补齐**：会话「创建后又删除」的路径若被外部重建，旧代码因 after 为空而跳过校验、静默删除；现在判 `externally-recreated-after-session-delete` 冲突并保留；无哈希的大文件增加 size 兜底校验。
- **恢复流程的双重编码修复**（真 bug 两层）：清理目录名是 `encodeSegment(原始 id)`，resume 用已编码目录名再喂给 `storesFor` 会二次编码——导致 cleanup.json 都读不到、静默跳过（第一层）；且 rollback 会把编码名写回 cleanup.json，第二次 resume 双重编码定位失败、销毁 Journal 却留下会话目录（第二层）。现在以目录名为主源（新增 `decodeSegment`）直接按目录寻址。
- **`trackingExclude` 语义修正**：自定义排除项原会**替换**默认排除（node_modules/.git 等失守），现在与默认表**合并**。
- **所有权标签修正**：会话新建的文件再次被改，标签不再错报 `session_modified`；收养的既有文件始终不报 `session_created`（标签跟随“会话开始前是否存在”）。
- **大文件快照缺失的报告**：未存快照的恢复失败从误导性的 `snapshot-missing` 改为文档一致的 `snapshot-unavailable`；基线捕获对超大文件跳过快照时给出日志。
- **清理意图先于最终 diff 落盘**：crashes 在 diff 窗口内也保持可续跑（状态机 step 1 前置）。
- **client 修复**：未知资源类型归入「其他」分组且不可打开（原来冒充文件并可点开）；仅含环境变量的会话仍显示工具栏（打开工作区可用）；已删除视图行恢复显示工作目录；config 调用失败不再静默关闭自动刷新。
- **死代码清理**：`safeList`、`snapshots.pathFor`、`IconSessionManagerOutlineMedium`、死 locale 键（loading.text/error.generic）、死 CSS（.dsm-tabCount）、测试脚本死片段、trackers 未用的 logger 参数；`makeChangeRecord` 的 id 不再内嵌恒为 0 的 seq。`index.js` 的 archive/unarchive 端点与 RPC 回退分支去重，轮询扫描移入 manager 域层。
- 测试：`smoke-lifecycle.mjs` 增至 **214 项断言**（新增 6 组审计回归用例），连跑三轮全绿；真机复验：驱动 29/29、agent 回合 8/8、崩溃恢复、截断场景 5/5 全部通过。

### 0.3.5（代码审计：4 处隐形 bug 修复 + 死代码清理）

- **审计并修复的隐形 bug**（均补了回归用例）：
  - **env 外部改动被静默覆盖**：① 会话创建的变量若其后被外部改过值，清理会盲目 unset（删掉别人的值）——现在仅当环境仍与 Journal 记录完全一致才 unset，否则记 `externally-modified-after-session` 冲突；② 既有变量被外部 unset 后，恢复逻辑会把它「复活」——现在判为冲突并保留外部删除。
  - **权限变更丢失血统**：收养的既有文件仅被 chmod（内容不变）时，`permission_changed` 记录没有携带 `unbaselined` 标记——删除会话会把这个既有文件删掉。现在记录的血统与其它动作一致。
  - **verify 阶段自相矛盾**：非空的会话新建目录在 path 阶段是「保守跳过」，verify 阶段却被记成失败（rollback_failed）；现在跳过结果统一传递。
  - **ENOENT 竞态**：文件在状态检查与删除之间消失会被记成失败；现在视为幂等成功。
  - resume 分支的「先删除后写标记」顺序与其它移除路径对齐（幂等已兜底，统一更稳）。
- **死代码清理**：files.js（pathExists/relativeTo/absoluteIn/parentDirOf/noteDir/knownDirList/resourceType 属性及未用 path 导入）、baseline.js（BASELINE_FILE_NAME）、journal.js（destroy）、snapshots.js（destroyAll/limits/logger）、opener.js（platform getter/logger）、manager.js（未用的公共面与导出）、session-manage.js（未用 isAbsolute 导入）、smoke-host.mjs（未用导入）。两个扫描器（导出/导入引用）复查归零。
- 测试：`smoke-lifecycle.mjs` 增至 **193 项断言**（新增 env 外部改/外部删、chmod 收养文件保留用例），连跑三轮全绿；真机复验：驱动 29/29、agent 回合 8/8、崩溃恢复通过、截断场景 5/5。

### 0.3.4（高危缺口修复：截断误删防护 + 环境变量不再污染宿主）

- **修复基线截断可能误删既有文件**：基线扫描超过 `trackingMaxFiles`（默认 5000）时会截断，未收录的既有文件在首次 diff 时会被误判为「会话新建」——删除会话时就可能删掉它们（你的 default-workspace 已触发截断条件）。现在用 **birthtime 二次判定**（扫描已记录；无 birthtime 的 FS 回退 mtime）：早于会话开始的文件一律**静默收养为既有资源**——不写 Journal、不进资源视图、绝不被清理移除；会话对这类文件的修改/删除在回滚时跳过并报告 `preexisting-unbaselined`（原内容未被快照，无法恢复）。状态刷新时保留 `unbaselined` 血统标记，`before` 侧全程携带。
- **修复环境变量解析污染宿主进程**：旧行为会把 `export FOO=bar` 的值应用到宿主进程 env——一条会话命令（如 `export PATH=...`、`NODE_OPTIONS`）会真实影响 harness 后续所有子进程。现在**只记录、绝不改写宿主 env**；并把 PATH / NODE_OPTIONS / NODE_PATH / LD_* / DYLD_* / HOME / TMPDIR / SHELL / IFS / DSH_HOME 等运行性变量直接排除出跟踪。清理阶段的 env 恢复对「宿主从未改变」的变量是刻意 no-op。
- **修复 `session-manage.js` 的一处作用域缺陷**：资源清理异常处理器引用了不在作用域的 `logger`，会把真实的清理错误掩盖成 `logger is not defined`（本轮回归首次触发暴露）。
- **测试**：`smoke-lifecycle.mjs` 增至 181 项断言，新增：模拟截断基线的静默收养（既有文件不写 Journal/不进视图/不被删除、被修改后仍保留）、真新建文件照常清理、PATH 排除、宿主 env 不被改写；连跑三轮全绿。真机（隔离宿主）复验：驱动 29/29、真实 agent 回合 8/8、**截断场景 5/5**（既有文件全部保留 + 新建文件正常清理）。

### 0.3.3（修复已删除会话的 tracking 目录复活）

- **真机验证发现并修复**：删除会话后，宿主重启时的基线扫描（及列表自愈）会依据过期的内存语料把一个**已被删除**的会话重新建基线——刚销毁的 tracking 目录被复活；另外 `session/created` 触发的防抖 activity.json 写入（1.5s）可能在删除落定后才落盘，用 `mkdir` 把目录建回来（只剩一个 activity.json）。两处一并修复：
  - `ensureBaseline` 守卫扩展为**凡在回收站清单中的会话一律不再建基线**（恢复后自动解除，可重新跟踪）；
  - activity 防抖写入落盘前核对回收站清单，且销毁 Journal 前取消未决的写入定时器。
- 新增回归用例（删除 → 保持在语料中 → 重启 → 断言 tracking 不复活；opener/track/delete 全套真机复验）。
- 真机复验：驱动 29 项断言、真实 agent 回合 8 项断言、kill -9 崩溃恢复全部通过；修复后「建→跟踪→删除→等 3 秒→重启」确认目录保持清理。

### 0.3.2（打开方式收敛为本机文件管理器）

- **资源打开只保留本机文件管理器**：移除应用下拉、应用扫描（`listApplications` 端点及 `openWith`/扫描代码全部删除），单个打开、批量打开、打开工作区统一走文件管理器定位（macOS 访达 `open -R` / Windows 资源管理器 `/select` / Linux `xdg-open` 父目录）。工具栏改为一行说明文案 + 全选 / 反选 / 打开工作区 / 打开所选。
- `openResource` 端点签名收敛为 `{ id, path }`（不再接受 `app`）。
- 测试：smoke-lifecycle 156 项断言（open 用例覆盖 reveal argv / 工作区根 / 越界 / 缺失 / 未跟踪）；渲染冒烟断言应用下拉**不存在**、工具栏与全选/反选存在。

### 0.3.0（资源打开：文件管理器 / 自选应用 + 弹窗显示修复）

- **修复资源弹窗显示不全**：宿主 Modal 对话框固定 380px 宽且 `overflow: hidden`，0.2.x 的内容区 `min-width: 72vw` 与 `max-height: 56vh` 被直接裁掉。现在经 Modal 的 `className` 参数把对话框加宽到 `min(860px, 100%)`、内容区自适应滚动（遵循宿主"用 `max-height: 100%`"的约定），长路径换行显示。
- **新增资源打开能力**（`lifecycle/opener.js` + RPC `openResource` / `listApplications`）：
  - 单个资源：每行「打开」按钮——默认在本机文件管理器中**显示**（macOS `open -R` 定位 / Windows `explorer /select` / Linux `xdg-open` 父目录）；
  - **打开方式自选**：弹窗内下拉列出自动扫描的本机应用（macOS 三处 Applications 目录、Windows 开始菜单 .lnk、Linux .desktop 的 Name=），选择后用该应用打开；
  - **批量操作**：文件类资源带勾选框，勾选后「打开所选（N）」逐个发送打开请求；另有「打开工作区」一键定位会话工作目录；
  - 安全：spawn 一律 argv 数组无 shell 拼接（Windows `start` 例外处先做 shell 元字符校验）；可打开路径严格限制在该会话基线 cwd 之内，越界 / 不存在 / 未跟踪会话分别报 `unsafe-path` / `resource-missing` / `untracked`；
  - 环境变量与进程记录无文件可打开，不显示打开按钮。
- 测试：`smoke-lifecycle.mjs` 163 项断言（新增 openResource 默认 / 指定应用 / 工作区根 / 越界 / 缺失 / 未跟踪 / 应用列表扫描与排序用例，opener 走 log 模式不弹真窗口）；client 渲染冒烟覆盖工具栏 / 下拉 / 勾选框。

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
