---
status: active
last_verified: 2026-10-07
owner: gently
scope: 本机核心能力契约（无服务器形态）
token_budget: 2000
tldr: 产品不提供任何服务器，因此不存在 HTTP 边界。契约 = Rust 本机核心的 Tauri 命令与事件清单（约 45 条）+ 统一信封 + 错误码表；插件用内嵌 QuickJS 运行、资源靠本地/URL 通用导入（社区自建 git 仓库由用户自行 clone 后导入目录）。
---

# 本机核心能力契约（local core）

## 0. 形态

`gently` 是桌面端软件，**我们不提供服务器**：没有账号体系、没有市场后端、没有遥测上报。
因此原 `backend-api.md`（HTTP 规范）已被本文件取代，实现骨架 `server/` 归档在
`docs/archive/server-ts/`（保留其清单思想与测试守卫，代码不再演进）。

```
React（UI / store / services）
   │  invoke(command) / listen(event)      ← Tauri IPC，无 HTTP、无端口、无 CORS
Rust 本机核心（src-tauri 或 core crate）
   ├─ 插件宿主（内嵌 QuickJS，沙箱 + 权限）
   ├─ 曲库聚合与缓存（跨源去重、候选排序、回退）
   ├─ 本地库 / 播放史 / 收藏 / 歌单（SQLite）
   ├─ 下载管理（本地文件系统）
   ├─ 皮肤仓库（惰性 JSON 文档）
   └─ 凭据（OS keyring，仅存第三方音乐服务凭据）
```

**为什么本机形态下才允许删掉的东西**：无多租户 → 无鉴权/令牌/会话；无网络边界 → 无 CORS、
限流、ETag、幂等键；单进程 → 无游标分页的跨请求一致性要求；无 web 端 → 无 HTTP 语义负担。

## 1. 信封与错误码

命令**永不抛异常**：Rust 侧返回信封结构体（不是 `Result`），只有 IPC 反序列化失败或 panic
会让 `invoke` reject，由前端薄封装转成 `common.internal`。

```ts
type CoreResult<T> =
    | {ok: true;  data: T;           traceId: string}
    | {ok: false; error: CoreError;  traceId: string};

interface CoreError {
    code: CoreErrorCode;                 // 机器可读，前端按码分支，不解析 message
    message: string;                     // 面向开发者
    details?: Record<string, unknown>;    // 结构化细节（如校验 issues、插件权限清单）
}
```

`traceId` 贯穿本地日志（`tracing` span），用于「诊断」页面与日志检索。

| 错误码 | 含义 | 前端动作 |
|---|---|---|
| `common.invalid_argument` | 参数非法（含皮肤/清单结构问题） | 展示 `details` |
| `common.not_found` | 资源不存在 | 空态 |
| `common.conflict` | 并发写冲突（如 config revision） | 刷新后重试 |
| `common.cancelled` | 用户或调用方取消（扫描/下载/导入） | 静默 |
| `common.unsupported_platform` | 当前平台不支持该能力 | 隐藏入口 |
| `common.not_implemented` | 契约已定、实现未接入（灰度期） | 提示「暂不可用」 |
| `common.internal` | 内部错误（含 IPC 反序列化失败） | 提示 + 引导看日志 |
| `plugin.invalid_manifest` | 插件清单非法 | 指出字段 |
| `plugin.duplicate_id` | 同 id 插件已存在 | 提示覆盖 |
| `plugin.import_failed` | 导入失败（路径/压缩包/URL） | 展示原因 |
| `plugin.permission_denied` | 插件请求了未声明的能力 | 拒绝并记录 |
| `plugin.credential_missing` | 缺少第三方凭据 | 引导到凭据页 |
| `plugin.runtime_error` | 插件 JS 抛错/超时 | 标记源不可用并回退 |
| `source.upstream_failed` | 上游音源请求失败 | **不提示用户**，切下一个候选 |
| `source.auth_expired` | 第三方登录态失效 | 提示重新授权 |
| `playback.no_source` | 无可用音源（**返回 `data: null` 优先于本错误**） | 退回模拟时钟 |
| `library.io_error` | 本地读写失败 | 提示路径/权限 |
| `library.scan_failed` | 扫描目录失败 | 展示失败子目录 |
| `download.disk_full` | 磁盘空间不足 | 提示清理 |
| `skin.invalid_document` | 皮肤文档结构非法 | 指出字段 |
| `skin.token_rejected` | 皮肤含未允许的令牌键名 | **列出被拒键名**（不再静默忽略） |

## 2. 命令清单

约定：`ref` 是统一曲目引用 `source:trackId`；`[]` 表示可选；所有写命令**无需幂等键**
（本地事务，重试不会跨网络重复）。

### system（替代原 health / realtime 探针）
| 命令 | 参数 | 返回 |
|---|---|---|
| `system.status` | — | `{version, platform, dbPath, dataDir, pluginRuntime, counts:{plugins,favorites,tracks,downloads}}` |
| `system.paths` | — | `{data, cache, plugins, skins, downloads, logs}` |
| `system.reveal` | `{path}` | `void`（在文件管理器中打开） |

### catalog（曲库聚合，直连插件宿主）
| 命令 | 参数 | 返回 |
|---|---|---|
| `catalog.search` | `{keyword, sources?[], minQuality?, limit?, cursor?}` | `Page<GroupedTrack>` |
| `catalog.charts` | `{chart, period, date?, sources?[], limit?}` | `{chart, period, date, entries: ChartEntry[]}` |
| `catalog.track` | `{ref}` | `GroupedTrack \| null` |
| `catalog.album` | `{id}` | `Album \| null` |
| `catalog.curated` | `{id}` | `CuratedPlaylist \| null` |
| `catalog.lyrics` | `{ref, source?, withTranslation?}` | `Lyrics \| null`（无词返回 null，不是错误） |

### library（本地 SQLite）
| 命令 | 参数 | 返回 |
|---|---|---|
| `library.favorites.list` | `{limit?, cursor?}` | `Page<GroupedTrack>` |
| `library.favorites.set` | `{ref, favorite}` | `{favorite}`（取代原增量 sync：本地直接写） |
| `library.playlists.list` | — | `Playlist[]` |
| `library.playlists.save` | `{id?, name, description?, trackRefs[]}` | `Playlist` |
| `library.playlists.delete` | `{id}` | `void` |
| `library.history.list` | `{limit?, cursor?}` | `Page<RecentTrack>` |
| `library.history.push` | `{ref, playedSec, completed}` | `void` |
| `library.local.scan` | `{dirs[], recursive?}` | `{added, updated, removed}` + 进度事件 |
| `library.local.list` | `{limit?, cursor?}` | `Page<LocalTrack>` |
| `library.local.remove` | `{id, deleteFile?}` | `void` |

### recommend（纯本地打分，读 SQLite 播放史）
| 命令 | 参数 | 返回 |
|---|---|---|
| `recommend.home` | `{limit?}` | `RecommendationBundle` |
| `recommend.similar` | `{seed: ref \| {albumId}, limit?}` | `RecommendedTrack[]` |
| `recommend.feedback` | `{ref, action:'play'\|'skip'\|'like'\|'unlike'\|'complete', progress?}` | `void` |

### playback
| 命令 | 参数 | 返回 |
|---|---|---|
| `playback.resolve` | `{ref, quality, preferredSources?[]}` | `ResolvedSource \| null`（按 `plugin` 优先级依次回退） |
| `playback.report` | `{ref, source, quality, playedSec, completed}` | `void` |

### plugin（无市场后端：只做导入/管理）
| 命令 | 参数 | 返回 |
|---|---|---|
| `plugin.list` | — | `PluginInfo[]`（含权限、健康、导入来源） |
| `plugin.preview` | `{from: PluginSource}` | `{manifest, permissions, credentials, warnings[]}`（**安装前展示同意**） |
| `plugin.import` | `{from: PluginSource, consent: true}` | `PluginInfo` |
| `plugin.remove` | `{id, deleteFiles?}` | `void` |
| `plugin.setEnabled` | `{id, enabled}` | `PluginInfo` |
| `plugin.setPriority` | `{id, priority}` | `void`（音源回退顺序） |
| `plugin.checkUpdate` | `{id}` | `{current, latest} \| null`（仅 URL/压缩包导入者） |
| `plugin.reload` | `{id}` | `void`（重建 JS 运行时） |
| `plugin.config.get` / `plugin.config.put` | `{id}` / `{id, values, revision}` | `{values, revision}` |
| `plugin.credentials.set` / `.clear` | `{id, key, value}` / `{id, key?}` | `void`（OS keyring） |
| `plugin.credentials.status` | `{id}` | `{key, present}[]`（**永不返回值**） |

```ts
/** 通用导入来源：本地目录 / 压缩包 / URL / 直接给清单文本（皮肤同构） */
type PluginSource =
    | {kind: 'dir';     path: string}          // git clone 后指向仓库目录
    | {kind: 'archive'; path: string}          // 用户手动下载的 zip/tar.gz
    | {kind: 'url';     url: string}           // 远程压缩包或清单直链
    | {kind: 'paste';   manifest: string};     // 分享的清单文本
```

### download（本地文件系统 + 事件推进度）
`download.list` / `create{ref, quality, dir?}` / `pause{id}` / `resume{id}` /
`remove{id, deleteFile?}` / `clearFinished`

### skin（惰性文档，导入导出即分享）
`skin.list` / `skin.preview{from}` / `skin.install{from}` / `skin.remove{id}` /
`skin.setActive{id|null}` / `skin.export{id, format:'json'|'file'}`

## 3. 事件清单

| 事件 | 载荷 | 用途 |
|---|---|---|
| `download.progress` / `download.done` / `download.error` | `DownloadTask` | 下载切片 |
| `plugin.health` | `PluginInfo` | 标记源不可用并触发回退 |
| `plugin.import.progress` | `{phase, percent?}` | 导入/解包/校验进度 |
| `library.scan.progress` | `{dir, found, percent?}` | 本地曲库扫描 |

## 4. 多音源策略（沿用，去掉网络部分）

1. **聚合展示**：同一首歌（标题 + 歌手归一化）合并为 `GroupedTrack`，`candidates` **按
   `plugin.priority` 排序即优先级**，前端不做二次排序；
2. **播放回退**：`playback.resolve` 依次尝试候选，逐个源调用 JS 的 `resolveUrl`；
   全部失败返回 **`data: null`**（不是错误），前端退回模拟时钟；
3. **音质降级**：源不支持期望档位时返回实际下发档位，前端据此显示真实音质；
4. **健康标记**：一次调用失败即标脏并在后台重探；连续失败达阈值才禁用该源（避免网络抖动误杀）；
5. **单源视图**：仍支持按源筛选（页面 tabs/抽屉），能力与聚合视图共存。

## 5. 插件模型（内嵌 QuickJS）

**运行时**：内嵌 QuickJS（`rquickjs`），每个插件一个独立运行时实例。

- 贡献者写 **JS/TS 源码**（无需编译到 wasm），社区门槛最低；
- 宿主只注入白名单能力，**没有** `fs` / `process` / 原生模块：
  `fetch`（仅清单 `hosts` 声明的域名，仅 HTTPS）、`crypto`、`console`、
  `storage`（插件私有 kv）、`credentials.get(key)`（经 keyring，只回值给该插件）；
- 每次调用有超时（`PLUGIN_REQUEST_TIMEOUT_MS`）与内存上限；超时/抛错 → `plugin.runtime_error`
  并计入健康度。

**JS 侧接口**（与现有 `src/plugins/types.ts` 的 `MusicSourcePlugin` 同形，便于把内置源直接迁出）：

```js
export const info = {id, name, version, author, description};
export const qualities = ['hires', 'lossless', 'high', 'standard'];
export async function fetchChart({chart, period, date, dateKey}) {}
export async function fetchRecommend(limit) {}
export async function search(keyword) {}
export async function resolveUrl(track, quality) {}   // null = 该源不可播
```

**`plugin.json` 清单**（沿用已实现的 `server/src/infra/plugins/manifest.ts` 字段）：
`id / name / version / author / description / homepage? / entry / runtime:'js' / qualities[] /
permissions[] / hosts[] / credentials[] / minCoreVersion?`。
新增 `hosts`（网络白名单，替代原来笼统的 `network` 权限）与 `runtime`（当前只有 `js`，为将来
wasm 留位）。

**信任模型（社区资源 = 不可信代码）**：
- 安装必须走 `plugin.preview` → 展示权限与凭据需求 → `plugin.import({consent:true})`；
- **绝不执行安装脚本**，只读清单 + 复制文件；
- URL/压缩包导入记录来源与内容校验和，更新时校验和不一致要显式告知；
- 不自动更新；`plugin.checkUpdate` 只做比对；
- 皮肤是惰性数据（安全），但仍需令牌键名白名单（见 §6）。

## 6. 皮肤模型

皮肤 = `ThemeSkin` JSON（可覆盖 `theme.config.json` 的任意令牌组），**导入导出即分享**，
与插件共用 `from: PluginSource` 形状。

- `skin.preview` 做**令牌键名白名单**校验：未知键名 → `skin.token_rejected` 并列出键名
  （修掉已知缺口：从前的「静默忽略」会让作者以为生效了）；
- 内置 11 套皮肤与主题市场 UI 已在前端实现，本契约只补齐「导入/导出/激活/删除」的落点。

## 7. 本机存储

```
<appData>/gently/
├── gently.db          SQLite：favorites / playlists / playlist_tracks / play_history /
│                      local_tracks / plugin_state / plugin_config / download_tasks / skins / meta
├── plugins/<id>/      plugin.json + entry.js（导入来源记在 plugin_state）
├── skins/<id>.json    用户皮肤（内置皮肤在包内）
├── downloads/         下载落盘
├── cache/             榜单 / 歌词 / 封面（可整目录删除）
└── logs/              tracing 日志，按天滚动
```

无 Postgres、无 Redis、无队列：跨进程协调不存在，长任务用 tokio 任务 + 事件推进度。

## 8. 从旧 HTTP 契约迁移

| 旧（41 条 HTTP） | 新形态 |
|---|---|
| `auth.*`（4） | **删除**。第三方音乐服务凭据走 `plugin.credentials.*` + OS keyring，不经我方任何服务 |
| `health.check` / `health.ready`（2） | `system.status` |
| `realtime.connect`（WS） | Tauri 事件（§3） |
| `library.*.sync` / `history.push`（幂等写） | `library.favorites.set` / `library.history.push`（本地事务，无幂等键） |
| `plugin.install` / `check-updates`（市场） | `plugin.preview` + `plugin.import` + `plugin.checkUpdate`（无市场后端） |
| `skin.publish` / `skin.mine` / `skin.sync` | `skin.export` / `skin.list` / `skin.install` |
| 游标分页 / `Idempotency-Key` / 限流 / ETag | 删除（本地不需要） |
| `catalog.*` / `playback.*` / `recommend.*` / `download.*` 语义 | **保留**，换成命令 |

## 9. 非功能性

- **无遥测**：不向任何服务器发送数据；如需错误上报，只在本地写日志。
- **诊断**：`system.status` 供设置页展示；日志按天滚动、默认保留 7 天。
- **性能预算**：曲库搜索 P95 < 300ms（本地缓存命中时 < 50ms）；插件调用超时默认 8s；
  扫描 1 万文件 < 10s（后台任务 + 进度事件）。
- **兼容**：命令新增字段必须可选；命令改名/删除需要先在 ADR 或本文件标注 deprecated 一个版本。
- **密码学**：凭据只存 OS keyring（Windows Credential Manager / macOS Keychain / libsecret）；
  SQLite 与日志中永不出现凭据明文。
