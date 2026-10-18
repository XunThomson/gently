/**
 * 本机核心能力契约（**只有类型，没有实现**）v0.2。
 *
 * 形态：`gently` 是桌面端软件，**不提供任何服务器**。因此这里没有 HTTP、
 * 没有鉴权、没有幂等键、没有限流——契约就是 Rust 本机核心对外暴露的
 * **Tauri 命令与事件清单**，规范正文见 `docs/contracts/local-core-api.md`。
 *
 * 约定：
 * - 命令**永不抛异常**：一律返回 `CoreResult<T>`（失败也是 `ok: false`）；
 * - 领域模型复用 `src/types`，皮肤复用 `src/theme` 的 `ThemeSkin`；
 * - 接入时只替换 `src/services/**`：把 mock 换成 `invoke(command, params)`，UI 与 store 不动；
 * - `src/plugins/**` 是浏览器 mock 兜底用的最小接口，**不是插件 ABI**（ABI 见契约 §5）。
 *
 * 未来的单一来源：Rust 核心落地后用 `specta`/`tauri-specta` 从 Rust 结构体生成这些类型，
 * 本文件随之退化为生成产物；在此之前它是权威定义。
 */

import type {ThemeSkin} from '../theme';
import type {
    Album,
    CuratedPlaylist,
    DownloadStatus,
    DownloadTask,
    GroupedTrack,
    LocalTrack,
    LyricLine,
    Playlist,
    PluginInfo,
    RecentTrack,
    RecommendationBundle,
    RecommendedTrack,
    Track,
    TrackQuality,
} from '../types';

/* ============================== 信封与错误 ============================== */

/** 机器可读错误码：前端按码分支，绝不解析 message */
export const CORE_ERROR_CODES = {
    invalidArgument: 'common.invalid_argument',
    notFound: 'common.not_found',
    conflict: 'common.conflict',
    cancelled: 'common.cancelled',
    unsupportedPlatform: 'common.unsupported_platform',
    notImplemented: 'common.not_implemented',
    internal: 'common.internal',
    pluginInvalidSource: 'plugin.invalid_source',
    pluginInvalidManifest: 'plugin.invalid_manifest',
    pluginDuplicateId: 'plugin.duplicate_id',
    pluginImportFailed: 'plugin.import_failed',
    pluginPermissionDenied: 'plugin.permission_denied',
    pluginCredentialMissing: 'plugin.credential_missing',
    pluginRuntimeError: 'plugin.runtime_error',
    subscriptionFetchFailed: 'subscription.fetch_failed',
    subscriptionInvalidIndex: 'subscription.invalid_index',
    sourceUpstreamFailed: 'source.upstream_failed',
    sourceAuthExpired: 'source.auth_expired',
    playbackNoSource: 'playback.no_source',
    mediaProxyFailed: 'media.proxy_failed',
    mediaBlockedAddress: 'media.blocked_address',
    libraryIoError: 'library.io_error',
    libraryScanFailed: 'library.scan_failed',
    downloadDiskFull: 'download.disk_full',
    skinInvalidDocument: 'skin.invalid_document',
    skinTokenRejected: 'skin.token_rejected',
} as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[keyof typeof CORE_ERROR_CODES];

export interface CoreError {
    code: CoreErrorCode;
    /** 面向开发者的说明，不直接展示给用户 */
    message: string;
    /** 结构化细节：校验 issues、被拒的皮肤令牌键名、插件权限清单等 */
    details?: Record<string, unknown>;
}

/**
 * 统一返回。`traceId` 贯穿本地日志，用于设置页的「诊断」与日志检索。
 * IPC 反序列化失败或核心 panic 才会 reject，前端薄封装把它转成 `common.internal`。
 */
export type CoreResult<T> =
    | {ok: true; data: T; traceId: string}
    | {ok: false; error: CoreError; traceId: string};

/* ============================== 通用原语 ============================== */

/** 本地分页：仅为大列表的渲染便利，不需要跨请求一致性（无网络） */
export interface PageQuery {
    /** 1~500，缺省 50 */
    limit?: number;
    /** 不透明游标：原样回传上一页的 `nextCursor` */
    cursor?: string;
    /** 文本检索（目前只有本地曲库支持：FTS5 + 中文短词退回 LIKE） */
    query?: string;
}

export interface Page<T> {
    items: T[];
    nextCursor?: string;
    hasMore: boolean;
    total?: number;
}

/** 统一曲目引用：`source:trackId` */
export interface TrackRef {
    id: string;
    source: string;
    sourceTrackId: string;
}

export interface Lyrics {
    format: 'lrc' | 'plain';
    content: string;
    /** 译文原文（与 `content` 同格式）；前端按时间戳对齐到行上 */
    translated?: string;
    /**
     * 可选：核心若已解析成行就直接用它，前端跳过解析。
     * 当前核心**只交原文**（解析是展示问题），因此实际路径是 `utils/lyrics.ts`。
     */
    lines?: LyricLine[];
}

/**
 * 搜索结果里的一份歌词（`catalog.lyricsSearch`）。
 *
 * `sourceName` 是插件清单里的显示名——用户据此判断「这份词来自哪个源」；
 * `track` 是**这个源下的那条曲目**（各源同名歌曲可能不一致，界面要能区分）。
 */
export interface LyricSearchItem {
    source: string;
    sourceName: string;
    track: Track;
    lyrics: Lyrics;
}

export interface LyricSearchResult {
    items: LyricSearchItem[];
    /** 成功问过（哪怕没有词）的源 */
    searchedSources: string[];
    /** search 失败 / 已启用但加载失败的源 */
    failedSources: string[];
    /** 有 search、但没有 getLyric 能力（不参与，不算失败） */
    skippedSources: string[];
    /** 超过整体截止时间、结果没等到 */
    timedOutSources: string[];
}

/** 源的榜单/分类：**分类树由源自定义**，不是固定枚举 */
export interface TopListItem {
    id: string;
    title: string;
    cover?: string;
    description?: string;
}

export interface TopListGroup {
    title: string;
    items: TopListItem[];
}

export interface TopListPage {
    items: Track[];
    hasMore: boolean;
    /** 下一页页码（源自定义语义） */
    nextPage?: number;
}

/* ============================== 插件 ============================== */

export type PluginPermission = 'network' | 'filesystem:read' | 'filesystem:write' | 'credentials';

export interface PluginCredentialField {
    key: string;
    label: string;
    required: boolean;
    /** 敏感值：界面掩码显示，只进 OS keyring */
    secret: boolean;
}

/**
 * 插件声明的第三方授权配置（`@oauth` / `plugin.json` 的 `oauth`）。
 *
 * **端点来自插件**，应用不预置任何第三方地址（ADR-0005）；核心只做通用流程。
 */
export interface OAuthConfig {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes: string[];
    /** PKCE（S256）；插件写 `nopkce` 时为 false（安全性下降，界面应提示） */
    pkce: boolean;
    /** 本机回调端口；0 = 随机 */
    redirectPort: number;
}

/** `auth.status`：只有状态，**没有任何令牌字段** */
export interface OAuthStatus {
    pluginId: string;
    /** 插件是否声明了 `@oauth`（没声明就不该显示授权入口） */
    declared: boolean;
    authorized: boolean;
    /** 毫秒时间戳；上游没给 `expires_in` 时可能是 null */
    expiresAt: number | null;
    /** 实际拿到的 scope（来自令牌响应，缺省回落为声明值） */
    scopes: string[];
    declaredScopes: string[];
    /** 是否有一轮授权正在等浏览器回调 */
    pending: boolean;
    /** 令牌落点：`windows-credential-manager` 或 `memory`（后者重启即失效） */
    backend: string;
}

/** `auth.begin`：把 `authorizeUrl` 交给系统浏览器打开即可 */
export interface OAuthBeginResult {
    pluginId: string;
    authorizeUrl: string;
    redirectUri: string;
    state: string;
    /** 等回调的截止时间（毫秒时间戳）；过了就自动放弃 */
    expiresAt: number;
}

/** 插件来源（用于审计与更新判断） */
export type PluginOrigin =
    | {kind: 'file'; path: string}
    | {kind: 'dir'; path: string}
    | {kind: 'archive'; path: string}
    | {kind: 'url'; url: string}
    | {kind: 'catalog'; subscriptionId: string; fileName?: string}
    /** 粘贴文本导入：不留来源路径，仅凭 sha256 识别内容变化 */
    | {kind: 'paste'};

/** 插件元数据：单文件来自头部注释，目录包来自 plugin.json */
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    homepage?: string;
    /** 支持的音质档位，由高到低 */
    qualities: TrackQuality[];
    permissions: PluginPermission[];
    /** 网络白名单：只允许访问这些域名（仅 HTTPS） */
    hosts: string[];
    credentials: PluginCredentialField[];
    /**
     * 第三方授权声明（`@oauth`）：端点由插件提供，核心只跑通用 OAuth 2.0 流程。
     * **应用不内置任何第三方地址**（ADR-0005）——没有声明就是没有。
     */
    oauth?: OAuthConfig;
    minCoreVersion?: string;
    tags: string[];
    /**
     * 兼容模式：插件来自 MusicFree / LX 生态、不声明 `hosts`。
     * 开启后允许访问任意**公网** HTTPS 域名（本机/内网始终拒绝），实际访问的域名会记入日志。
     */
    compat?: boolean;
    /** 该插件实际实现了哪些函数（能力探测结果，UI 据此隐藏入口） */
    capabilities: PluginCapability[];
}

export type PluginCapability =
    | 'search'
    | 'getMediaSource'
    | 'getTrackInfo'
    | 'getAlbumInfo'
    | 'getPlaylistInfo'
    | 'getLyric'
    | 'getTopLists'
    | 'getTopList'
    | 'getRecommend';

/** 已安装插件的完整信息 */
export interface PluginSummary extends PluginInfo {
    manifest: PluginManifest;
    healthy?: boolean;
    origin: PluginOrigin;
    /** 来自哪个订阅（手动导入时为 undefined） */
    subscriptionId?: string;
    /** 导入时记录的校验和，用于更新前后比对 */
    sha256?: string;
    /** 回退优先级：数值越小越优先，决定 playback.resolve 的候选顺序 */
    priority: number;
    /**
     * 兼容模式插件（MusicFree / LX 生态的 CommonJS 插件，ADR-0006）。
     * **权限弱于自有 ABI**：可访问任意公网 HTTPS 域名（本机/内网仍拒绝），
     * 界面必须把它标出来，不能与自有 ABI 插件呈现为同等安全。
     */
    compat: boolean;
}

/** `plugin.import` 的结果：安装后的摘要 + 非致命警告 + 是否覆盖了旧版本 */
export interface PluginImportResult {
    plugin: PluginSummary;
    warnings: string[];
    replaced: boolean;
}

/**
 * 通用导入来源（插件与皮肤同构）。
 * 「社区分享」= 单文件 / 目录包 / 压缩包 / URL / 粘贴文本 / 订阅内一键安装。
 */
export type ImportSource =
    | {kind: 'file'; path: string}
    | {kind: 'dir'; path: string}
    | {kind: 'archive'; path: string}
    | {kind: 'url'; url: string}
    | {kind: 'paste'; content: string}
    | {kind: 'catalog'; subscriptionId: string; fileName: string};

export interface PluginImportPreview {
    manifest: PluginManifest;
    permissions: PluginPermission[];
    credentials: PluginCredentialField[];
    /** 非致命问题：缺字段、版本过低、同 id 已存在、来自陌生仓库等 */
    warnings: string[];
    /** 同 id 插件是否已安装（安装即覆盖） */
    replacesExisting: boolean;
    /** 从 URL/压缩包/订阅导入时的校验和 */
    sha256?: string;
    /**
     * 兼容模式（ADR-0006）：`true` 时界面必须明示「可访问任意公网域名，权限弱于自有 ABI」。
     * 来源可能是作者的 `@compat` 标记，也可能是用户在导入时显式开启。
     */
    compat: boolean;
    /**
     * 第三方授权声明（清单里有 `@oauth` 时出现）：同意安装前就要让用户看到
     * **会把浏览器带去哪个域名**、要哪些 scope、有没有关掉 PKCE。
     */
    oauth?: OAuthConfig;
}

export interface PluginCredentialStatus {
    key: string;
    /** 清单里的展示名（界面用它当输入框标签） */
    label: string;
    /** 敏感值：界面掩码显示 */
    secret: boolean;
    /** 只回「是否已配置」，**永不返回值** */
    present: boolean;
}

/** `plugin.checkUpdate` 的返回：**只比对，不自动更新** */
export interface PluginUpdateCheck {
    current: string;
    latest: string;
    /** 版本或校验和有变化 */
    changed: boolean;
    /** 比对来源：`url` 下载新版本比对，`catalog` 比对本地缓存的订阅索引 */
    source: 'url' | 'catalog';
}

/**
 * 兼容插件**实际访问过**的域名（TOFU 收敛的依据）。
 *
 * 观测台账在沙箱放行兼容请求时记录，重启后仍在（`plugins/.hosts/<id>.json`，卸载即清）。
 * 收敛（`confirmHosts`）之后这些域名进 `hosts` 白名单，插件不再是兼容模式。
 */
export interface PluginHostUse {
    host: string;
    /** 放行次数（进程内累计） */
    count: number;
    firstSeen: number;
    lastSeen: number;
}

export interface PluginObservedHosts {
    pluginId: string;
    /** `false` 表示该插件已不是兼容模式，没有可收敛的东西 */
    compat: boolean;
    /** 当前声明的白名单（收敛后 = 已确认的域名） */
    whitelist: string[];
    hosts: PluginHostUse[];
}

/* ---- 订阅与社区仓库索引（与 Legado 社区仓库规范同构，字段只增不改） ---- */

export interface SubscriptionSourceEntry {
    name: string;
    fileName: string;
    downloadUrl: string;
    version: string;
    author: string;
    url: string;
    group: string;
    logo: string;
    description: string;
    tags: string[];
    enabled: boolean;
    fileSize: number;
    updatedAt: string;
    /** 可选：有则安装后校验 */
    sha256?: string;
    /** 可选：便于安装前展示网络范围 */
    hosts?: string[];
    qualities?: TrackQuality[];
}

export interface SubscriptionIndex {
    name: string;
    version: string;
    updatedAt: string;
    url?: string;
    sources: SubscriptionSourceEntry[];
}

export interface Subscription {
    id: string;
    name: string;
    url: string;
    /** 最近一次成功刷新的时间（毫秒时间戳）；从未成功为 undefined */
    updatedAt?: number;
    count: number;
    /** 最近一次刷新失败的说明（有值时 UI 提示，但保留旧索引可用） */
    error?: string;
}

/** 订阅内的可安装条目（含本地安装状态） */
export interface CatalogEntry extends SubscriptionSourceEntry {
    subscriptionId: string;
    subscriptionName: string;
    installed: boolean;
    updateAvailable: boolean;
}

/* ============================== 媒体 ============================== */

/**
 * 解析结果。**必须经核心代理播放**：
 * WebView 的 `<audio>` 无法设置 Referer/UA/Cookie，也不便处理 CORS，因此 `streamUrl`
 * 指向核心的本地流代理（仅回环、一次性 token、支持 Range）；`originUrl` 仅供展示排障。
 */
export interface ResolvedMedia {
    source: string;
    /** 实际下发档位，可能低于期望 */
    quality: TrackQuality;
    /** 核心代理地址：http://127.0.0.1:<port>/m/<一次性 token> */
    streamUrl: string;
    originUrl: string;
    headers?: Record<string, string>;
    mimeType?: string;
    expiresInSec: number;
    /** 这条地址来自本地播放缓存（断网也能播）；界面可据此显示「缓存」标记 */
    fromCache?: boolean;
}

/* ============================== 契约 ============================== */

export interface SystemCountsDto {
    plugins: number;
    favorites: number;
    tracks: number;
    downloads: number;
}

/** `system.status`：核心版本、平台、数据目录与数据库状态。 */
export interface SystemStatusDto {
    version: string;
    platform: string;
    dbPath: string;
    dataDir: string;
    /** `none`（M0）→ `quickjs`（M1 接入插件宿主后） */
    pluginRuntime: string;
    /** 数据库是否可用；不可用时应用以降级模式运行 */
    dbReady: boolean;
    /** 数据库不可用的原因（`dbReady` 为 false 时存在） */
    dbError?: string;
    /**
     * 第三方凭据的落点：`windows-credential-manager`（系统凭据库，重启后仍在）
     * 或 `memory`（降级：重启后需要重新填写）。界面据此如实说明，而不是一律警告。
     */
    credentialsBackend: string;
    counts: SystemCountsDto;
}

/** `system.paths`：受管目录（`system.reveal` 只接受这些目录内的路径）。 */
export interface SystemPathsDto {
    data: string;
    cache: string;
    plugins: string;
    subscriptions: string;
    skins: string;
    downloads: string;
    logs: string;
}

export interface SystemApi {
    status(): Promise<CoreResult<SystemStatusDto>>;
    paths(): Promise<CoreResult<SystemPathsDto>>;
    /** 在系统文件管理器中打开某个路径（仅限受管目录） */
    reveal(input: {path: string}): Promise<CoreResult<null>>;
    /** 缓存占用（播放缓存 / 歌词与详情 / 封面），设置页展示与清理用 */
    cacheStatus(): Promise<CoreResult<CacheStatusDto>>;
    /** 清理缓存；缺省 kind = all */
    cacheClear(input?: {kind?: CacheClearKind}): Promise<CoreResult<CacheClearResultDto>>;
}

export type CacheClearKind = 'media' | 'catalog' | 'covers' | 'all';

export interface CacheStatusDto {
    /** 播放缓存（播放过的远端曲目） */
    mediaBytes: number;
    mediaCount: number;
    /** 歌词 / 详情 / 榜单 JSON 缓存 */
    catalogBytes: number;
    catalogCount: number;
    /** 本地内嵌封面 */
    coversBytes: number;
    coversCount: number;
    /** 媒体缓存总量上限（超出后核心按最旧自动清理） */
    limitBytes: number;
}

export interface CacheClearResultDto {
    removedBytes: number;
    removedFiles: number;
}

export interface CatalogApi {
    /**
     * **流式搜索**：立即返回 searchId，结果经 `catalog:search:partial` 逐源到达，
     * `catalog:search:done` 给出跨源合并后的最终列表。合并只在核心完成。
     */
    search(input: {keyword: string; sources?: string[]; limit?: number}): Promise<CoreResult<{searchId: string}>>;
    /** 取消 fan-out（慢源不该拖住用户） */
    searchCancel(input: {searchId: string}): Promise<CoreResult<void>>;
    track(input: {ref: string}): Promise<CoreResult<GroupedTrack | null>>;
    album(input: {source: string; id: string}): Promise<CoreResult<Album | null>>;
    playlist(input: {source: string; id: string}): Promise<CoreResult<CuratedPlaylist | null>>;
    /** 源的榜单/分类树（分类由源自定义） */
    topLists(input: {source: string}): Promise<CoreResult<TopListGroup[]>>;
    topList(input: {source: string; id: string; page?: number}): Promise<CoreResult<TopListPage>>;
    recommend(input: {source: string}): Promise<CoreResult<Track[]>>;
    /** 无歌词返回 `data: null`，不是错误 */
    lyrics(input: {ref: string; withTranslation?: boolean}): Promise<CoreResult<Lyrics | null>>;
    /** 跨源按关键词找歌词（手动选择用：带来源与候选曲目信息） */
    lyricsSearch(input: {query: string; limit?: number}): Promise<CoreResult<LyricSearchResult>>;
}

export interface LibraryApi {
    favorites: {
        list(query?: PageQuery): Promise<CoreResult<Page<GroupedTrack>>>;
        /**
         * 本地事务：无需幂等键，重复调用结果一致。
         *
         * `track` 是**曲目快照**（界面手上有，直接带上）：本机库存快照而不是引用，
         * 因为插件可能被卸载或改接口——列收藏不该依赖插件在线。缺快照时核心退化成
         * 占位曲目（标题 = rawId），下次带快照写入会刷新。
         */
        set(input: {ref: TrackRef; favorite: boolean; track?: Track}): Promise<CoreResult<{favorite: boolean}>>;
    };
    playlists: {
        list(): Promise<CoreResult<Playlist[]>>;
        /**
         * 带 id 为更新（曲目**整体覆盖**，顺序 = `trackRefs` 顺序），缺省为新建。
         * `tracks` 与 `trackRefs` **一一对应**（可选）：缺的条目退化成占位曲目。
         */
        save(input: {id?: string; name: string; trackRefs: TrackRef[]; tracks?: Track[]})
            : Promise<CoreResult<Playlist>>;
        delete(input: {id: string}): Promise<CoreResult<void>>;
    };
    history: {
        list(query?: PageQuery): Promise<CoreResult<Page<RecentTrack>>>;
        /** 每次播放留一行；`track` 同 `favorites.set` 的快照语义 */
        push(input: {ref: TrackRef; playedSec: number; completed: boolean; track?: Track})
            : Promise<CoreResult<void>>;
    };
    local: {
        /**
         * 扫描本地目录并入库；进度通过 `library:scan:progress` 事件推送。
         *
         * 语义：**大小没变的文件不重读标签**（`skipped`）；只清理**本次扫描范围内**消失的条目
         * （非递归扫描不会误删子目录）；读不到标签的文件照样入库（标题退回文件名）。
         */
        scan(input: {dirs: string[]; recursive?: boolean}): Promise<CoreResult<LocalScanResult>>;
        list(query?: PageQuery): Promise<CoreResult<Page<LocalTrack>>>;
        /**
         * 从曲库移除；`deleteFile: true` 才真的删磁盘文件，且只接受音频扩展名。
         * **界面必须走二次确认**（删文件不可逆）。
         */
        remove(input: {id: string; deleteFile?: boolean}): Promise<CoreResult<void>>;
    };
}

/** `library.local.scan` 的结果：这一次扫描到底做了什么（界面如实说明，别只说「完成」） */
export interface LocalScanResult {
    /** 扫描到的音频文件总数 */
    scanned: number;
    /** 新入库 */
    added: number;
    /** 重新读了标签并更新 */
    updated: number;
    /** 本次扫描范围内已消失、被移出曲库 */
    removed: number;
    /** 大小没变、跳过重读（等价于「没动」） */
    skipped: number;
    /** 读不到标签（照样入库，标题退回文件名） */
    unreadable: number;
    /**
     * 见到了、但扩展名不是认得的音频格式的文件数（`desktop.ini` / `.jpg` / `.txt`…）。
     *
     * 用来把「这个目录里一个音频都没有」和「目录是空的」区分开：只报 `scanned=0` 时，
     * 界面看起来和「功能坏了」一模一样（R53 实测：目录里只有 `.m4s`）。
     */
    ignored: number;
}

export interface RecommendApi {
    home(input?: {limit?: number}): Promise<CoreResult<RecommendationBundle>>;
    similar(input: {seed: TrackRef | {albumId: string}; limit?: number}): Promise<CoreResult<RecommendedTrack[]>>;
    /**
     * 反馈（append-only 落库，下次打分时消费）：`like` 等价一次收藏、`skip`（进度 < 0.5）扣分、
     * `complete`（进度 ≥ 0.9）加分、`play` 不额外加权（历史里已经有它）。
     *
     * `track` 是曲目快照：标签/歌手是打分的依据，缺了核心会从本机库反查（收藏 → 历史 → 本地曲库）。
     */
    feedback(input: {
        ref: TrackRef;
        action: 'play' | 'skip' | 'like' | 'unlike' | 'complete';
        /** 播放进度 0~1：区分「跳过」与「没听完」 */
        progress?: number;
        track?: Track;
    }): Promise<CoreResult<void>>;
}

export interface PlaybackApi {
    /**
     * 按候选顺序回退；全部失败返回 `data: null`，前端退回模拟时钟。
     *
     * **本地曲目（`source === 'local'`）也走这里**：核心把文件发布到同一条回环代理，
     * 因此前端只有一条播放路径（Range/拖动进度、无需 Blob）。
     */
    resolve(input: {ref: TrackRef; quality: TrackQuality; preferredSources?: string[]})
        : Promise<CoreResult<ResolvedMedia | null>>;
    /**
     * 上报一次播放（写播放历史，「最近播放」与推荐画像的共同数据源）。
     * `track` 是曲目快照（同 `library.history.push`）：带上它，历史在插件被卸载后也能列出。
     */
    report(input: {
        ref: TrackRef;
        source: string;
        quality: TrackQuality;
        playedSec: number;
        completed: boolean;
        track?: Track;
    }): Promise<CoreResult<void>>;
}

export interface PluginApi {
    list(): Promise<CoreResult<PluginSummary[]>>;
    /**
     * 安装前展示清单、权限与凭据需求，由用户显式同意。
     * `compat: true` = 用户显式开启兼容模式（没有头部元数据的 MusicFree / LX 插件靠它才能导入）。
     */
    preview(input: {from: ImportSource; compat?: boolean}): Promise<CoreResult<PluginImportPreview>>;
    /** `consent: true` 表示用户已确认权限；核心只在此时落盘。`compat` 必须与预览时一致 */
    import(input: {from: ImportSource; consent: true; compat?: boolean})
        : Promise<CoreResult<PluginImportResult>>;
    remove(input: {id: string; deleteFiles?: boolean}): Promise<CoreResult<void>>;
    setEnabled(input: {id: string; enabled: boolean}): Promise<CoreResult<PluginSummary>>;
    /** 数值越小越优先；决定 `playback.resolve` 的回退顺序 */
    setPriority(input: {id: string; priority: number}): Promise<CoreResult<void>>;
    /** 与来源比对版本/校验和；**不自动更新**，本地目录导入的需要用户自己更新文件 */
    checkUpdate(input: {id: string}): Promise<CoreResult<PluginUpdateCheck | null>>;
    /** 重建运行时并重新探测能力（安装只落盘，真正可用发生在这里） */
    reload(input: {id: string}): Promise<CoreResult<PluginSummary>>;
    /**
     * 兼容模式收敛（ADR-0006/TOFU）：该插件实际访问过的域名。
     * 非兼容插件返回 `compat: false` + 空列表，不报错。
     */
    compatObserved(input: {id: string}): Promise<CoreResult<PluginObservedHosts>>;
    /**
     * 把观测到的域名固化成 `hosts` 白名单并**关闭兼容模式**（收窄，方向不可逆：
     * 要恢复兼容模式只能重新导入）。`hosts` 只能来自 `compatObserved` 的结果。
     */
    compatConfirm(input: {id: string; hosts: string[]; consent: true})
        : Promise<CoreResult<PluginSummary>>;
    config: {
        get(input: {id: string}): Promise<CoreResult<{values: Record<string, unknown>; revision: number}>>;
        /** revision 不匹配返回 `common.conflict` */
        put(input: {id: string; values: Record<string, unknown>; revision: number})
            : Promise<CoreResult<{revision: number}>>;
    };
    credentials: {
        /**
         * 只接受插件**清单声明过**的键（清单就是用户同意时看到的那份）；
         * 第三方音乐账号只在这里，不经过我方任何服务器。
         *
         * 落点当前是**进程内存储**（真 OS keyring 需要一个不在离线 registry 里的依赖），
         * 因此重启后需要重新填写——这是已知缺口，不是静默行为。
         */
        set(input: {id: string; key: string; value: string}): Promise<CoreResult<void>>;
        /** 缺省清空该插件的全部凭据 */
        clear(input: {id: string; key?: string}): Promise<CoreResult<void>>;
        /** 只回「是否已配置」，**永不返回值** */
        status(input: {id: string}): Promise<CoreResult<PluginCredentialStatus[]>>;
    };
    /** 订阅源：指向社区仓库的 `repository.json`（不依赖我们的服务器） */
    subscriptions: {
        list(): Promise<CoreResult<Subscription[]>>;
        add(input: {url: string; name?: string}): Promise<CoreResult<Subscription>>;
        remove(input: {id: string}): Promise<CoreResult<void>>;
        /** 重新拉取索引并本地缓存；失败保留旧索引并返回 subscription.fetch_failed */
        refresh(input: {id: string}): Promise<CoreResult<Subscription>>;
    };
    /** 订阅内可安装条目（浏览器页用） */
    catalog: {
        list(input?: {subscriptionId?: string; query?: string; tags?: string[]})
            : Promise<CoreResult<CatalogEntry[]>>;
    };
}

/**
 * 第三方授权（契约 §2 的 `auth.*`）。
 *
 * 核心只做与厂商无关的那一段：起本机回环回调、校验 `state`、用授权码换令牌、把令牌存进
 * 系统凭据库。**授权页由系统浏览器打开**（前端用 opener 打开 `begin` 返回的地址）——
 * 应用不内置任何第三方地址，端点全部来自插件清单的 `@oauth` 声明。
 */
export interface OAuthApi {
    /** 只回状态：是否已授权、过期时间、scope。**没有任何命令能读回令牌** */
    status(input: {pluginId: string}): Promise<CoreResult<OAuthStatus>>;
    /**
     * 发起授权：核心绑定 `127.0.0.1` 的临时端口等回调，返回要交给系统浏览器的地址。
     * 浏览器回到 `/callback` 后，核心自己换令牌并推 `auth:changed`。
     */
    begin(input: {pluginId: string}): Promise<CoreResult<OAuthBeginResult>>;
    /** 放弃正在等待的授权（关闭回调监听） */
    cancel(input: {pluginId: string}): Promise<CoreResult<void>>;
    /** 退出登录：删除凭据库里的令牌（未授权时是幂等的空操作） */
    signOut(input: {pluginId: string}): Promise<CoreResult<void>>;
}

export interface DownloadApi {
    list(input?: {status?: DownloadStatus}): Promise<CoreResult<DownloadTask[]>>;
    /**
     * 建任务后**立刻返回**（状态 `pending`），真正的下载在后台线程，进度靠
     * `download:progress` / `download:done` / `download:error` 事件推送。
     * `track` 是曲目快照（列表在插件被卸载后也能显示歌名）；`dir` 必须是已存在的目录。
     */
    create(input: {ref: TrackRef; quality?: TrackQuality; dir?: string; track?: Track})
        : Promise<CoreResult<DownloadTask>>;
    /** 停在下一次分块处，进度落库（半成品 `<file>.part` 保留给续传） */
    pause(input: {id: string}): Promise<CoreResult<DownloadTask>>;
    /** 从已收字节数续传；上游不支持 Range 时会从头开始 */
    resume(input: {id: string}): Promise<CoreResult<DownloadTask>>;
    /** 缺省只移除**任务记录**（已完成的文件是用户的资产）；`deleteFile` 才连文件一起删 */
    remove(input: {id: string; deleteFile?: boolean}): Promise<CoreResult<void>>;
    /** 清理已完成/失败的记录（不删文件） */
    clearFinished(): Promise<CoreResult<{removed: number}>>;
}

export interface SkinApi {
    list(): Promise<CoreResult<ThemeSkin[]>>;
    /** 结构 + **令牌键名白名单**校验；被拒键名通过 `skin.token_rejected` 列出 */
    preview(input: {from: ImportSource}): Promise<CoreResult<{skin: ThemeSkin; warnings: string[]}>>;
    install(input: {from: ImportSource}): Promise<CoreResult<ThemeSkin>>;
    remove(input: {id: string}): Promise<CoreResult<void>>;
    /** null 表示恢复默认主题 */
    setActive(input: {id: string | null}): Promise<CoreResult<void>>;
    /** 导出即分享：返回 JSON 文本，或写入用户选择的位置 */
    export(input: {id: string; format: 'json' | 'file'}): Promise<CoreResult<{json?: string; path?: string}>>;
}

/** 本机核心能力总入口（实现方：Rust 核心的 Tauri 命令层） */
export interface LocalCore {
    system: SystemApi;
    catalog: CatalogApi;
    library: LibraryApi;
    recommend: RecommendApi;
    playback: PlaybackApi;
    plugin: PluginApi;
    download: DownloadApi;
    skin: SkinApi;
}

/* ============================== 事件 ============================== */

/** 核心 → 前端推送（替代原 WebSocket 实时通道） */
export interface CoreEventMap {
    /** 逐源到达的搜索结果（原始、未合并），用于流式 UI 与分源视图 */
    'catalog:search:partial': {searchId: string; source: string; tracks: Track[]; failed?: CoreError};
    /** 搜索收敛：跨源合并后的候选列表 */
    'catalog:search:done': {
        searchId: string;
        items: GroupedTrack[];
        sources: string[];
        failedSources: string[];
    };
    /**
     * 下载事件：**不是**整个任务对象（进度只需要几个字段，任务本身用 `download.list` 读）。
     * 失败事件带 `code`——界面按码走 i18n（`src/i18n/errors.ts`），不解析 `message`。
     */
    'download:progress': {id: string; received: number; total?: number; speed?: number};
    'download:done': {id: string; path: string; bytes: number};
    'download:error': {id: string; code: CoreErrorCode; message: string};
    'plugin:health': PluginInfo;
    'plugin:import:progress': {phase: 'fetch' | 'extract' | 'validate' | 'install'; percent?: number};
    'library:scan:progress': {dir: string; found: number; percent?: number};
    /**
     * 第三方授权状态变化：回调线程换到令牌 / 用户取消 / 换令牌失败时推送。
     * 界面据此刷新「已授权 / 未授权」——没有这条事件就只能靠轮询。
     */
    'auth:changed': {pluginId: string; authorized: boolean; expiresAt?: number | null};
}

export type CoreEventName = keyof CoreEventMap;

/** 下载任务状态：与 `src/types` 同源，避免两处枚举漂移 */
export type {DownloadStatus};
