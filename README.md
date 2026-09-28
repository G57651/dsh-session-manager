# dsh-session-manager

DeepSeek Harness Web UI 会话管理插件：在主页侧边栏新增一个「会话管理」面板，提供全部 / 已归档 / 已删除三个视图、手动 + 自动刷新，以及批量管理（归档 / 取消归档 / 删除 / 恢复 / 彻底删除）。

## 功能

- **全部**：未删除的所有会话（含已归档，带「已归档」徽标），显示标题、相对更新时间、大小、工作目录；行悬停有归档/删除快捷操作。
- **已归档**：原生归档会话（`ctx.workspaceRegistry`），可批量取消归档。
- **已删除**：插件自建回收站清单。删除为**软删除**（借原生归档从主列表隐藏，磁盘数据保留，记录删除前是否已归档）；可批量恢复、可彻底删除（二次确认后停活动 → 移除 `$DSH_HOME/sessions` 下的会话目录）。
- **刷新**：手动刷新按钮；同时监听 `api-session/added|removed|status|activity` 远程事件自动同步（可在配置中关闭）。
- **批量管理**：显式进入选择模式（复选框 + 全选 / 反选 + 底部浮动操作栏），操作集随当前视图变化。
- 中英双语（跟随宿主语言）、明暗主题自动跟随（仅使用 `--dsw-alias-*` 语义 token）。

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

## 数据文件

- `$DSH_HOME/dsh-session-manager-deleted.json` — 回收站清单（`{id, title, cwd, deletedAt, wasArchived}`）。
- `$DSH_HOME/dsh-session-manager-titles.json` — 会话标题缓存（含负缓存；实时会话经 `session/title` 事件保持最新）。

两份文件都由插件自维护，卸载插件后可手动删除。

## 开发与验证

```sh
node scripts/build-client.mjs   # 组装 client.js（纯 Node，无外部依赖）
node scripts/smoke-host.mjs     # host 半功能冒烟（隔离临时 $DSH_HOME，65 项断言）
```

> 0.1.2 起 `scripts/` 仅存在于源码仓库，不随 tarball 发布——请 clone 仓库后在仓库根目录运行。

宿主半 RPC 通道为 `/dsh-session-manager`，端点：`list / archive / unarchive / delete / restore / purge / config`，全部接受批量 `ids` 数组并返回逐条结果。

## 实现说明与已知限制

- **源码语言**：host 半与 client 半均为纯 ESM JavaScript（JSDoc 标注），与已验证的第三方插件先例一致；未用 TypeScript 是因为本插件需在无网络的机器上构建（无编译器可用），client 半由 `scripts/build-client.mjs` 按 `src/client/` 源约定组装成 `window.__ModuleLoader__.load` CJS 单文件。
- **删除语义**：官方层无删除 API。软删除 = 清单标记 + 原生归档隐藏；彻底删除 = 停活动 + 移除会话目录（有 `locate()` 定位 + `$DSH_HOME/sessions` 路径守卫 + id 校验三重防护，拒绝越界路径）。
- **幽灵行清理（v0.1.1 修复）**：官方层无删除 API，`api-session/removed` 只由 `session/disposed`（活会话拆卸）发出，而移除会话目录不触发拆卸——所以官方侧边栏既拿不到移除事件，`workspaceRegistry.archivedSessionIds` 与工作区 `sessionIds` 里的条目也无人清理，残留直到进程重启（此时 `bootstrap()` 重扫磁盘才剪掉）。彻底删除成功后插件改为三步失效：逐个工作区 `detachSession(id)`（未记账则空操作）→ `workspaceRegistry.unarchiveSession(id)`（不做存在性校验，条目已消失也照常解析）→ `ctx.emit('api-session/removed', id)` 转发给客户端，客户端 `handleSessionRemoved` 直接丢弃该行。因此无需重启，侧边栏即时同步。此外把 id 记入进程级已清除集合，各视图无条件过滤，作为兜底。
  - **残留限制**：`sessionQuery` 语料库与 `sessionController` 是进程内缓存，`sessions` 服务没有对外提供驱逐接口（`enter()` 对已存在的会话直接抛错），目录移除不会让缓存失活。进程重启后重扫磁盘会彻底清干净，但同进程内的客户端重连（如刷新 Web 页面）会重新拉到残留条目。桌面端侧边栏为长驻视图、不做整表重拉，不受影响。
- **归档/删除无远程事件**：这两个操作后列表由 RPC 返回值本地刷新；归档会话是当前激活会话时，原生 UI 会自动切走主面板（官方行为）。
- 兼容目标 `engines.dsh: ">=0.1.7-rc.0"`（声明性字段，实测于 0.1.7-rc.2）。

## 变更记录

### 0.1.2

- **package.json**：`@deepseek-ai/schemastery` 同时声明进 `peerDependencies` 与 `devDependencies`（开发规范 7.3 双声明要求）。
- **package.json**：移除 `scripts` 字段（`build:client` / `smoke` 只在源码仓库提供，tarball 安装后执行必然 ENOENT）。
- **index.js**：回退 RPC 路由强制 `Content-Type: application/json`，其他媒体类型以 415 拒绝——跨站表单 POST 无法携带该媒体类型，伪造请求到不了分发器；直接 curl 调试需自带 `-H 'Content-Type: application/json'`。
- **index.js**：日志改走规范 API——`ctx.logger` 可调用时取具名 logger（`ctx.logger('dsh-session-manager')`），宿主仅提供 `{ warn, info }` 对象时回退；修复旧代码在可调用语义下全部日志静默丢失的问题。
