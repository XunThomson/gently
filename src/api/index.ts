/**
 * 本机核心能力契约（**只有类型，没有实现**）。
 *
 * 形态：`gently` 是桌面端软件，**不提供任何服务器**。因此这里没有 HTTP、
 * 没有鉴权、没有幂等键、没有限流——契约就是 Rust 本机核心对外暴露的
 * **Tauri 命令与事件清单**，规范正文见 `docs/contracts/local-core-api.md`。
 *
 * 约定：
 * - 命令**永不抛异常**：一律返回 `CoreResult<T>`（失败也是 `ok: false`）；
 * - 领域模型复用 `src/types`，皮肤复用 `src/theme` 的 `ThemeSkin`，不另起一套；
 * - 接入时只替换 `src/services/**` 内部实现：把 mock 换成 `invoke(command, params)`，
 *   UI 与 store 不动。
 *
 * 未来的单一来源：Rust 核心落地后用 `tauri-specta`/`specta` 从 Rust 结构体生成这些
 * 类型，本文件随之退化为生成产物；在此之前它是权威定义。
 */

import type {ThemeSkin} from '../theme';
import type {
    Album,
    ChartType,
    CuratedPlaylist,
    DateSelection,
    DownloadStatus,
    DownloadTask,
    GroupedTrack,
    LocalTrack,
    LyricLine,
    Period,
    Playlist,
    PluginInfo,
    RecentTrack,
    RecommendationBundle,
    RecommendedTrack,
    ResolvedSource,
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
    pluginInvalidManifest: 'plugin.invalid_manifest',
    pluginDuplicateId: 'plugin.duplicate_id',
    pluginImportFailed: 'plugin.import_failed',
    pluginPermissionDenied: 'plugin.permission_denied',
    pluginCredentialMissing: 'plugin.credential_missing',
    pluginRuntimeError: 'plugin.runtime_error',
    sourceUpstreamFailed: 'source.upstream_failed',
    sourceAuthExpired: 'source.auth_expired',
    playbackNoSource: 'playback.no_source',
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

/** 排名变化为可选：并非所有上游都提供上期数据 */
export interface ChartEntry {
    rank: number;
    track: GroupedTrack;
    heat: number;
    delta?: number;
}

export interface ChartResult {
    chart: ChartType;
    period: Period;
    date: string;
    entries: ChartEntry[];
}

export interface Lyrics {
    format: 'lrc' | 'plain';
    content: string;
    translated?: string;
    /** 核心已解析时直接下发，省去前端解析 */
    lines?: LyricLine[];
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

/** `plugin.json` 的线上表示（清单字段与 Rust 侧结构体一一对应） */
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    homepage?: string;
    /** 入口 JS，相对插件目录 */
    entry: string;
    /** 运行时：当前只有内嵌 QuickJS */
    runtime: 'js';
    /** 支持的音质档位，由高到低 */
    qualities: TrackQuality[];
    permissions: PluginPermission[];
    /** 网络白名单：只允许访问这些域名（HTTPS） */
    hosts: string[];
    credentials: PluginCredentialField[];
    minCoreVersion?: string;
}

/**
 * 通用导入来源（插件与皮肤同构）。
 * 「社区分享」= 用户自行 git clone 后给目录、手动下载的压缩包、直链，或粘贴的清单文本。
 */
export type ImportSource =
    | {kind: 'dir'; path: string}
    | {kind: 'archive'; path: string}
    | {kind: 'url'; url: string}
    | {kind: 'paste'; manifest: string};

export interface PluginImportPreview {
    manifest: PluginManifest;
    permissions: PluginPermission[];
    credentials: PluginCredentialField[];
    /** 非致命问题：缺少可选字段、版本过低、同 id 已存在等 */
    warnings: string[];
    /** 同 id 插件是否已安装（安装即覆盖） */
    replacesExisting: boolean;
}

export interface PluginCredentialStatus {
    key: string;
    /** 只回「是否已配置」，**永不返回值** */
    present: boolean;
}

/* ============================== 契约 ============================== */

export interface SystemApi {
    status(): Promise<CoreResult<{
        version: string;
        platform: string;
        dbPath: string;
        dataDir: string;
        pluginRuntime: string;
        counts: {plugins: number; favorites: number; tracks: number; downloads: number};
    }>>;
    paths(): Promise<CoreResult<{
        data: string;
        cache: string;
        plugins: string;
        skins: string;
        downloads: string;
        logs: string;
    }>>;
    /** 在系统文件管理器中打开某个路径（诊断/下载页用） */
    reveal(input: {path: string}): Promise<CoreResult<void>>;
}

export interface CatalogApi {
    /** 跨源聚合检索：核心负责去重与候选排序，`candidates` 顺序即优先级 */
    search(query: {keyword: string; sources?: string[]; minQuality?: TrackQuality} & PageQuery)
        : Promise<CoreResult<Page<GroupedTrack>>>;
    charts(input: {chart: ChartType; period: Period; date?: DateSelection; sources?: string[]; limit?: number})
        : Promise<CoreResult<ChartResult>>;
    track(input: {ref: string}): Promise<CoreResult<GroupedTrack | null>>;
    album(input: {id: string}): Promise<CoreResult<Album | null>>;
    curated(input: {id: string}): Promise<CoreResult<CuratedPlaylist | null>>;
    /** 无歌词返回 `data: null`，不是错误 */
    lyrics(input: {ref: string; source?: string; withTranslation?: boolean}): Promise<CoreResult<Lyrics | null>>;
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
        scan(input: {dirs: string[]; recursive?: boolean}): Promise<CoreResult<{added: number; updated: number; removed: number}>>;
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
        : Promise<CoreResult<ResolvedSource | null>>;
    report(input: {ref: TrackRef; source: string; quality: TrackQuality; playedSec: number; completed: boolean})
        : Promise<CoreResult<void>>;
}

export interface PluginApi {
    list(): Promise<CoreResult<PluginInfo[]>>;
    /** 安装前展示清单、权限与凭据需求，由用户显式同意 */
    preview(input: {from: ImportSource}): Promise<CoreResult<PluginImportPreview>>;
    /** `consent: true` 表示用户已确认权限；核心只在此时落盘 */
    import(input: {from: ImportSource; consent: true}): Promise<CoreResult<PluginInfo>>;
    remove(input: {id: string; deleteFiles?: boolean}): Promise<CoreResult<void>>;
    setEnabled(input: {id: string; enabled: boolean}): Promise<CoreResult<PluginInfo>>;
    /** 数值越小越优先；决定 `playback.resolve` 的回退顺序 */
    setPriority(input: {id: string; priority: number}): Promise<CoreResult<void>>;
    /** 仅对「URL / 压缩包」导入的插件有效：本地目录由用户自行更新 */
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
