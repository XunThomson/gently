/**
 * 后端接口的通用原语。
 *
 * 本目录只定义**规范与类型**，不含业务实现：
 * 真正的 HTTP 客户端由后端确定后接入，前端各 `services/*` 门面是唯一的替换点。
 */

/* ============================== 传输约定 ============================== */

/** 统一错误模型 */
export interface ApiError {
    /** 机器可读错误码，如 `auth.token_expired` / `catalog.not_found` */
    code: string;
    /** 面向开发者的说明（不直接展示给用户） */
    message: string;
    /** 结构化细节，如字段校验结果 */
    details?: Record<string, unknown>;
}

/**
 * 统一返回：不抛异常，调用方显式处理失败分支。
 * 好处是错误处理不会被 try/catch 漏掉，也便于统一埋点。
 */
export type ApiResult<T> =
    | {ok: true; data: T; requestId: string}
    | {ok: false; error: ApiError; requestId: string};

/** 游标分页（不用 offset，避免翻页时数据漂移） */
export interface PageQuery {
    /** 1~200，默认 30 */
    limit?: number;
    /** 上一页返回的 cursor */
    cursor?: string;
}

export interface Page<T> {
    items: T[];
    /** 首页返回、末页为 undefined */
    nextCursor?: string;
    hasMore: boolean;
    /** 可选：用于 UI 显示「共 N 条」 */
    total?: number;
}

export type SortOrder = 'asc' | 'desc';

/** 客户端配置 */
export interface ApiClientOptions {
    baseUrl: string;
    /** 取当前访问令牌；返回 null 表示未登录 */
    getAccessToken?: () => string | null;
    /** 单次请求超时（毫秒），默认 15000 */
    timeoutMs?: number;
    /** 附加请求头（如 App 版本、设备 id） */
    headers?: Record<string, string>;
}

/** 预留的错误码常量，便于前后端对齐 */
export const API_ERROR_CODES = {
    unauthorized: 'auth.unauthorized',
    tokenExpired: 'auth.token_expired',
    forbidden: 'auth.forbidden',
    notFound: 'common.not_found',
    invalidArgument: 'common.invalid_argument',
    rateLimited: 'common.rate_limited',
    upstreamFailed: 'source.upstream_failed',
    upgradeRequired: 'common.upgrade_required',
} as const;

/* ============================== 领域模型（接口用） ============================== */

export interface UserProfile {
    id: string;
    nickname: string;
    avatarUrl?: string;
    /** 会员等级等业务字段由后端定义 */
    level?: number;
    createdAt: string;
}

/** 上传/同步用的最小曲目引用：不传完整元数据，避免各端 id 不一致 */
export interface TrackRef {
    /** 统一曲目 id，形如 `source:trackId` */
    id: string;
    /** 数据源（plugin）id */
    source: string;
    /** 该源内的曲目 id */
    sourceTrackId: string;
}

export interface SearchQuery extends PageQuery {
    keyword: string;
    /** 限定音源；缺省表示后端按用户偏好聚合 */
    sources?: string[];
    /** 音质下限过滤 */
    minQuality?: string;
}

export interface ChartRequest {
    chart: string;
    period: string;
    /** `YYYY-MM-DD` / `YYYY-MM` / `YYYY` / 周起始日 */
    date: string;
    sources?: string[];
}

export interface LyricsPayload {
    format: 'lrc' | 'plain';
    content: string;
    /** 是否翻译/罗马音等附加轨道 */
    translated?: string;
}

export interface FavoriteDelta {
    /** 幂等键：同一批次重放不会重复写入 */
    idempotencyKey: string;
    added: TrackRef[];
    removed: TrackRef[];
    /** 客户端发生时间，用于冲突合并（后写覆盖） */
    clientTime: string;
}

export interface PlaylistPayload {
    id?: string;
    name: string;
    description?: string;
    trackRefs: TrackRef[];
}

export interface PlaybackResolveRequest {
    track: TrackRef;
    /** 期望音质；后端可按源能力降级 */
    quality: string;
    /** 客户端网络环境提示，便于后端选择线路 */
    network?: 'wifi' | 'cellular' | 'unknown';
}

export interface PlaybackResolveResponse {
    url: string;
    /** 实际下发的音质（可能低于期望） */
    quality: string;
    /** 链接过期时间（秒） */
    expiresInSec: number;
    /** 实际提供该地址的音源 */
    source: string;
}

/* ============================== 音源插件 ============================== */

export interface PluginSummary {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    homepage?: string;
    /** 内置插件不可卸载 */
    builtin: boolean;
    qualities: string[];
    /** 该插件当前是否可用（服务端探测结果） */
    healthy?: boolean;
}

export interface PluginInstallRequest {
    id: string;
    /** 缺省安装最新版 */
    version?: string;
    /** 是否为用户显式确认的安装 */
    confirmed: boolean;
}

/* ============================== 下载 ============================== */

export interface DownloadCreateRequest {
    track: TrackRef;
    quality: string;
    /** 期望保存目录（相对用户音乐库根目录） */
    relativeDir?: string;
}

export interface DownloadTaskDto {
    id: string;
    track: TrackRef;
    status: 'pending' | 'downloading' | 'paused' | 'done' | 'error';
    progress: number;
    totalBytes: number;
    doneBytes: number;
    error?: ApiError;
}

/* ============================== 实时事件 ============================== */

/**
 * WebSocket / SSE 事件（下载进度、播放状态同步、插件健康变化）。
 * 事件体与上面的 DTO 对齐，避免两套模型。
 */
export type RealtimeEvent =
    | {type: 'download.progress'; payload: DownloadTaskDto}
    | {type: 'download.done'; payload: DownloadTaskDto}
    | {type: 'plugin.health'; payload: PluginSummary}
    | {type: 'session.revoked'; payload: {reason: string}};
