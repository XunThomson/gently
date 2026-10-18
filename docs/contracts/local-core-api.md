---
status: active
last_verified: 2026-10-07
version: 0.2
owner: gently
scope: 本机核心能力契约（无服务器形态）
token_budget: 2600
tldr: 本机核心的 Tauri 命令与事件清单（63 条命令 + 8 类事件）。v0.2 相对 v0.1 补齐三处硬伤：插件 API 支持专辑/歌单/歌词/榜单（否则对应命令永远无法实现）、媒体地址携带 headers 并由核心提供本地流代理（WebView 的 audio 无法设请求头、需 Range）、分发改为「单文件 JS + 订阅源索引」为主。
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

### system（6）
| 命令 | 参数 | 返回 |
|---|---|---|
| `system.status` | — | `{version, platform, dbPath, dataDir, pluginRuntime, dbReady, dbError?, credentialsBackend, counts:{plugins,favorites,tracks,downloads}}`——`pluginRuntime` 在 M0 为 `none`、M1 接入 QuickJS 后为 `quickjs`；`dbReady:false` 表示降级运行（`dbError` 给出原因）；`credentialsBackend` 是凭据落点（`windows-credential-manager` / `memory`），界面据此说明「重启后是否还要重新填写」 |
| `system.paths` | — | `{data, cache, plugins, subscriptions, skins, downloads, logs}` |
| `system.reveal{path}` | 受管目录内的路径 | `null`；目录外或不存在 → `common.invalid_argument` / `common.not_found` |
| `system.cacheStatus` | — | `{mediaBytes, mediaCount, catalogBytes, catalogCount, coversBytes, coversCount, limitBytes}`：播放缓存 / 歌词与详情缓存 / 封面缓存的占用（设置页展示） |
| `system.cacheClear{kind?}` | `media` / `catalog`（歌词与详情）/ `covers` / `all`（缺省） | `{removedBytes, removedFiles}`；未知 kind → `common.invalid_argument`（缓存可随时整目录删除，见 §9） |
| `system.cacheConfig{limitBytes}` | 播放缓存总量上限（128 MiB ~ 32 GiB） | 更新后**立即按新上限淘汰一次**并返回最新 `cacheStatus`；越界 → `common.invalid_argument`（`details` 带 `min`/`max`）。设置存 `<data>/cache-settings.json`——**清缓存不会重置它**（读用 `cacheStatus`、写用 `cacheConfig`，读写分开） |

### plugin：管理（13）
| 命令 | 说明 |
|---|---|
| `plugin.list` | 已安装插件（权限、健康、来源、订阅归属） |
| `plugin.preview{from, compat?}` | 安装前展示清单、权限、凭据需求、warnings（**只读不写**）；`compat: true` 时对没有头部元数据的插件做**只读探测**并合成清单（见 §5.4） |
| `plugin.import{from, consent:true, compat?}` | 落盘安装（暂存 → 校验 → 原子替换）；`consent` 必须为字面量 `true`，否则 `common.invalid_argument`；返回 `{plugin, warnings, replaced}`；自有 ABI **不执行安装脚本**（兼容模式例外，见 §5.4）；记录来源与 sha256 |
| `plugin.list` | 已安装插件（含 `manifest` / `origin` / `priority` / `sha256`），按优先级 → 名称排序 |
| `plugin.remove{id, deleteFiles?}` | 卸载；`deleteFiles` 缺省 **true**（连文件一起删，避免孤儿目录） |
| `plugin.setEnabled{id, enabled}` / `plugin.setPriority{id, priority}` | 启停与回退顺序（priority 0~9999，越小越优先，缺省 100） |
| `plugin.reload{id}` | 重建运行时（改配置后） |
| `plugin.config.get{id}` / `plugin.config.put{id, values, revision}` | 插件配置，revision 冲突 → `common.conflict` |
| `plugin.credentials.set{id, key, value}` · `plugin.credentials.clear{id, key?}` · `plugin.credentials.status{id}` | 凭据只读写**清单声明过**的键（未声明 → `common.invalid_argument` 并列出可用键）；空值拒绝（清除用 `clear`）；`status` 回 `[{key, label, secret, present}]` 且**永不返回值**（命令层没有「读值」的出口，插件只能通过沙箱 `credentials.get` 只读访问）；落点是 `CredentialStore`：Windows 上直接用系统凭据库（`CredRead`/`CredWrite`/`CredDelete`/`CredEnumerate`，目标名 `gently:<pluginId>:<key>`，**重启后仍在**），系统凭据库不可用时降级为进程内存储，并在 `system.status` 的 `credentialsBackend` 字段里如实上报（界面据此提示重启后需要重新填写）；凭据**永不落库、永不进日志** |
| `plugin.config.get{id}` / `plugin.config.put{id, values, revision}` | 值存 SQLite（**不含凭据**）；`revision` 乐观并发：不匹配 → `common.conflict` 且 `details.current` 给出当前值（前端可直接重试），冲突**不改动已存值**；值必须是对象、上限 64 KiB；写入后卸载运行时（下次使用按新配置重建） |
| `plugin.checkUpdate{id}` | **只比对，不自动更新**。`url` 来源下载新版本比对版本与 sha256；`catalog` 来源比对**本地缓存的**订阅索引（刷新订阅是用户动作，索引没缓存 → `subscription.fetch_failed` 并提示先刷新）；`paste`/`file`/`dir` 无从比对 → `data: null`。返回 `{current, latest, changed, source}` |

### plugin：兼容模式收敛（2）
| 命令 | 说明 |
|---|---|
| `plugin.compat.observed{id}` | 兼容插件在兼容模式下**实际访问过**的域名（`{pluginId, compat, whitelist, hosts:[{host, count, firstSeen, lastSeen}]}`）：TOFU 收敛的唯一依据，来自沙箱放行时的观测台账（`plugins/.hosts/<id>.json`）。非兼容插件返回 `compat: false` + 空列表，不报错 |
| `plugin.compat.confirm{id, hosts, consent:true}` | 把观测到的域名固化成 `hosts` 白名单，**并关闭兼容模式**（兼容分支先于白名单，只写白名单不关兼容模式等于没写）；`hosts` 只能来自观测结果，非法或未观测到 → `common.invalid_argument`；返回更新后的 `PluginSummary`；运行时会被卸载，下次使用按新清单重新加载。**这是收窄动作，方向不可逆**（要恢复兼容模式只能重新导入） |

### plugin：订阅与仓库（5）
| 命令 | 说明 |
|---|---|
| `plugin.subscriptions.list` | 订阅源列表（名称、URL、更新时间、条目数） |
| `plugin.subscriptions.add{url, name?}` | 添加订阅（指向一个 `repository.json`） |
| `plugin.subscriptions.remove{id}` | 移除订阅（已安装插件不受影响） |
| `plugin.subscriptions.refresh{id}` | 重新拉取索引并本地缓存；失败保留旧索引并报 `subscription.fetch_failed` |
| `plugin.catalog.list{subscriptionId?, query?, tags?}` | 订阅内可安装条目（带 `installed` / `updateAvailable`） |

### auth：第三方授权（4）

**通用** OAuth 2.0 授权码 + PKCE：端点、client id、scope 全部来自**插件清单**的 `@oauth` 声明
（`docs/adr/0005-neutral-third-party.md`：应用不内置任何第三方地址）；核心只实现与厂商无关的那一段。

| 命令 | 说明 |
|---|---|
| `auth.status{pluginId}` | `{pluginId, declared, authorized, expiresAt, scopes, declaredScopes, pending, backend}`。**只有状态，没有任何令牌字段**——命令层没有「读令牌」的出口 |
| `auth.begin{pluginId}` | 绑定 `127.0.0.1` 的临时端口等回调，返回 `{pluginId, authorizeUrl, redirectUri, state, expiresAt}`；**授权页由前端交给系统浏览器**（应用内不嵌 WebView，用户能在地址栏确认真实域名）。未声明 `@oauth` → `common.invalid_argument`；插件未安装 → `common.not_found` |
| `auth.cancel{pluginId}` | 放弃正在等待的授权（关掉回调监听）；没有进行中的授权是空操作 |
| `auth.signOut{pluginId}` | 删除凭据库里的令牌（未授权时是幂等空操作） |

流程与约束：

- 回调路径 `http://127.0.0.1:<port>/callback`，**校验 `state`**（不匹配 → 400 页面且绝不换令牌）；
  等待上限 180s，超时/取消都会释放端口与线程；
- 换令牌是核心自己发起的 `POST application/x-www-form-urlencoded`（`grant_type=authorization_code`，
  PKCE 时带 `code_verifier`），端点域名必须已在 `@hosts` 白名单里、且只允许 HTTPS
  （**本机回环 `http://127.0.0.1` 例外**，只用于本地/测试）；
- 令牌只存进 `CredentialStore`（Windows 凭据管理器，目标名 `gently:<pluginId>:__oauth_token`），
  **永不落库、永不进日志**；过期且有 `refresh_token` 时在对插件取用的那一刻就地续期；
- 插件通过沙箱里的 `oauth.getAccessToken()` 取令牌（见 §5.2）；`credentials.get('__…')` 一律拒绝，
  保留键不给插件直接读；
- 换令牌失败按语义报码：400/401 或缺 `access_token` → `source.auth_expired`（界面提示重新授权），
  其它上游失败 → `source.upstream_failed`；
- 状态变化推 `auth:changed`（§3）。

### catalog（13）
| 命令 | 说明 |
|---|---|
| `catalog.search{keyword, sources?, limit?}` | **流式**：立即返回 `{searchId}`，结果通过事件分批到达（§3） |
| `catalog.searchCancel{searchId}` | 取消 fan-out（慢源不该拖住用户）。**取消不会让 `done` 不来**：已经开始的搜索仍会在有限时间内推出 `catalog:search:done`（可能为空结果），前端的 await 因此不会挂死；对**已结束/不存在**的 id 取消返回 `common.not_found`，调用方按 fire-and-forget 处理即可 |
| `catalog.track{ref}` | 曲目详情（`getTrackInfo`） |
| `catalog.album{source, id}` / `catalog.playlist{source, id}` | 专辑 / 歌单详情 |
| `catalog.topLists{source}` | 榜单与分类树（**源自定义分类**，不是固定 hot/new/rise） |
| `catalog.topList{source, id, page?}` | 某个榜单/分类的内容 |
| `catalog.recommend{source}` | 源侧推荐 |
| `catalog.favorites{source, page?, collectionId?}` | 源侧「我收藏的歌曲」（第 68 条命令）：源必须已启用且实现 `getFavorites`（缺能力 → `common.not_implemented`，界面据此隐藏入口；未安装/已禁用 → `common.not_found`）。返回 `{source, collectionId, items, hasMore, nextPage?}`，`hasMore` 来自插件的 `isEnd`（缺字段不猜「还有下一页」）。`collectionId` 是用户选中的收藏夹/歌单，核心把它作为 **`getFavorites` 的第二个参数**交给插件（不传 = 源自己的默认列表）。**不缓存**：收藏是用户自己的状态，随时会在别处变动。登录由插件自己负责（`@oauth` 令牌或清单声明的凭据），核心不掺和 |
| `catalog.loginQr{source}` | 源必须实现 `getLoginQr`（缺能力 → `common.not_implemented`）。返回 `{source, key, content, tip?}`：`content` 是**要画成二维码的字符串**（通常是登录 URL，由插件给——登录地址是具体第三方的，核心不掺和，ADR-0005）；`key` 用于后续轮询；缺 `content` → `plugin.runtime_error` |
| `catalog.loginQrPoll{source, key}` | 轮询一次登录状态：`{source, state}`，`state ∈ waiting / scanned / confirmed / expired`（插件给别的值一律按 `waiting`）。**只有 `confirmed` 落凭据**：插件须同时给出 `credentialKey` 与 `value`，且 `credentialKey` 必须是该插件**清单声明过的凭据键**（否则 `plugin.permission_denied`）；核心把会话写进凭据库后返回 `{source, state:'confirmed', credentialKey}`——**令牌永不回传前端** |
| `catalog.favoriteCollections{source}` | 源侧**可选的收藏夹/歌单**（第 69 条命令）：返回 `{source, items:[{id, title, count?}]}`。只有一份默认收藏的源**不实现** `getFavoriteCollections`——此时返回**空数组而不是错误**（界面据此隐藏选择器）。缺 `id` 的条目被丢弃；`count`/`mediaCount` 归一化成 `count`。**不缓存**（收藏夹名字与数量随时会变） |
| `catalog.loginWeb{source}` | **浏览器窗口登录**的计划（第 73 条命令）：源必须在清单里声明 `@login`（否则 `common.not_implemented`）。返回 `{source, title, url, cookieNames, credentialKey}`——`url` 是**要打开的登录页**、`cookieNames` 是从 webview Cookie 罐里要取的字段、`credentialKey` 是会话写进哪个凭据键。**核心只出计划、不开窗口**：读 webview 的 Cookie 属于宿主能力，由桌面层的 `web_login` 命令完成（见 §2 末尾「桌面层命令」）。地址一律来自清单，核心不内置任何第三方地址（ADR-0005） |
| `catalog.lyrics{ref, withTranslation?}` | 歌词；无词返回 `data: null`。返回 `{format:'lrc'\|'plain', content, translated?}`——**只交原文**，解析成行（含译文按时间戳对齐）是纯展示问题，由前端唯一一份 `src/utils/lyrics.ts` 完成 |
| `catalog.lyricsSearch{query, limit?}` | **按关键词跨源找歌词**（歌词与歌曲分离时的兜底入口）：每个已启用且同时有 `search`+`getLyric` 的源各起一个线程，先 `search` 再取前 `limit`（1~5，缺省 2）个条目问歌词；没词的条目跳过，单源失败不影响其它源。返回 `{items, searchedSources, failedSources, skippedSources, timedOutSources}`：`items[]` 为 `{source, sourceName, track, lyrics}`；整体最多等 12s，`timedOutSources` 里的源**不阻塞已拿到的结果**。歌词按 `lyrics:<source>:<rawId>:false` 缓存（与 `catalog.lyrics` 同键） |

> 说明：v0.1 的 charts 命令（固定 hot/new/rise 枚举）已被 `topLists` / `topList` 取代——
> 真实源提供的是任意分类树，固定枚举映射不了。**排行榜页需要按源的分类树渲染**（前端改动）。
> 变更明细见 §10。

### library（11）
`library.favorites.list{limit?,cursor?}` · `library.favorites.set{ref, favorite, track?}` ·
`library.playlists.list` · `library.playlists.save{id?, name, trackRefs, tracks?}` · `library.playlists.delete{id}` ·
`library.history.list{limit?,cursor?}` · `library.history.push{ref, playedSec, completed, track?}` · `library.history.clear` ·
`library.local.scan{dirs, recursive?}` · `library.local.list{limit?,cursor?}` · `library.local.remove{id, deleteFile?}`

**本机库语义**（M3a 已实现前 7 条）：

- **引用**：`ref` 统一为 `source:trackId`，参数接受字符串或 `TrackRef` 对象（`{id, source, sourceTrackId}`），
  两种写法归一化成同一个引用；格式非法 → `common.invalid_argument`（不允许存下永远对不上的行）；
- **曲目快照**：库里存的是**快照**（JSON 列），因为插件可能被卸载或改接口——列歌单不该依赖插件在线。
  快照来源：调用方带来的 `track` 参数（界面手上有）；**缺了就退化成占位曲目**（标题 = rawId），
  下次带快照写入时刷新（`favorites.set` 是幂等 upsert）。核心**不为了补标题去调插件**：写入路径不依赖网络；
  - **快照里的本地封面地址在下发时重新签发**：快照会记住当时的 `artwork`，而回环端口**每次启动都会变**
    （§7），把旧端口的地址原样发下去，界面只会拿到一张加载失败的图。本地封面的名字由**路径**派生，
    因此 `favorites.list` / `history.list` / `playlists.list`（含 `playlists.save` 的返回）在下发前
    按路径重新签发当前地址；封面确实没了就删掉该字段（界面退回渐变，而不是显示破图）；
- **收藏**：按 `ref` 去重，重复收藏只更新快照；取消收藏幂等；
- **历史**：**每次播放留一行**（用于统计与「最近播放」），`playCount` 是该 ref 的累计次数；
- **歌单**：`save` 无 `id` 为新建（id 由核心生成 `pl-<hex>`）、有 `id` 为**整体覆盖**（曲目顺序 = `trackRefs` 顺序，
  重复引用只留一次）；`delete` 级联删除曲目行，删不存在的歌单 → `common.not_found`；
- **分页**：`(时间戳, 主键)` 复合游标倒序，`nextCursor` 对调用方不透明（原样回传）；`limit` 夹到 1~500（缺省 50），
  `total` 是总数（不受分页影响）；数据库不可用 → `library.io_error`（不假装成功）。

**本地曲库语义**（M3b 已实现 `local.*` 三条）：

- **id 由路径派生**（`local:<规范化路径>`）：同一文件重复扫描命中同一行；`source` 恒为 `local`。
  规范化 = `\` → `/` + **折叠重复分隔符** + 去掉末尾分隔符（`paths::normalize_source_path`，
  曲目 id / 库里的 `path` 列 / 封面文件名 / 扫描范围比较四处共用同一份实现）——
  Windows 接受 `C:\\Music` 这种写法，不归一就会把同一个文件收成两行（打包版实测撞到过）；
- **扫描**：只认音频扩展名（mp3/flac/m4a/m4b/m4r/m4s/mp4/aac/ogg/oga/opus/wav），其余文件连开都不开
  （`m4s` 等 ISO-MP4 副扩展名与 `m4a` 同容器，B 站下载的音频就是 `.m4s`——R53 实测漏了它会让
  「目录里只有 .m4s」看起来像扫描坏了）；
  - **快速重扫**：文件大小没变就跳过读标签（`skipped`）——重复扫描 1 万文件才够快；
  - 读不到标签的文件**照样入库**（标题退回文件名，计入 `unreadable`），不因个别坏文件漏歌；
  - 不是音频扩展名的文件计入 `ignored`：`scanned=0` 与「目录是空的」必须能分辨
    （界面文案里如实显示「非音频文件 N」）；
  - **清理只针对本次范围内的路径**：递归 = 目录前缀（带分隔符比较），非递归 = 只直接位于该目录下的文件
    ——扫 A 目录不会删掉 B 目录的曲目，非递归扫描也不会误删子目录；
  - 元数据用 symphonia 读容器标签与时长（ROADMAP 原写 `lofty`，但它不在本机 registry 缓存里，
    离线构建不可得；symphonia 已缓存且覆盖同样格式）；
  - **标签有两个来源，必须都读**：探测阶段的**链式元数据**（`ProbeResult.metadata`）与容器自己的
    `format.metadata()`。symphonia 0.5.5 的 mp3 demuxer **不解析 ID3v2**——mp3 的标题/歌手/专辑/封面
    只出现在链式元数据里（容器那份是空的），只读后者会让最常见的 mp3 丢掉全部标签与内嵌封面；
  - **内嵌封面**：文件里的图片（`Visual`）在扫描时落进 `<data>/cache/covers/<hash>.<ext>`，文件名 =
    源路径 SHA-256 前 16 字节（分隔符先归一成 `/`，否则扫描侧与列表侧算不出同一个名字）+ 由 `media_type`
    推出的图片扩展名；`list` 因此**不必回查数据库**就能判断封面在不在，命中时给一项 `artwork` =
    回环地址（见 §7），没有就是缺字段（前端退回渐变）。同一路径重复扫描不写第二份，曲目移出曲库时删除。
    只缓存图片扩展名白名单内、单张 ≤ 2 MiB 的图（超限/未知类型只是「没有封面」，不影响入库）；
  - **测试覆盖（两条路径都有夹具）**：合并逻辑的两半各由一种格式钉住——
    `core/tests/local_library.rs` 里有一个**手写的 ID3v2.4 mp3**（TIT2/TPE1/TALB + APIC，
    走**链式**元数据）和一个**手写的 FLAC**（STREAMINFO + VORBIS_COMMENT + PICTURE + 一个
    CONSTANT 静音帧，走**容器**元数据；FLAC 读取器要求至少一个合法音频帧才肯构造，
    帧头 CRC-8 与帧尾 CRC-16 都是夹具里算的）。两者都端到端断言「扫描提取 → 落缓存 →
    列表给回环地址 → 代理按字节回放 → 目录穿越/非法名 404 → 移除曲目后清理」。
    **未做夹具的格式**：`.m4a/.mp4`（symphonia 的 isomp4 **确实**支持 `ilst/covr` → Visual，
    与容器元数据同一条路）与 `.ogg/.opus`（Vorbis comment 里的 `METADATA_BLOCK_PICTURE`）
    都走容器元数据这条路，逻辑与 FLAC 相同、但没有各自的夹具——造一个合法 MP4/Ogg 容器
    的成本高于收益，如实记在契约 §10；
  - 返回值 `{scanned, added, updated, removed, skipped, unreadable}`；进度经 `library:scan:progress{dir, found, percent}`
    （先数一遍音频文件拿总数，进度才是真的）；
- **检索**：`local.list{query?}` 走 FTS5（`trigram` 词元化，支持中英文子串）；**1~2 个字符的查询退回 LIKE**
  （trigram 至少要 3 个字符才有词元），两条路径对调用方透明；用户输入的 `%`/`_` 不当通配；
- **移除**：`local.remove{id, deleteFile?}` 缺省**只移出曲库**（不删磁盘文件，重扫会再收进来）；
  `deleteFile: true` 才真的删文件，且只接受音频扩展名的路径（库里的一行被改坏也不至于删掉任意文件），
  文件已不存在不算失败；**界面必须走二次确认**。

### recommend（3）
`recommend.home{limit?}` · `recommend.similar{seed, limit?}` · `recommend.feedback{ref, action, progress?, track?}`

**推荐语义**（M4a 已实现三条）：

- **候选只来自本机数据**：本地曲库 / 收藏 / 播放历史 / 自建歌单。
  `recommend.home` **不向任何插件发起请求**——ADR-0005 把「推荐」列进「用户动作之前零外部请求」；
  源侧推荐另有显式入口 `catalog.recommend{source}`（用户点某个源才调用它）；
- **画像**（与旧前端实现同一套行为）：`权重 = (1 + log2(1 + 播放次数)) × 0.5^(距现在 / 12h)`，
  收藏固定 `2.5`，歌手权重额外乘 `1.6`；样本量 = 参与统计的播放条目数 + 收藏数；
- **打分**：`Σ 命中标签权重 + 歌手权重`；**理由**：歌手命中优先（且不低于标签命中），
  其次标签，最后回落「近期热门」（有样本 `0.3` / 无样本 `0.4`）；强度 = `min(1, round(v/max×100)/100)`，
  `max` 取 `max(0, 最大权重)`（负权重不会把强度算歪）；
- **排除最近听过**：`home` 的候选会剔除最近播放过的引用，避免「推荐你刚听过的」；
- **三类结果**：单曲（候选池）· 专辑（把候选池按专辑名聚合的**本机虚拟专辑**，id 形如
  `local-album:<专辑名>`，带曲目）· 歌单（用户自建歌单）；
- **`similar{seed}`**：种子可以是 `TrackRef` 或 `{albumId}`；从本机库找共享标签/同歌手的曲目，
  理由 `kind: 'similar'`；种子不在本机库里 → `common.not_found`；
- **反馈**（append-only 落库，下次打分时消费）：`like` = 一次收藏权重、`unlike` 反向；
  `skip`（进度 < 0.5）扣 `1.0` 并按半衰期衰减；`complete`（进度 ≥ 0.9）加 `1.0` 并衰减；
  `play` 不额外加权（历史里已经有它）。`action` 与 `progress` 都会校验，非法 → `common.invalid_argument`；
  反馈需要曲目快照（标签/歌手是打分的依据）：优先用调用方给的 `track`，否则从本机库（收藏 → 历史 → 本地曲库）反查。

### playback（2）
`playback.resolve{ref, quality, preferredSources?}` → `ResolvedMedia | null`（含 headers 与 `streamUrl`，见 §7）
`playback.report{ref, source, quality, playedSec, completed, track?}`

> 参数名约定：**引用一律叫 `ref`**。`playback.resolve` 早期实现只认 `reference`，现在两者都接受
> （`alias`），但对外只有一个名字——参数名不一致的代价是调用方收到「缺字段」而不是「名字不对」。

**播放语义**（M3c 已实现的补充）：

- **本地曲目（`source === 'local'`）不经插件**：`playback.resolve` 直接把文件发布到**同一条回环代理**，
  前端因此只有一条播放路径（Range/拖动进度、无需 Blob hack）。`ref` 里的 `trackId` 就是文件路径
  （`local:C:/Music/a.flac`，`split_once(':')` 只切第一个冒号，路径里的冒号不受影响）；
- 本地代理只接受**音频扩展名**且文件必须存在（白名单与扫描共用一份实现）；文件被删/被移走时
  该候选不可播 → 继续回退，全失败仍是 `data: null`；
- **缓存优先（R56）**：远端候选在调用插件**之前**先查 `<data>/cache/media/`；命中直接走同一条回环代理
  并返回 `fromCache: true`（断网、或插件被停用/卸载时，已缓存的那首仍能播）；未命中且解析成功时，
  在后台补全缓存（只缓存**播放过的**，见 §9.1）；
- 本地响应带 `Accept-Ranges: bytes` / `Cache-Control: no-store` / 按扩展名的 `Content-Type`；
  `Range` 支持 `bytes=start-end`、`bytes=start-`、`bytes=-suffix`（单区间；多区间或越界 → `416`），
  命中时回 `206` + `Content-Range`；响应头**不出现文件路径**（代理不是目录浏览器）；
- `playback.report` 写的就是播放历史（与 `library.history.push` **同一份实现**），
  `source` 是**实际播成的**音源（候选回退后可能与 `ref` 里的不同）；`quality` 暂不落库
  （`RecentTrack` 没有这一列，记了没人消费）。

### download（6）
`download.list{status?}` · `download.create{ref, quality?, dir?, track?}` · `download.pause{id}` · `download.resume{id}` ·
`download.remove{id, deleteFile?}` · `download.clearFinished` → `{removed}`

**下载语义**（M3d 已实现六条）：

- **建任务立刻返回**（状态 `pending`），真实下载在后台线程；进度经 `download:progress{id, received, total?, speed?}`
  （每 512 KiB 或 500ms 一次），完成 / 失败分别发 `download:done{id, path, bytes}` / `download:error{id, code, message}`；
- **任务与文件分离**：记录在库（含曲目快照，插件被卸载也能列），文件落在 `<data>/downloads`（`dir` 可指定，必须是已存在目录）；
  **先写 `<file>.part`，完成后 rename**——下载目录里不该出现「看着完整其实是半截」的文件；
- 文件名来自曲目（`歌手 - 标题.<ext>`，非法字符替换、去掉首尾点与空格）；扩展名先按曲目/引用猜，
  **解析出真实媒体地址后按地址改写**（代理按扩展名给 `Content-Type`，猜错会让回放失败），并把新路径写回库；
- **暂停**停在下一次分块回调处（进度落库，半成品保留）；**续传**带 `Range: bytes=<已收>-`；
  上游**忽略 Range（回 200）时从头写**——绝不能把完整响应追加到半截文件后面（有测试锁定）；
  `remove` 置取消位（线程退出、删半成品），**不动库记录**（命令自己删）；`remove{deleteFile:true}` 才删已完成文件；
- 本地曲目（`local:`）不需要下载 → `common.invalid_argument`；下载地址与播放共用同一套
  「公网 HTTPS、不得指向本机/内网」校验（`plugin::transport::require_public_https`）。

### skin（6）
`skin.list` · `skin.preview{from}` · `skin.install{from}` · `skin.remove{id}` ·
`skin.setActive{id|null}` · `skin.export{id, format?:'json'|'file'}`

**界面入口**（主题市场）：
- 浏览 / 搜索 / 标签筛选 / 应用 / 删除（删除走二次确认）；
- **导入**：面板里的三条来源——**粘贴 JSON**（`{kind:'paste'}`）、**粘贴本机路径**（`{kind:'file'}`）、
  以及原生文件选择器（同样落到 `paste`）。前两条与插件页同一套做法：桌面端没有 Tauri 的 dialog 插件，
  只靠原生选择器会留下一条在受控环境里走不通的路（R49 实测：选择器点得开、按钮驱动不了），
  核心侧收的本来就是同一个 `ImportSource`，所以只是同一能力的三种入口；
- **导出**当前皮肤为 JSON（内置预设直接前端序列化，只有用户皮肤才取核心原文，见 §11）；
- 校验与落盘**全部在核心**（结构 + 令牌键名白名单），被拒的键名逐条回给界面。

### 桌面层命令（不经 `core_invoke`）

Tauri 适配层另外注册了一条命令：它需要**宿主能力**（读 webview 的 Cookie 罐），而核心不依赖 Tauri。

| 命令 | 说明 |
|---|---|
| `web_login{source}` | 按 `catalog.loginWeb` 给出的计划打开登录页窗口，轮询**这个窗口**的 Cookie 罐；`cookieNames` 全部到齐后调 `plugin.credentials.set` 落库，返回 `{ok, data:{source, state, credentialKey?}}`，`state ∈ confirmed / canceled`（关窗或 300s 超时都算 canceled，**凭据不动**）。会话值**不经过前端**。注册在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里，前端只经 `services/core.bridge.ts` 的 `coreWebLogin` 调它 |

### 导入来源（插件与皮肤共用）
```tstype ImportSource =
    | {kind:'file';      path: string}        // 单文件 .js（插件）或 .json（皮肤）
    | {kind:'dir';       path: string}        // 目录包：plugin.json + entry
    | {kind:'archive';   path: string}        // zip（**插件已实现**：stored + deflate；解压后按目录包/单文件归一化）
    | {kind:'url';       url: string}         // 远程文件或压缩包
    | {kind:'paste';     content: string}     // 粘贴的源文件/清单文本
    | {kind:'catalog';   subscriptionId: string; fileName: string};  // 从订阅一键安装

/** 已安装插件的来源（`paste` 没有可展示的路径，只靠 sha256 识别内容变化） */
type PluginOrigin =
    | {kind:'file'|'dir'|'archive'; path: string}
    | {kind:'url'; url: string}
    | {kind:'catalog'; subscriptionId: string}
    | {kind:'paste'};
```

**压缩包是唯一需要防「解压攻击」的来源**，所以它的限制写死在契约里：条目数 ≤ 512、
解压后总大小 ≤ 8 MiB（与插件体积上限一致）、拒绝对路径穿越（`..`/绝对路径）与符号链接、
包内只认「根下有 `plugin.json`」或「根下恰好一个 `.js`」两种形态（多套一层目录会被拍平）。
不满足时返回 `plugin.invalid_source` 并在 `details` 里说明原因（多入口会列出候选）。

## 3. 事件清单（8）

| 事件 | 载荷 | 用途 |
|---|---|---|
| `catalog:search:partial` | `{searchId, source, tracks[], failed?: CoreError}` | 逐源到达；用于流式 UI 与「分源视图」 |
| `catalog:search:done` | `{searchId, items: GroupedTrack[], sources[], failedSources[]}` | 最终聚合结果（含候选合并） |
| `download:progress` | `{id, received, total?, speed?}` | 下载进度（节流：512 KiB 或 500ms） |
| `download:done` | `{id, path, bytes}` | 下载完成（文件已从 `.part` rename 到位） |
| `download:error` | `{id, code, message}` | 下载失败（任务状态置 `error`） |
| `plugin:health` | `PluginInfo` | 标记源不可用并触发回退 |
| `plugin:import:progress` | `{phase, percent?}` | 导入进度 |
| `library:scan:progress` | `{dir, found, percent?}` | 扫描进度 |
| `auth:changed` | `{pluginId, authorized, expiresAt?}` | 第三方授权状态变化（回调线程换到令牌 / 取消 / 换令牌失败）；界面据此刷新「已授权」，不必轮询 |

搜索流程：`invoke('catalog.search')` → 立刻拿到 `searchId` → 前端订阅事件增量渲染 →
`catalog:search:done` 收敛出「跨源合并后的候选列表」。合并始终在核心完成（单一职责）。

**事件名一律用冒号分段，不用点号**：事件要经 Tauri 的事件系统送到前端，而 Tauri 的
事件名校验只接受字母数字与 `-` `/` `:` `_`（`tauri::event::EventName::new`）——
带点号的名字 `emit` 会直接报错，**事件整条丢失**（命令返回值照常，因此极难发现：
表现为流式搜索只能等超时、下载进度永远不动）。契约名即传输名，不设第二套映射；
`core/src/events.rs` 的单测与 `scripts/check-commands.mjs` 都会校验这一点。

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
// @compat                    // 兼容模式：来自 MusicFree/LX 生态、不声明 @hosts（见 §5.4）
// @oauth authorize=https://id.example.com/authorize,token=https://id.example.com/token,client=demo,scopes=fav
                             // 第三方授权（可选）：端点由作者提供，域名必须在 @hosts 里；
                             // 参数用逗号分隔，值里不能有逗号；可选 port=<n>（0 = 随机回环端口）、pkce / nopkce
// @login url=https://example.com/login,cookies=SESSION_ID,key=apiKey
                             // 浏览器窗口登录（可选）：打开站点自己的登录页，登录完成后从
                             // **webview 的 Cookie 罐**里取 cookies=（多个用 + 连接）拼成会话，
                             // 写进 key=（必须是本清单 @credentials 里声明过的键）。
                             // url 必须 HTTPS 且域名在 @hosts 内（本机回环 http 例外）。
                             // 与 @oauth 的区别：不用站点接口、不碰第三方登录风控，
                             // 等价于「在浏览器里登录后复制 Cookie」，但全自动。见 §2 桌面层命令。
```

目录包的 `plugin.json` 里同一份声明写成对象（字段与上面一一对应）：

```json
"oauth": {"authorizeUrl": "https://id.example.com/authorize", "tokenUrl": "https://id.example.com/token",
          "clientId": "demo", "scopes": ["fav"], "pkce": true, "redirectPort": 0},
"webLogin": {"url": "https://example.com/login", "cookieNames": ["SESSION_ID"], "credentialKey": "apiKey"}
```

声明 `@oauth` 会**自动补上** `network` + `credentials` 权限（流程要出网、令牌进凭据库）；
没有声明就没有授权入口——应用不会凭空提供任何第三方登录。

### 5.2 插件函数（顶层函数声明；自有 ABI 不需要模块系统）

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
async function getFavorites(page, collectionId) {} // 可选 → 源侧收藏夹（需要登录；`catalog.favorites` 调它）
async function getFavoriteCollections() {}         // 可选 → 可选收藏夹/歌单 [{id, title, count?}]
async function getLoginQr() {}                     // 可选 → 二维码登录会话 {key, content, tip?}（会话由核心落凭据）
async function pollLoginQr(key) {}                 // 可选 → 登录状态 {state, credentialKey?, value?}（value 只在 confirmed 时给，核心收到后立即落库、不回传）
```

- **`getFavorites(page, collectionId)`**：返回 `Track[]` 或 `{isEnd, data}`；`isEnd: false` 表示还有下一页。
  `collectionId` 只在用户选了一个收藏夹/歌单时才有（来自 `getFavoriteCollections`）；
  **只实现一份默认收藏的插件忽略第二个参数即可**。
- **`getFavoriteCollections()`**：返回 `[{id, title, count?}]`。第三方结构差异很大（视频站是「收藏夹/媒体列表」、
  音乐站是「自建歌单」），但应用侧只认这两个字段，**每家自己的取法留在插件里**——这就是
  「对不同第三方提供不同策略」的落点；不实现 = 该源只有一份默认收藏。
  登录态由插件自己取（`@oauth` 插件用沙箱 `oauth.getAccessToken()`，cookie 类插件用清单声明的凭据），
  核心**不参与**具体源的鉴权；拿不到登录态时返回空数组即可（应用侧没有「已登录」的概念）。

- **`getMediaSource` 的第一个参数是「曲目快照对象」，不是字符串 id**：核心优先把**前端手上的那份 Track**
  传进去（`{id, source, title, artist, …}` 都有），只有前端没给快照时才退化成 `{id, source}` 的最小对象；
  第二个参数是期望音质。**`track.id` 才是源内的原始 id**。
  插件里写成 `(id, quality)` 再拼 `id` 会得到 `[object Object]`（R44 实测：URL 变成 `probe-[object Object].mp3`，
  只有翻日志才看得出来）。`getTrackInfo/getLyric/…` 才是收**字符串 id**。

- **能力探测**：函数不存在时，对应命令返回 `common.not_implemented`（UI 隐藏入口），
  而不是报错——社区插件能力参差是常态；
- **宿主注入**（白名单，无 `fs`/`process`/原生模块）：`fetch`（仅 `@hosts` 域名、仅 HTTPS）、
  `console`、插件私有 `storage`、`credentials.get(key)`、`oauth.getAccessToken()`；
  CommonJS 插件另有 `module` / `exports` / `require`（见 §5.4，仅兼容模式 + 固定模块清单）；
- **`oauth.getAccessToken()`**：只在清单声明了 `@oauth` 时返回令牌（否则 `undefined`）；过期会在
  取用时自动用 `refresh_token` 续期，续不上就返回 `undefined`——插件必须按「未登录」处理，
  不要假设它一直存在，也不要把它写进 `storage`。`credentials.get('__…')` 一律返回 `undefined`：
  `__` 前缀是宿主保留键（令牌就存在那里）；
- **限制**：单次调用超时（8s）、内存上限、调用频率；违规 → `plugin.permission_denied`，
  异常/超时 → `plugin.runtime_error` 并计入健康度；
- **运行时**：每个插件一个独立 QuickJS 实例；`reload` 重建。引擎通过内部 `JsRuntime` 接口封装，
  便于将来替换（见 ROADMAP 风险表）。
- **尚未提供**：摘要算法目前只经 §5.4 的 `crypto-js` 垫片（MD5 / SHA256）暴露给兼容插件，
  自有 ABI 侧还没有原生 `crypto` 入口——需要签名的自有插件先按兼容插件写，或等它落地。

### 5.3 信任模型（社区资源 = 不可信代码）

- 安装必须 `plugin.preview` → 展示权限与凭据需求 → `plugin.import({consent:true})`；
- **自有 ABI 绝不执行安装脚本**，只解析元数据 + 复制文件；唯一的例外是用户显式开启的
  **兼容模式**（§5.4）：没有头部元数据时在**无出网通道**的沙箱里只读执行一次源码，用于合成清单；
- 从 URL / 压缩包 / 订阅导入记录**来源与 sha256**；校验和不符必须显式告知用户；
- 不自动更新；订阅只刷新**索引**，更新要用户点。

### 5.4 兼容模式：CommonJS、固定模块清单与导入接线（ADR-0006）

兼容模式**默认关闭**，两条入口：头部 `@compat`（作者声明）或导入参数 `compat: true`
（用户显式开启——MusicFree / LX 生态的插件没有头部，只能走这条）：

- **权限边界**：允许任意**公网 HTTPS** 域名；**本机 / 回环 / 链路本地 / 私有网段在任何模式下都拒绝**；
  实际访问的域名记入日志，作为后续「固化为白名单」的依据；
- **头部不全时合成清单**（`plugin.preview` / `plugin.import` 都带 `compat`，两侧口径必须一致，
  因为安装会从暂存副本重新解析）：
  - 元数据来自**只读探测**的 `module.exports`（`platform`/`version`/`author`/`description`/`srcUrl`）；
    探测期 `hosts` 为空、无出网通道——顶层就发请求的插件会明确报「探测期不能出网」；
  - `id` = `compat-<sha256(platform) 前 8 位>`：同一插件升级后 id 不变（否则升级会变成新装一个）；
    没有 `platform` 时退化为内容摘要并警告「更新会被视为另一个插件」；
  - `version` 非语义化版本按 `0.0.0` 记录并警告；`author` 缺失记「未声明」；
  - 权限恒含 `network`、`hosts` 为空；能力以**运行时探测**为准；
- **模块清单是固定的**（不做任意模块解析，清单外一律抛可执行错误并列出可用项）：

  | 模块 | 覆盖 | 说明 |
  |---|---|---|
  | `he` | `decode` / `encode` | HTML 实体 |
  | `axios` | `params` / `headers` / `data` / `validateStatus` / 请求与响应拦截器 | 全部转宿主 `fetch`，返回 `{data, status, statusText, headers, config}` |
  | `dayjs` | 解析 / `format` / `add`·`subtract` / `startOf`·`endOf` / `diff` / 比较 | 默认英文本地化；`extend` 与 `dayjs/plugin/*` 显式报错 |
  | `crypto-js` | `MD5` / `SHA256` + `WordArray` + `Hex`·`Base64`·`Utf8`·`Latin1` | 摘要由宿主（sha2 / md-5）计算；AES / SHA1 / Hmac* 等显式报错 |

- **沙箱全局**（兼容插件依赖的另外几样，形状照抄 MusicFree）：

  | 全局 | 形状 | 说明 |
  |---|---|---|
  | `env.getUserVariables()` / `env.userVariables` | `Record<string, string>` | 用户在插件页填的变量（= 我们的凭据）；**只回清单声明过的键**，没填过就是空对象而不是 `undefined` |
  | `env.os` / `env.appVersion` / `env.lang` | string | 如实报告当前桌面平台（**不假装成 `android`**）；语言固定 `zh-CN` |
  | `process` | `{platform, version, env}` | 有的插件读 `process.env`，指向同一个 `env` |
  | `module.exports.userVariables` | `[{key, label?, required?, secret?}]` | 变量**声明**：合成清单时转成凭据字段，并自动补上 `credentials` 权限 |

- **垫片不新增能力**：`require` 只是形状翻译，出网仍走宿主通道，白名单、域名策略与 SSRF 防线照旧生效；
  `env.getUserVariables()` 与 `credentials.get` 走**同一道权限门**（无 `credentials` 权限时返回空对象）。
- **兼容适配（三处，都是实测踩到后补的，前两处见 STATE R17、第三处见 R53）**：
  - `require(x).default === require(x)`：转译后的插件普遍写 `axios_1.default.get(...)`
    （TS `esModuleInterop` 产物），MusicFree 也是这么给的（`pkg.default = pkg`）；
  - **函数名别名**：MusicFree 用 `getMusicInfo` / `getMusicSheetInfo` / `getTopListDetail`，
    分别映射到我们的 `getTrackInfo` / `getPlaylistInfo` / `getTopList`（自有 ABI 名优先）；
    `getRecommend` 在 MusicFree 侧是「tag → 歌单」两级，没有对等物，**不映射**（宁可不认也不瞎接）。
- **参数形状适配（R53 实测补的第三处）**：MusicFree 的详情类函数收**条目对象**
  （`getMusicInfo(musicItem)` / `getAlbumInfo(albumItem)` / `getMusicSheetInfo(sheetItem, page)` /
  `getTopListDetail(topListItem, page)` / `getLyric(musicItem)`），我们这边只有 `source:rawId`。
  两层配合，**自有 ABI 仍然只收字符串 id**：
  - 核心侧：归一化时把插件**原始条目**按 `source:rawId` 记进**进程内**快照（LRU，不落盘、不上报），
    详情命令与 `playback.resolve` 对**兼容插件**把这份条目原样交回；没有快照（重启后直接深链进来）
    时退化成 `{id}`；
  - 沙箱侧：别名函数（以及兼容模式下的 `getAlbumInfo`）把字符串 `id` 包成 `{id}`。
  两个实测症状：真实 B 站插件（MusicFree 生态）`getTopListDetail(topListItem)` 拿到字符串 →
  URL 拼成 `.../x/web-interface/undefined` → 上游 404；`getMediaSource(musicItem)` 拿不到
  `bvid`/`aid`/`cid` → 拼出 undefined → `plugin.runtime_error`（「能搜、能看榜单，一播就挂」）。
- **返回形状也做适配**（兼容插件不可能改）：列表接受裸数组 / `{items}`（自有 ABI）、
  `{isEnd?, data}`（搜索、歌手作品、推荐歌单、评论）、`{isEnd?, musicList}`（专辑、歌单、排行榜详情）；
  未在协议里出现的键名（`list` / `result` 等）不猜，形状不认识就丢弃并计数。
  条目字段按协议放宽：MusicFree 的 `duration` 是**数字秒**，与自有 ABI 的 `durationSec` / `"3:05"` 并存；
  **封面字段名不统一**（`artwork` / `cover` / `coverImg` / `pic` / `img` / `image`），核心取第一个非空值放进
  统一的 `artwork`（为空串时前端退回 `gradient` 占位）；
  **`isEnd` 目前不参与分页**（M2 的搜索只取第一页），分页落地时从同一处读取；
- **导入时不需要域名声明，但可以事后收敛**（TOFU，`plugin.compat.observed` / `plugin.compat.confirm`）：
  沙箱放行兼容请求时把域名记进观测台账（`plugins/.hosts/<id>.json`，卸载即清）；
  用户确认后把观测到的域名固化成 `hosts` 白名单并**关掉兼容模式**，插件从此回到声明式白名单的严格模型。
  白名单只能来自观测结果（不能凭空写），且必须 `consent: true`；
- **界面必须明示代价**：`PluginImportPreview.compat` / `PluginSummary.compat` 是给界面的标记，
  预览与已安装列表都要提示「可访问任意公网域名，权限弱于自有 ABI」，
  并沿用既有的显式同意闸门（`consent: true`）。

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
- **`Content-Type` 由代理决定**：上游给 `application/octet-stream`（或缺失）时按地址扩展名补一个
  音频类型（`.m4s` → `audio/mp4`），上游给出具体类型时照抄；因此 `<audio>` 的 `src` 永远是代理 URL，
  前端**不需要**任何「抓成 Blob 再强制 `audio/mp4`」的 hack（R11 已删除）；
- **本地文件**同样经此通道播放（`streamUrl` 指向本地文件，按扩展名给 MIME）；
- **封面同代理**：本地曲目的内嵌封面缓存（§4）由同一条回环服务上的 `/cover/<name>` 路由按字节回放，
  地址形如 `http://127.0.0.1:<port>/cover/<32 位十六进制>.<ext>`。该路由**不发出任何一次性 token**
  （图片是公开的本地数据，且前端只会拿到核心自己给的地址），但**只**取封面缓存目录里名字合规的文件
  （`^[0-9a-f]{32}\.(png|jpg|jpeg|webp|gif|bmp)$`）：目录穿越、任意文件名、其他扩展名一律 404——
  它不能变成通用文件读取；
- **SSRF 防护**：插件返回的媒体地址若指向回环 / 私有网段 / 链路本地地址，直接
  `media.blocked_address` 拒绝（媒体地址不受 `@hosts` 限制，因为它由上游 API 返回，
  所以必须在代理层拦截）；
- 代理只服务媒体：不提供通用转发（避免变成任意请求跳板）。合法路由只有两类：
  `/m/<一次性 token>`（远端流与本地文件共用同一形态）与 `/cover/<name>`（§4 的封面缓存目录内、名字合规的文件）。

## 8. 皮肤模型

皮肤 = `ThemeSkin` JSON，可覆盖 `theme.config.json` 任意令牌组；导入导出即分享，
`ImportSource` 与插件同构。

**已实现语义**（M4b）：

- **白名单的唯一来源是 `theme.config.json`**（AGENTS 约束 1）：核心用 `include_str!` 把它编进二进制并
  按需解析，**不在 Rust 里再抄一份令牌名清单**（否则配置一演进白名单就过期）；
- 校验分三层，全部在核心完成（前端传来的白名单等于没校验）：
  1. **结构** → `skin.invalid_document`：顶层必须是对象；`id` 形状合法（2~64 位小写字母/数字/`.`/`-`/`_`，
     **必须拒绝路径分隔符**——导出时 id 会当文件名）；`name` 非空；各令牌组必须是对象；未知**令牌组**整份拒绝；
     `swatches` 若给出必须是字符串数组；
  2. **键名** → `skin.token_rejected`：组内键名必须存在于主题配置对应位置，
     **全部列出被拒键名**（`details.rejected`，含 `components.<组件>.<字段>`）——这正是 v0.1 之前静默忽略的缺口；
  3. **值类型** → `skin.invalid_document`：`radius.md` 是字符串，写成数字就是结构错误；
- 用户皮肤**永远** `builtin: false`（自称内置会被改回并给警告）；`description`/`author`/`swatches` 缺失只警告；
- **存储**：整份文档存 `skins` 表（小文档、导出即分享）；**激活状态在 `meta.skin.active`**
  （「当前选择」不是皮肤自身的属性）；`skin.list` 每项多带一个 `active` 字段，且**只含用户皮肤**
  （内置预设随前端包发布，两者由前端合并）；
- **导入**：`paste` / `file` / `url`（URL 复用「公网 HTTPS + 非内网」校验）；`dir` / `archive` / `catalog`
  返回 `common.not_implemented` 并在 `details.supported` 里说明支持哪些；
- **导出**：`format: 'json'`（缺省）返回 pretty 文本，`'file'` 写到 `<data>/skins/<id>.json` 并返回路径。
- 令牌的**合并与 CSS 变量注入留在前端**（渲染管线）；核心只管校验、存储、导入导出。

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

### 9.1 缓存布局与策略（R56）

```
cache/
├── media/   播放过的远端曲目：<sha256(ref|quality) 前 32 位>.<ext> + 同名 .json 元信息
├── catalog/ 详情 / 榜单 / 歌词的 JSON 缓存（歌词 TTL 30 天，其余 6–24 小时）
└── covers/  本地文件内嵌封面（扫描时落盘）
```

- **只缓存用户真的播放过的**：`playback.resolve` 解析成功后在后台补全，不预取；
- **离线优先**：`playback.resolve` 在调用插件**之前**查缓存，命中即用回环代理播放
  （返回 `fromCache: true`）——断网或插件被停用/卸载时，已缓存的那首仍能播；
- 单文件 256 MiB、媒体总量 1 GiB（`limitBytes`），超出按最旧（`.json` 的 `at`）删除；
- 缓存失败只记日志，不影响本次播放；`system.cacheClear` 是用户可控的清理入口；
- 缓存不是用户资产：可随时整目录删除；下载（`downloads/`）才是用户资产。

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
| 新增 `plugin.compat.observed` / `plugin.compat.confirm`（§5.4） | 兼容模式没有域名声明，权限只能事后**收窄**：先观测实际访问的域名，用户确认后固化为 `hosts` 白名单并关闭兼容模式（TOFU） |
| 新增 `library.history.clear`（60 条命令） | 界面一直有「清空播放记录」入口；历史成为核心的事实来源后，没有这条命令等于该功能静默失效 |
| 新增 `catalog.lyricsSearch`（61 条命令） | 歌词与歌曲分离：源不给词、各源同名歌曲名称不一致、自动歌词与音频对不上——用户需要自己跨源挑一份并看到来源（R54） |
| 新增 `system.cacheStatus` / `system.cacheClear`（63 条命令） | 离线可用：只缓存播放过的曲目、命中缓存优先于插件解析；用户需要看到占用并能清理（R56） |
| 新增 `auth.*`（67 条命令）与 `auth:changed`（9 事件） | 第三方收藏夹等能力需要登录，但应用**不内置任何第三方地址**（ADR-0005）：端点由插件清单的 `@oauth` 声明，核心只跑通用 OAuth 2.0 授权码 + PKCE，令牌只进系统凭据库、只经 `oauth.getAccessToken()` 交给声明它的那个插件（R59） |
| 本地曲目新增 `artwork`（内嵌封面 → 回环 `/cover/<name>` 路由） | 本地列表只有哈希渐变；封面缓存按源路径哈希命名，不改表结构，前端只多一个「列表缩略图」消费点 |
| 本地标签改为**合并「链式元数据 + 容器元数据」** | symphonia 0.5.5 的 mp3 demuxer 不解析 ID3v2：只读 `format.metadata()` 会让最常见的 mp3 丢掉全部标签与内嵌封面（实测确认） |
| 本地路径统一归一化（折叠重复分隔符，四处共用一份实现） | 用户粘贴 `C:\\Music` 这种路径时 Windows 照样认，但同一个文件会被收成两行、封面哈希也算不到一起 |
| 下发快照时重新签发本地封面地址 | 快照存的是当时的回环端口，端口每次启动都变：原样下发会让收藏/历史/歌单显示不出封面（本地页却有）——打包版实测撞到过 |
| 内嵌封面两条提取路径各有夹具（mp3 链式 / FLAC 容器） | 合并逻辑的两半都可能是「真实用户唯一的封面来源」，只测一半等于另一半静默失效也没人知道；`.m4a/.ogg` 同理但容器夹具成本高，如实记为未覆盖 |
| 新增 `catalog.favorites`（68 条命令）与 ABI `getFavorites(page, collectionId?)`、`catalog.favoriteCollections`（69 条命令，R61）；`system.cacheConfig`（70 条命令，R62）让上限可配且清缓存不重置 | 登录之后要有用处：源侧收藏夹是**账号里**的数据（与「本机收藏」是两回事），混在一个列表里会让人分不清存在哪、为什么某首歌不见了；「不缓存」也是这条决定的另一半（R60） |
| 明确「前端 `src/plugins/**` 不是插件 ABI」 | 避免把 mock 兜底接口误当协议 |

## 11. 非功能性

- **无遥测**：不向任何服务器发送数据；错误只写本地日志。
- **性能预算**：搜索首屏（最快源）< 1s；单源搜索 P95 < 2s；插件调用超时 8s；
  本地 FTS5 检索 P95 < 50ms；扫描 1 万文件 < 10s。
  - **实测口径（R39）**：1000 个 WAV 语料 → 首扫 124 ms（0.12 ms/文件）、重扫 21 ms（大小没变就跳读标签）、
    `local.list{query}` P95 1.11 ms；按此外推 1 万文件首扫 ≈1.2 s（预算 10 s）。
    语料是小 WAV + SSD + 热缓存，属**下界**；测量入口：
    `cargo test -p gently-core --test local_library -- --ignored --nocapture measure`。
  - 搜索/插件超时那三条由插件沙箱的中断与超时逻辑保证（`plugin.runtime_error` / 8s 上限）。
- **兼容**：命令/字段只增不改；删除需先标 deprecated 一个版本。
- **凭据**：只存 OS keyring，SQLite 与日志中永不出现明文。
