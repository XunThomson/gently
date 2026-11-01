/**
 * 全局领域模型。
 * 仅存放跨模块共享的纯数据类型，不含 React / 状态 / 服务逻辑。
 *
 * 榜单/分类的**结构由源决定**（`TopListGroup` / `TopListPage` 在 `src/api`，
 * 那是本机核心契约的形状），因此这里没有「热歌/新歌」或「日/周/月」这类固定枚举。
 */

/* 清单类型只借形状（`import type` 编译期擦除，不产生运行时循环依赖）：
   插件的「完整摘要」在本机核心那一侧（`PluginSummary extends PluginInfo`），
   前端 store 存的仍是同一份数据，只是把核心多给的字段声明为可选。 */
import type {PluginManifest} from '../api';

/* ============================== 曲目 ============================== */

/** 统一曲目模型：所有视图 / 数据源都使用它 */
export interface Track {
    id: string;
    title: string;
    artist: string;
    album: string;
    /** 展示用时长，mm:ss */
    duration: string;
    durationSec: number;
    /** 数据源（plugin）id */
    source: string;
    /**
     * 封面图地址（插件给的就是它的 `artwork`/`cover`；可能为空）。
     *
     * 为空时用 `gradient` 占位——**渲染统一走 `utils/cover.ts` 的 `coverStyle()`**，
     * 它同时认识图片地址与渐变，视图不需要分支。
     */
    artwork?: string;
    /** 封面渐变（无封面图时的占位） */
    gradient: string;
    /** 风格标签：个性化推荐的基础（mock 由稳定哈希生成） */
    tags: string[];
    /** 所属专辑 id，用于「推荐专辑」与「因为你听过」的关联 */
    albumId?: string;
}

/** 正在播放：在 Track 基础上记录播放序号，用于重置进度条 */
export interface NowPlaying extends Track {
    /** 每次播放自增 */
    playId: number;
}

export type RepeatMode = 'off' | 'all' | 'one';

/* ============================== 下载 ============================== */

export type DownloadStatus = 'pending' | 'downloading' | 'paused' | 'done' | 'error';

export interface DownloadTask {
    id: string;
    track: Track;
    status: DownloadStatus;
    /** 0 ~ 1（总量未知时为 0） */
    progress: number;
    /** 文件总大小（MB），未知为 0 */
    totalMb: number;
    /** 已下载 / 总大小，如「3.0 MB/4.1 MB」（总量未知时只显示已下载） */
    sizeText: string;
    speedText?: string;
    /** 最终落盘路径（先写 `.part`，完成后 rename 到这里） */
    path?: string;
    /** 失败原因（status === 'error' 时有值）——核心给的开发者说明，界面优先用 `errorCode` 走 i18n */
    error?: string;
    /** 失败原因的错误码（`download:error` 事件带 `code`）；界面按码取本地化文案 */
    errorCode?: string;
}

/* ============================== 插件（数据源） ============================== */

export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    /** 是否为内置数据源 */
    builtin: boolean;
    /** 是否启用 */
    enabled: boolean;
    homepage?: string;
    /**
     * 下面几项只在**本机核心**（`plugin.list` 的 `PluginSummary`）里出现，
     * 浏览器预览的内置演示源没有（undefined = 未知，不要当成 false / 0）。
     *
     * 放进同一个类型是刻意的：插件列表的**唯一一份**在 store（全局），
     * 插件页、播放条音源选择器、页面音源筛选都订阅它——再让某个组件自己
     * `plugin.list` 一份，就会出现「导入成功了但列表还在等你重启」（R87 修的 bug）。
     */
    /** 兼容模式插件（ADR-0006）：权限弱于自有 ABI，界面要标出来 */
    compat?: boolean;
    /** 回退优先级：数值越小越优先 */
    priority?: number;
    /** 清单快照（能力、凭据声明、登录声明等管理面板要用） */
    manifest?: PluginManifest;
}

/* ============================== 本地 / 最近播放 ============================== */

export interface LocalTrack extends Track {
    /** 文件路径或虚拟路径 */
    path: string;
    /** 文件大小 */
    sizeText: string;
    addedAt: number;
}

export interface RecentTrack extends Track {
    playedAt: number;
    /** 播放次数 */
    playCount: number;
}

/* ============================== 收藏 / 歌单 ============================== */

export interface Playlist {
    id: string;
    name: string;
    createdAt: number;
    tracks: Track[];
}

/* ============================== 音源与音质 ============================== */

/** 音质档位（由低到高） */
export type TrackQuality = 'standard' | 'high' | 'lossless' | 'hires';

/**
 * 首选音质不可用时往哪边取。
 * - `lower`：退回更低的档位（更省流量，通常也更快）
 * - `higher`：退到更高的档位（宁可文件大一点也要保住音质）
 */
export type DownloadQualityFallback = 'lower' | 'higher';

/** 同一首歌在某个音源下的候选 */
export interface TrackCandidate {
    /** 音源（plugin）id */
    source: string;
    /** 该音源下的具体曲目：专辑/时长等元数据可能略有差异 */
    track: Track;
    /** 该音源支持的音质档位（由高到低） */
    qualities: TrackQuality[];
}

/**
 * 聚合后的逻辑歌曲：一首歌 + 多个音源候选。
 *
 * 视图默认按「歌」展示（避免同一首歌出现多个条目），
 * 播放时在候选中挑可用音源，失败自动切换。
 */
export interface GroupedTrack extends Track {
    candidates: TrackCandidate[];
    /** 候选音源数量 */
    sourceCount: number;
}

/** 音源展示方式：聚合 / 分源 */
export type SourceDisplayMode = 'aggregate' | 'perSource';

/** 页面音源筛选交互样式 */
export type SourceFilterStyle = 'tabs' | 'drawer';

/** 音源解析结果 */
export interface ResolvedSource {
    url: string;
    source: string;
    quality: TrackQuality;
}

/* ============================== 推荐：专辑 / 歌单 / 画像 ============================== */

/** 专辑 */
export interface Album {
    id: string;
    title: string;
    artist: string;
    /** 封面渐变（占位） */
    cover: string;
    year: number;
    /** 风格标签 */
    tags: string[];
    source: string;
    tracks: Track[];
}

/** 编辑精选歌单（与用户自建 Playlist 区分） */
export interface CuratedPlaylist {
    id: string;
    title: string;
    description: string;
    cover: string;
    tags: string[];
    source: string;
    tracks: Track[];
}

/** 推荐理由类型 */
export type RecommendationKind = 'tag' | 'artist' | 'trending' | 'similar';

/** 推荐理由：让「为什么推荐」可解释 */
export interface RecommendationReason {
    kind: RecommendationKind;
    /** 命中的标签 / 歌手 / 参照对象 */
    value: string;
    /** 匹配度 0~1 */
    score: number;
}

export interface RecommendedTrack extends Track {
    reason: RecommendationReason;
}

export interface RecommendedAlbum extends Album {
    reason: RecommendationReason;
}

export interface RecommendedPlaylist extends CuratedPlaylist {
    reason: RecommendationReason;
}

/** 用户口味画像：由播放记录与收藏聚合而来 */
export interface TasteProfile {
    /** 标签 → 权重 */
    tags: Record<string, number>;
    /** 歌手 → 权重 */
    artists: Record<string, number>;
    /** 参与统计的样本量（播放 + 收藏） */
    sampleSize: number;
    updatedAt: number;
}

/** 推荐结果聚合（推荐页一次拿到的全部区块） */
export interface RecommendationBundle {
    profile: TasteProfile;
    tracks: RecommendedTrack[];
    albums: RecommendedAlbum[];
    playlists: RecommendedPlaylist[];
}

/* ============================== 歌词 ============================== */

export interface LyricLine {
    /** 该行开始时间（秒） */
    time: number;
    text: string;
    /** 译文（源带翻译时才有；按同一时间戳对齐） */
    translation?: string;
}
