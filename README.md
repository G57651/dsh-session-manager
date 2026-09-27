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

> 本插件不会自动安装。任选以下一种方式手动安装到桌面 App 的 profile（`~/.dsh/profiles/desktop`）。

**方式 A：Web UI 安装（推荐）**

1. 打开 DeepSeek Harness，进入侧边栏 **Plugins** 面板。
2. 选择从**本地路径**安装，填入本目录的绝对路径
3. 启用后重启 Web UI（或等 HMR 生效），侧边栏出现「会话管理」入口。

**方式 B：CLI 安装**

```sh
dsh plugin --profile desktop add /Users/a0629/Documents/deepseek-harness/dsh-session-manager
```

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
node scripts/smoke-host.mjs     # host 半功能冒烟（隔离临时 $DSH_HOME，61 项断言）
```

宿主半 RPC 通道为 `/dsh-session-manager`，端点：`list / archive / unarchive / delete / restore / purge / config`，全部接受批量 `ids` 数组并返回逐条结果。

## 实现说明与已知限制

- **源码语言**：host 半与 client 半均为纯 ESM JavaScript（JSDoc 标注），与已验证的第三方插件先例一致；未用 TypeScript 是因为本插件需在无网络的机器上构建（无编译器可用），client 半由 `scripts/build-client.mjs` 按 `src/client/` 源约定组装成 `window.__ModuleLoader__.load` CJS 单文件。
- **删除语义**：官方层无删除 API。软删除 = 清单标记 + 原生归档隐藏；彻底删除 = 停活动 + 移除会话目录（有 `locate()` 定位 + `$DSH_HOME/sessions` 路径守卫 + id 校验三重防护，拒绝越界路径）。
- **幽灵行过滤**：彻底删除后官方 sessionController 的内存态可能残留该会话（无 removed 事件），列表按「无 header 且非活动」过滤，避免幽灵行。
- **归档/删除无远程事件**：这两个操作后列表由 RPC 返回值本地刷新；归档会话是当前激活会话时，原生 UI 会自动切走主面板（官方行为）。
- 兼容目标 `engines.dsh: ">=0.1.7-rc.0"`（声明性字段，实测于 0.1.7-rc.2）。
