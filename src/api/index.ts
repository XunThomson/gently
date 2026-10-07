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
    cursor?: string;
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
    translated?: string;
    /** 核心已解析时直接下发，省去前端解析 */
    lines?: LyricLine[];
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

/** 插件来源（用于审计与更新判断） */
export type PluginOrigin =
    | {kind: 'file'; path: string}
    | {kind: 'dir'; path: string}
    | {kind: 'archive'; path: string}
    | {kind: 'url'; url: string}
    | {kind: 'catalog'; subscriptionId: string; fileName: string};

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
    minCoreVersion?: string;
    tags: string[];
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
}

export interface PluginCredentialStatus {
    key: string;
    /** 只回「是否已配置」，**永不返回值** */
    present: boolean;
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
    /** 最近一次成功刷新的时间；从未成功为 undefined */
    updatedAt?: string;
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
}

export interface CatalogApi {
    /**
     * **流式搜索**：立即返回 searchId，结果经 `catalog.search.partial` 逐源到达，
     * `catalog.search.done` 给出跨源合并后的最终列表。合并只在核心完成。
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
}

export interface LibraryApi {
    favorites: {
        list(query?: PageQuery): Promise<CoreResult<Page<GroupedTrack>>>;
        /** 本地事务：无需幂等键，重复调用结果一致 */
        set(input: {ref: TrackRef; favorite: boolean}): Promise<CoreResult<{favorite: boolean}>>;
    };
    playlists: {
        list(): Promise<CoreResult<Playlist[]>>;
        /** 带 id 为更新，缺省为新建 */
        save(input: {id?: string; name: string; trackRefs: TrackRef[]}): Promise<CoreResult<Playlist>>;
        delete(input: {id: string}): Promise<CoreResult<void>>;
    };
    history: {
        list(query?: PageQuery): Promise<CoreResult<Page<RecentTrack>>>;
        push(input: {ref: TrackRef; playedSec: number; completed: boolean}): Promise<CoreResult<void>>;
    };
    local: {
        /** 扫描本地目录；进度通过 `library.scan.progress` 事件推送 */
        scan(input: {dirs: string[]; recursive?: boolean})
            : Promise<CoreResult<{added: number; updated: number; removed: number}>>;
        list(query?: PageQuery): Promise<CoreResult<Page<LocalTrack>>>;
        remove(input: {id: string; deleteFile?: boolean}): Promise<CoreResult<void>>;
    };
}

export interface RecommendApi {
    home(input?: {limit?: number}): Promise<CoreResult<RecommendationBundle>>;
    similar(input: {seed: TrackRef | {albumId: string}; limit?: number}): Promise<CoreResult<RecommendedTrack[]>>;
    feedback(input: {
        ref: TrackRef;
        action: 'play' | 'skip' | 'like' | 'unlike' | 'complete';
        /** 播放进度 0~1：区分「跳过」与「没听完」 */
        progress?: number;
    }): Promise<CoreResult<void>>;
}

export interface PlaybackApi {
    /** 按插件优先级依次回退；全部失败返回 `data: null`，前端退回模拟时钟 */
    resolve(input: {ref: TrackRef; quality: TrackQuality; preferredSources?: string[]})
        : Promise<CoreResult<ResolvedMedia | null>>;
    report(input: {ref: TrackRef; source: string; quality: TrackQuality; playedSec: number; completed: boolean})
        : Promise<CoreResult<void>>;
}

export interface PluginApi {
    list(): Promise<CoreResult<PluginSummary[]>>;
    /** 安装前展示清单、权限与凭据需求，由用户显式同意 */
    preview(input: {from: ImportSource}): Promise<CoreResult<PluginImportPreview>>;
    /** `consent: true` 表示用户已确认权限；核心只在此时落盘 */
    import(input: {from: ImportSource; consent: true}): Promise<CoreResult<PluginSummary>>;
    remove(input: {id: string; deleteFiles?: boolean}): Promise<CoreResult<void>>;
    setEnabled(input: {id: string; enabled: boolean}): Promise<CoreResult<PluginSummary>>;
    /** 数值越小越优先；决定 `playback.resolve` 的回退顺序 */
    setPriority(input: {id: string; priority: number}): Promise<CoreResult<void>>;
    /** 与来源比对版本/校验和；**不自动更新**，本地目录导入的需要用户自己更新文件 */
    checkUpdate(input: {id: string}): Promise<CoreResult<{current: string; latest: string} | null>>;
    reload(input: {id: string}): Promise<CoreResult<void>>;
    config: {
        get(input: {id: string}): Promise<CoreResult<{values: Record<string, unknown>; revision: number}>>;
        /** revision 不匹配返回 `common.conflict` */
        put(input: {id: string; values: Record<string, unknown>; revision: number})
            : Promise<CoreResult<{revision: number}>>;
    };
    credentials: {
        /** 写入 OS keyring；第三方音乐账号只在这里，不经过我方任何服务器 */
        set(input: {id: string; key: string; value: string}): Promise<CoreResult<void>>;
        clear(input: {id: string; key?: string}): Promise<CoreResult<void>>;
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

export interface DownloadApi {
    list(): Promise<CoreResult<DownloadTask[]>>;
    create(input: {ref: TrackRef; quality: TrackQuality; dir?: string}): Promise<CoreResult<DownloadTask>>;
    pause(input: {id: string}): Promise<CoreResult<DownloadTask>>;
    resume(input: {id: string}): Promise<CoreResult<DownloadTask>>;
    remove(input: {id: string; deleteFile?: boolean}): Promise<CoreResult<void>>;
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
    'catalog.search.partial': {searchId: string; source: string; tracks: Track[]; failed?: CoreError};
    /** 搜索收敛：跨源合并后的候选列表 */
    'catalog.search.done': {
        searchId: string;
        items: GroupedTrack[];
        sources: string[];
        failedSources: string[];
    };
    'download.progress': DownloadTask;
    'download.done': DownloadTask;
    'download.error': DownloadTask;
    'plugin.health': PluginInfo;
    'plugin.import.progress': {phase: 'fetch' | 'extract' | 'validate' | 'install'; percent?: number};
    'library.scan.progress': {dir: string; found: number; percent?: number};
}

export type CoreEventName = keyof CoreEventMap;

/** 下载任务状态：与 `src/types` 同源，避免两处枚举漂移 */
export type {DownloadStatus};
