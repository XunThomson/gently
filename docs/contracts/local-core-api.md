---
status: active
last_verified: 2026-10-07
version: 0.2
owner: gently
scope: 本机核心能力契约（无服务器形态）
token_budget: 2600
tldr: 本机核心的 Tauri 命令与事件清单（约 57 条命令 + 8 类事件）。v0.2 相对 v0.1 补齐三处硬伤：插件 API 支持专辑/歌单/歌词/榜单（否则对应命令永远无法实现）、媒体地址携带 headers 并由核心提供本地流代理（WebView 的 audio 无法设请求头、需 Range）、分发改为「单文件 JS + 订阅源索引」为主。
---

# 本机核心能力契约（local core）v0.2

## 0. 形态

`gently` 是桌面端软件，**我们不提供服务器**：无账号、无市场后端、无遥测、无 web 端
（`docs/adr/0003-no-server-local-core.md`）。能力一律由 **Rust 本机核心**经 Tauri IPC 暴露：

```
React（UI / store / services）
   │  invoke(command) / listen(event)      ← 无 HTTP、无端口、无 CORS、无 JWT
Rust 本机核心
   ├─ 插件宿主（内嵌 QuickJS + 权限白名单）  ├─ 本地流代理（媒体传输，见 §7）
   ├─ 曲库聚合与缓存                        ├─ 本地库 / 播放史 / 收藏 / 歌单（SQLite）
   ├─ 下载管理                              ├─ 皮肤仓库（惰性 JSON）
   └─ 第三方凭据（OS keyring）
```

> **前端 `src/plugins/**` 不是插件 ABI**：那是浏览器 mock 兜底用的最小接口
> （search + resolveUrl）。插件 ABI 由核心定义，见 §5。

## 1. 信封与错误码

命令**永不抛异常**：Rust 返回信封结构体（不是 `Result`），只有 IPC 反序列化失败或 panic
才 reject，由前端薄封装转成 `common.internal`。

```ts
type CoreResult<T> =
    | {ok: true;  data: T;           traceId: string}
    | {ok: false; error: CoreError;  traceId: string};
interface CoreError {code: CoreErrorCode; message: string; details?: Record<string, unknown>}
```

| 错误码 | 含义（前端动作） |
|---|---|
| `common.invalid_argument` | 参数非法 / 皮肤·清单结构问题（展示 details） |
| `common.not_found` | 资源不存在（空态） |
| `common.conflict` | 并发写冲突，如 config revision（刷新重试） |
| `common.cancelled` | 用户或调用方取消（静默） |
| `common.unsupported_platform` | 平台不支持（隐藏入口） |
| `common.not_implemented` | 契约已定、实现未接入；**插件未实现该能力时也用它** |
| `common.internal` | 内部错误（提示 + 引导看日志） |
| `plugin.invalid_source` | 插件源文件非法：头部元数据缺失/格式错/缺必选函数 |
| `plugin.invalid_manifest` | 目录包 `plugin.json` 非法 |
| `plugin.duplicate_id` | 同 id 已存在 |
| `plugin.import_failed` | 导入失败（路径/压缩包/URL/校验和不符） |
| `plugin.permission_denied` | 插件请求未声明的能力（拒绝并记录） |
| `plugin.credential_missing` | 缺少第三方凭据（引导到凭据页） |
| `plugin.runtime_error` | 插件 JS 抛错/超时/超内存（标记源不可用并回退） |
| `subscription.fetch_failed` | 订阅索引拉取失败 |
| `subscription.invalid_index` | 订阅索引结构非法（`repository.json`） |
| `source.upstream_failed` | 上游音源请求失败（**不提示用户**，切下一候选） |
| `source.auth_expired` | 第三方登录态失效（提示重新授权） |
| `playback.no_source` | 无可用音源（**优先返回 `data: null`**，前端退回模拟时钟） |
| `media.proxy_failed` | 本地流代理启动/转发失败 |
| `media.blocked_address` | 媒体地址指向内网/回环/链路本地（SSRF 防护，拒绝） |
| `library.io_error` / `library.scan_failed` | 本地读写/扫描失败 |
| `download.disk_full` | 磁盘空间不足 |
| `skin.invalid_document` / `skin.token_rejected` | 皮肤结构非法 / 含未允许的令牌键名（列出键名） |

## 2. 命令清单

约定：`ref` = `source:trackId`；`source` = 插件 id。写命令无需幂等键（本地事务）。

### system（3）
| 命令 | 参数 | 返回 |
|---|---|---|
| `system.status` | — | `{version, platform, dbPath, dataDir, pluginRuntime, dbReady, dbError?, counts:{plugins,favorites,tracks,downloads}}`——`pluginRuntime` 在 M0 为 `none`、M1 接入 QuickJS 后为 `quickjs`；`dbReady:false` 表示降级运行（`dbError` 给出原因） |
| `system.paths` | — | `{data, cache, plugins, subscriptions, skins, downloads, logs}` |
| `system.reveal{path}` | 受管目录内的路径 | `null`；目录外或不存在 → `common.invalid_argument` / `common.not_found` |

### plugin：管理（13）
| 命令 | 说明 |
|---|---|
| `plugin.list` | 已安装插件（权限、健康、来源、订阅归属） |
| `plugin.preview{from}` | 安装前展示清单、权限、凭据需求、warnings |
| `plugin.import{from, consent:true}` | 落盘安装；**不执行安装脚本**；记录来源与校验和 |
| `plugin.remove{id, deleteFiles?}` | 卸载 |
| `plugin.setEnabled{id, enabled}` / `plugin.setPriority{id, priority}` | 启停与回退顺序 |
| `plugin.reload{id}` | 重建运行时（改配置后） |
| `plugin.checkUpdate{id}` | 与来源比对版本/校验和（不自动更新） |
| `plugin.config.get{id}` / `plugin.config.put{id, values, revision}` | 插件配置，revision 冲突 → `common.conflict` |
| `plugin.credentials.set{id, key, value}` · `plugin.credentials.clear{id, key?}` · `plugin.credentials.status{id}` | OS keyring；`status` **永不返回值** |

### plugin：订阅与仓库（5）
| 命令 | 说明 |
|---|---|
| `plugin.subscriptions.list` | 订阅源列表（名称、URL、更新时间、条目数） |
| `plugin.subscriptions.add{url, name?}` | 添加订阅（指向一个 `repository.json`） |
| `plugin.subscriptions.remove{id}` | 移除订阅（已安装插件不受影响） |
| `plugin.subscriptions.refresh{id}` | 重新拉取索引并本地缓存；失败保留旧索引并报 `subscription.fetch_failed` |
| `plugin.catalog.list{subscriptionId?, query?, tags?}` | 订阅内可安装条目（带 `installed` / `updateAvailable`） |

### catalog（9）
| 命令 | 说明 |
|---|---|
| `catalog.search{keyword, sources?, limit?}` | **流式**：立即返回 `{searchId}`，结果通过事件分批到达（§3） |
| `catalog.searchCancel{searchId}` | 取消 fan-out（慢源不该拖住用户） |
| `catalog.track{ref}` | 曲目详情（`getTrackInfo`） |
| `catalog.album{source, id}` / `catalog.playlist{source, id}` | 专辑 / 歌单详情 |
| `catalog.topLists{source}` | 榜单与分类树（**源自定义分类**，不是固定 hot/new/rise） |
| `catalog.topList{source, id, page?}` | 某个榜单/分类的内容 |
| `catalog.recommend{source}` | 源侧推荐 |
| `catalog.lyrics{ref, withTranslation?}` | 歌词；无词返回 `data: null` |

> 说明：v0.1 的 charts 命令（固定 hot/new/rise 枚举）已被 `topLists` / `topList` 取代——
> 真实源提供的是任意分类树，固定枚举映射不了。**排行榜页需要按源的分类树渲染**（前端改动）。
> 变更明细见 §10。

### library（10）
`library.favorites.list{limit?,cursor?}` · `library.favorites.set{ref, favorite}` ·
`library.playlists.list` · `library.playlists.save{id?, name, trackRefs}` · `library.playlists.delete{id}` ·
`library.history.list{limit?,cursor?}` · `library.history.push{ref, playedSec, completed}` ·
`library.local.scan{dirs, recursive?}` · `library.local.list{limit?,cursor?}` · `library.local.remove{id, deleteFile?}`

### recommend（3）
`recommend.home{limit?}` · `recommend.similar{seed, limit?}` · `recommend.feedback{ref, action, progress?}`

### playback（2）
`playback.resolve{ref, quality, preferredSources?}` → `ResolvedMedia | null`（含 headers 与 `streamUrl`，见 §7）
`playback.report{ref, source, quality, playedSec, completed}`

### download（6）
`download.list` · `download.create{ref, quality, dir?}` · `download.pause{id}` · `download.resume{id}` ·
`download.remove{id, deleteFile?}` · `download.clearFinished`

### skin（6）
`skin.list` · `skin.preview{from}` · `skin.install{from}` · `skin.remove{id}` ·
`skin.setActive{id|null}` · `skin.export{id, format:'json'|'file'}`

### 导入来源（插件与皮肤共用）
```ts
type ImportSource =
    | {kind:'file';      path: string}        // 单文件 .js（插件）或 .json（皮肤）
    | {kind:'dir';       path: string}        // 目录包：plugin.json + entry
    | {kind:'archive';   path: string}        // zip / tar.gz
    | {kind:'url';       url: string}         // 远程文件或压缩包
    | {kind:'paste';     content: string}     // 粘贴的源文件/清单文本
    | {kind:'catalog';   subscriptionId: string; fileName: string};  // 从订阅一键安装
```

## 3. 事件清单（8）

| 事件 | 载荷 | 用途 |
|---|---|---|
| `catalog.search.partial` | `{searchId, source, tracks[], failed?: CoreError}` | 逐源到达；用于流式 UI 与「分源视图」 |
| `catalog.search.done` | `{searchId, items: GroupedTrack[], sources[], failedSources[]}` | 最终聚合结果（含候选合并） |
| `download.progress` / `download.done` / `download.error` | `DownloadTask` | 下载 |
| `plugin.health` | `PluginInfo` | 标记源不可用并触发回退 |
| `plugin.import.progress` | `{phase, percent?}` | 导入进度 |
| `library.scan.progress` | `{dir, found, percent?}` | 扫描进度 |

搜索流程：`invoke('catalog.search')` → 立刻拿到 `searchId` → 前端订阅事件增量渲染 →
`catalog.search.done` 收敛出「跨源合并后的候选列表」。合并始终在核心完成（单一职责）。

## 4. 多音源策略

1. **候选排序**：同一首歌（标题+歌手归一化）合并为 `GroupedTrack`，`candidates` **按
   `plugin.priority` 排序即优先级**，前端不二次排序；
2. **播放回退**：`playback.resolve` 依次尝试候选；全失败返回 `data: null`（不是错误）；
3. **健康标记**：单次失败标脏并后台重探，连续失败达阈值才禁用（避免网络抖动误杀）；
4. **合并的可见性**：合并会误合（live / 翻唱 / remix / 同名），因此 UI **必须**提供
   「候选列表 + 当前生效候选」与「分源视图」开关；合并结果同时保留每条的来源信息。

## 5. 插件 ABI（内嵌 QuickJS）

### 5.1 两种包形态

| 形态 | 适用 | 说明 |
|---|---|---|
| **单文件 `.js`（主推）** | 绝大多数插件 | 元数据写在**文件头注释**（前 60 行内解析），无清单文件。作者成本 = 一个文件 |
| **目录包** | 需要多文件/资源/构建产物 | `plugin.json`（同名字段）+ `entry` 指向主文件 + 可选 assets |

单文件头部元数据（沿用 Legado 社区约定并扩展）：

```js
// @name 示例音源
// @id example-source              // [a-z0-9-]{2,32}，与曲目 ref 前缀一致
// @version 1.0.0
// @author your-name
// @url https://example.com
// @description 一个最小可用的音源插件
// @tags 示例,流行
// @qualities hires,lossless,high,standard   // 由高到低
// @hosts api.example.com,cdn.example.com    // 网络白名单（仅 HTTPS）
// @credentials apiKey:API Key:required      // key:label[:required][:plain]
// @minCoreVersion 0.1.0
```

### 5.2 插件函数（顶层函数声明，无模块系统）

```js
async function search(keyword, page) {}            // 必选 → Track[]
async function getMediaSource(track, quality) {}   // 必选 → {url, headers?, quality?, mimeType?, expiresInSec?}
async function getTrackInfo(id) {}                 // 可选
async function getAlbumInfo(id) {}                 // 可选
async function getPlaylistInfo(id) {}              // 可选
async function getLyric(id) {}                     // 可选 → {format, content, translated?}
async function getTopLists() {}                    // 可选 → 分类树
async function getTopList(id, page) {}             // 可选
async function getRecommend() {}                   // 可选
```

- **能力探测**：函数不存在时，对应命令返回 `common.not_implemented`（UI 隐藏入口），
  而不是报错——社区插件能力参差是常态；
- **宿主注入**（白名单，无 `fs`/`process`/原生模块）：`fetch`（仅 `@hosts` 域名、仅 HTTPS）、
  `crypto`、`console`、插件私有 `storage`、`credentials.get(key)`；
- **限制**：单次调用超时（8s）、内存上限、调用频率；违规 → `plugin.permission_denied`，
  异常/超时 → `plugin.runtime_error` 并计入健康度；
- **运行时**：每个插件一个独立 QuickJS 实例；`reload` 重建。引擎通过内部 `JsRuntime` 接口封装，
  便于将来替换（见 ROADMAP 风险表）。

### 5.3 信任模型（社区资源 = 不可信代码）

- 安装必须 `plugin.preview` → 展示权限与凭据需求 → `plugin.import({consent:true})`；
- **绝不执行安装脚本**，只解析元数据 + 复制文件；
- 从 URL / 压缩包 / 订阅导入记录**来源与 sha256**；校验和不符必须显式告知用户；
- 不自动更新；订阅只刷新**索引**，更新要用户点。

## 6. 订阅与仓库索引

分发不依赖我们任何服务器：社区把插件仓库放在 GitHub / Gitee / 任意静态托管上，
客户端只认两类文件——`*.js` 与索引 `repository.json`（与 Legado 社区仓库规范同构并向后兼容）：

```json
{
  "name": "某社区音源仓库", "version": "1.0.0", "updatedAt": "2026-10-07T00:00:00Z",
  "url": "https://example.com/community-index",
  "sources": [{
    "name": "示例音源", "fileName": "example.js",
    "downloadUrl": "https://example.com/plugins/example.js",
    "version": "1.0.0", "author": "someone", "url": "https://example.com",
    "group": "示例", "logo": "", "description": "...", "tags": ["示例"],
    "enabled": true, "fileSize": 1234, "updatedAt": "2026-10-07T00:00:00Z",
    "sha256": "…",                      // 可选（我们扩展字段），有则校验
    "hosts": ["api.example.com"],       // 可选，便于安装前展示
    "qualities": ["high", "standard"]
  }]
}
```

- 索引字段**只增不改**（兼容既有客户端）；未知字段忽略；
- 用户也可只导入单个 `.js`（手动下载 / 分享文本），不强制订阅；
- 随仓库提供一个小工具，从 `plugins/*.js` 的头部注释生成 `repository.json`
  （对应 Legado 的 `prepare_public_repository.py`），并做发布前校验；
- **安装期展示**：来自订阅的插件在 `plugin.preview` 中展示 `hosts`/`permissions`/`credentials`
  与来源仓库，用户确认后才落盘。

### 中立立场（必须遵守，见 `docs/adr/0005-neutral-third-party.md`）

- **应用不内置任何第三方入口**：没有默认订阅列表、没有预置插件仓库、没有推荐位，
  首次打开订阅列表必然为空；
- **用户动作之前零外部请求**：启动、搜索、推荐、榜单都不会访问第三方地址；
  只有用户导入并启用插件、且该插件被调用时，才按清单 `@hosts` 白名单发起请求；
- **我们不托管、不镜像、不索引**第三方插件与皮肤；`repository.json` 只是格式约定；
- 示例与文档只用 `example.com` 占位；插件导入界面必须给出第三方免责声明。

## 7. 媒体传输（本地流代理）

**为什么必须有**：`<audio>` 在 WebView 里**无法设置请求头**（`Referer` / `User-Agent` / `Cookie`），
而真实音源大量依赖这些头才能取流；同时还需要 **Range**（拖动进度）、放宽 CORS、
必要时解密。本地文件播放同样受「WebView 读不到任意路径」限制。

**设计**：

- 核心启动一个**仅绑定回环地址**的临时 HTTP 服务（随机端口），只为媒体流服务；
- `playback.resolve` 返回 `ResolvedMedia`：
  ```ts
  interface ResolvedMedia {
      source: string;
      quality: TrackQuality;          // 实际下发档位（可能低于期望）
      /** 核心代理地址：http://127.0.0.1:<port>/m/<一次性 token> */
      streamUrl: string;
      /** 原始地址与请求头，仅用于展示/排障（前端不要直接用） */
      originUrl: string;
      headers?: Record<string, string>;
      mimeType?: string;
      expiresInSec: number;
  }
  ```
- 代理行为：转发 `Range` 与 `206`；注入源声明的头；`Cache-Control: no-store`；
  播放结束/切换即释放 token 与上游连接；
- **本地文件**同样经此通道播放（`streamUrl` 指向本地文件），替换前端现有的 Blob/`audio/mp4` hack；
- **SSRF 防护**：插件返回的媒体地址若指向回环 / 私有网段 / 链路本地地址，直接
  `media.blocked_address` 拒绝（媒体地址不受 `@hosts` 限制，因为它由上游 API 返回，
  所以必须在代理层拦截）；
- 代理只服务媒体：不提供通用转发（避免变成任意请求跳板）。

## 8. 皮肤模型

皮肤 = `ThemeSkin` JSON，可覆盖 `theme.config.json` 任意令牌组；导入导出即分享，
`ImportSource` 与插件同构。

- `skin.preview` 做结构 + **令牌键名白名单**校验：未知键名 → `skin.token_rejected` 并列出
  （修掉 v0.1 之前「静默忽略」的缺口）；
- 令牌**合并与 CSS 变量注入留在前端**（渲染管线）；核心只管校验、存储、导入导出。

## 9. 本机存储

```
<appData>/gently/
├── gently.db          SQLite：favorites / playlists / playlist_tracks / play_history /
│                      local_tracks(+FTS5) / plugin_state / plugin_config / download_tasks /
│                      skins / subscriptions / meta
├── plugins/<id>/      单文件插件与目录包统一落盘（含来源与 sha256 记录）
├── subscriptions/     订阅索引缓存（断网可用）
├── skins/  downloads/  cache/  logs/
```

访问层与并发模型见 `docs/adr/0004-local-storage.md`（rusqlite + 单写线程 + WAL + FTS5）。

## 10. 与 v0.1 的差异（变更记录）

| 变更 | 原因 |
|---|---|
| 插件 ABI 从 4 个函数扩到 9 个（增 `getTrackInfo/getAlbumInfo/getPlaylistInfo/getLyric/getTopLists/getTopList/getRecommend`） | v0.1 的 ABI 无法支撑 `catalog.album/playlist/lyrics` 等命令，那些命令本会永远无法实现 |
| 新增 `ResolvedMedia.headers` + 本地流代理（§7） | WebView 的 `<audio>` 不能设请求头；真实源几乎都需要；且需 Range |
| 新增订阅与仓库索引（§6） | 主流（Legado/MusicFree）靠「索引 + 单文件」一键分发；v0.1 的导入向导作者与用户成本过高 |
| 插件主形态改为**单文件 JS + 头部注释** | 作者成本从「建目录写清单」降到一个文件；社区仓库天然扁平可索引 |
| 搜索改为**流式**（`searchId` + 事件） | 社区插件质量参差，一个慢源不该拖死整页；合并仍在核心完成 |
| `catalog.charts` → `catalog.topLists` / `catalog.topList` | 真实源提供的是任意分类树，v0.1 的固定枚举映射不了 |
| 新增错误码：`plugin.invalid_source`、`subscription.*`、`media.proxy_failed`、`media.blocked_address` | 新能力需要可区分的失败语义 |
| 明确「前端 `src/plugins/**` 不是插件 ABI」 | 避免把 mock 兜底接口误当协议 |

## 11. 非功能性

- **无遥测**：不向任何服务器发送数据；错误只写本地日志。
- **性能预算**：搜索首屏（最快源）< 1s；单源搜索 P95 < 2s；插件调用超时 8s；
  本地 FTS5 检索 P95 < 50ms；扫描 1 万文件 < 10s。
- **兼容**：命令/字段只增不改；删除需先标 deprecated 一个版本。
- **凭据**：只存 OS keyring，SQLite 与日志中永不出现明文。
