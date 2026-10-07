import type {
    Album,
    CuratedPlaylist,
    LyricLine,
    PluginInfo,
    RecommendationBundle,
    SongRow,
    Track,
} from '../types';
import type {
    ApiResult,
    ChartRequest,
    DownloadCreateRequest,
    DownloadTaskDto,
    FavoriteDelta,
    LyricsPayload,
    Page,
    PageQuery,
    PlaybackResolveRequest,
    PlaybackResolveResponse,
    PlaylistPayload,
    PluginInstallRequest,
    PluginSummary,
    SearchQuery,
    TrackRef,
    UserProfile,
} from './types';

/**
 * 后端接口契约（**只有规范，没有实现**）。
 *
 * 约定：
 * - 所有方法返回 `ApiResult<T>`，不抛异常；网络/超时同样以 `ok: false` 表达；
 * - 所有「列表」类接口使用游标分页（`PageQuery` / `Page<T>`）；
 * - 领域模型复用前端 `src/types` 的既有类型，避免两套模型漂移；
 * - 写操作需要幂等键（`FavoriteDelta.idempotencyKey` 等），保证重试安全。
 *
 * 实现落点：接入时只需在 `src/services/**` 内把 mock 换成这些调用，
 * UI 与 store 不需要改动（见 docs/contracts/backend-api.md 的映射表）。
 */

/* ============================== 认证 ============================== */

export interface AuthApi {
    /** 账号密码 / 验证码登录，返回访问令牌 */
    login(input: {
        account: string;
        password?: string;
        /** 短信/邮箱验证码登录时使用 */
        code?: string;
    }): Promise<ApiResult<{accessToken: string; refreshToken: string; expiresInSec: number}>>;

    refresh(input: {refreshToken: string}): Promise<ApiResult<{accessToken: string; expiresInSec: number}>>;

    logout(): Promise<ApiResult<void>>;

    profile(): Promise<ApiResult<UserProfile>>;
}

/* ============================== 曲库：搜索 / 榜单 / 歌词 ============================== */

export interface CatalogApi {
    /** 多音源聚合搜索：后端负责去重与候选音源合并 */
    search(query: SearchQuery): Promise<ApiResult<Page<Track>>>;

    /** 榜单：按音源返回；`sources` 为空时后端按优先级选择 */
    charts(input: ChartRequest): Promise<ApiResult<SongRow[]>>;

    /** 单曲详情（含所属专辑、可用音质） */
    trackDetail(ref: TrackRef): Promise<ApiResult<Track>>;

    /** 专辑详情 */
    album(id: string): Promise<ApiResult<Album>>;

    /** 精选歌单详情 */
    curatedPlaylist(id: string): Promise<ApiResult<CuratedPlaylist>>;

    /** 歌词：优先返回 LRC，按需附带翻译 */
    lyrics(input: {ref: TrackRef; format?: 'lrc' | 'plain'; withTranslation?: boolean})
        : Promise<ApiResult<LyricsPayload>>;

    /** 纯文本行（前端已对齐的时间轴模型，便于直接渲染） */
    lyricsLines(input: {ref: TrackRef}): Promise<ApiResult<LyricLine[]>>;
}

/* ============================== 用户数据：收藏 / 歌单 / 历史 ============================== */

export interface UserLibraryApi {
    favorites(query: PageQuery): Promise<ApiResult<Page<Track>>>;

    /** 增量同步收藏：批量、幂等，适合离线队列重放 */
    syncFavorites(delta: FavoriteDelta): Promise<ApiResult<{applied: number}>>;

    playlists(query: PageQuery): Promise<ApiResult<Page<CuratedPlaylist>>>;

    /** 创建或更新（带 id 为更新） */
    savePlaylist(payload: PlaylistPayload): Promise<ApiResult<CuratedPlaylist>>;

    deletePlaylist(input: {id: string; idempotencyKey: string}): Promise<ApiResult<void>>;

    /** 播放历史：支持增量上报与分页拉取 */
    pushHistory(input: {
        idempotencyKey: string;
        entries: {track: TrackRef; playedAt: string}[];
    }): Promise<ApiResult<{accepted: number}>>;

    history(query: PageQuery): Promise<ApiResult<Page<{track: Track; playedAt: string}>>>;
}

/* ============================== 个性化推荐 ============================== */

export interface RecommendApi {
    /** 首页推荐：一次返回画像 + 单曲 / 专辑 / 歌单区块，减少往返 */
    home(input?: {limit?: number; refresh?: boolean}): Promise<ApiResult<RecommendationBundle>>;

    /** 相似推荐（以某首歌/某张专辑为种子） */
    similar(input: {seed: TrackRef | {albumId: string}; limit?: number})
        : Promise<ApiResult<Track[]>>;

    /** 上报反馈，用于在线学习（跳过 / 收藏 / 完整播放） */
    feedback(input: {
        track: TrackRef;
        action: 'skip' | 'like' | 'unlike' | 'complete';
        /** 播放进度 0~1，用于判断是否完整播放 */
        progress?: number;
    }): Promise<ApiResult<void>>;
}

/* ============================== 播放与音源 ============================== */

export interface PlaybackApi {
    /**
     * 解析可播放地址。
     * 后端承担「多音源自动回退」：按用户优先音源与音质依次尝试，
     * 全部失败返回 `ok: true, data: null`（而不是错误），前端据此退回模拟时钟。
     */
    resolve(input: PlaybackResolveRequest): Promise<ApiResult<PlaybackResolveResponse | null>>;

    /** 上报播放事件（计费/统计/推荐画像） */
    report(input: {
        track: TrackRef;
        /** 实际播放秒数 */
        playedSec: number;
        quality: string;
        source: string;
    }): Promise<ApiResult<void>>;
}

/* ============================== 音源插件市场 ============================== */

export interface PluginApi {
    list(): Promise<ApiResult<PluginSummary[]>>;

    install(input: PluginInstallRequest): Promise<ApiResult<PluginSummary>>;

    uninstall(input: {id: string; idempotencyKey: string}): Promise<ApiResult<void>>;

    /** 检查更新；返回空数组表示全部为最新 */
    checkUpdates(input: {ids?: string[]}): Promise<ApiResult<PluginSummary[]>>;

    /** 用户级插件配置（启用状态、优先级、自定义参数） */
    getConfig(input: {id: string}): Promise<ApiResult<Record<string, unknown>>>;

    saveConfig(input: {id: string; config: Record<string, unknown>}): Promise<ApiResult<void>>;

    /** 兼容前端现有的 PluginInfo 列表（聚合上述信息） */
    listAsPluginInfo(): Promise<ApiResult<PluginInfo[]>>;
}

/* ============================== 下载管理 ============================== */

export interface DownloadApi {
    list(query: PageQuery): Promise<ApiResult<Page<DownloadTaskDto>>>;

    create(input: DownloadCreateRequest): Promise<ApiResult<DownloadTaskDto>>;

    pause(input: {id: string}): Promise<ApiResult<DownloadTaskDto>>;

    resume(input: {id: string}): Promise<ApiResult<DownloadTaskDto>>;

    remove(input: {id: string; deleteFile: boolean}): Promise<ApiResult<void>>;

    clearFinished(): Promise<ApiResult<{removed: number}>>;
}

/* ============================== 皮肤市场 ============================== */

export interface SkinApi {
    /** 皮肤市场列表，可按标签过滤 */
    list(input?: PageQuery & {tags?: string[]}): Promise<ApiResult<Page<import('../theme').ThemeSkin>>>;

    get(id: string): Promise<ApiResult<import('../theme').ThemeSkin>>;

    /** 发布/更新自己的皮肤 */
    publish(skin: import('../theme').ThemeSkin): Promise<ApiResult<{id: string; version: string}>>;

    /** 用户已安装的皮肤（用于跨设备同步） */
    installed(): Promise<ApiResult<import('../theme').ThemeSkin[]>>;

    syncInstalled(skins: import('../theme').ThemeSkin[]): Promise<ApiResult<{applied: number}>>;
}

/* ============================== 聚合入口 ============================== */

/** 后端能力总入口：实现方需完整实现（当前尚无实现） */
export interface GentlyApi {
    auth: AuthApi;
    catalog: CatalogApi;
    library: UserLibraryApi;
    recommend: RecommendApi;
    playback: PlaybackApi;
    plugin: PluginApi;
    download: DownloadApi;
    skin: SkinApi;
}

/** 客户端工厂签名：`createApiClient(options)` 由后端接入时实现 */
export type ApiClientFactory = (options: import('./types').ApiClientOptions) => GentlyApi;
