/**
 * 全局领域模型。
 * 仅存放跨模块共享的纯数据类型，不含 React / 状态 / 服务逻辑。
 */

/* ============================== 榜单 ============================== */

export type ChartType = 'hot' | 'new' | 'rise' | 'origin';
export type Period = 'day' | 'week' | 'month' | 'year';

export interface DateSelection {
    year: number;
    month: number;
    day: number;
}

export interface SongRow {
    title: string;
    artist: string;
    album: string;
    dur: string;
    heat: number;
}

export interface WeekOption extends DateSelection {
    label: string;
    range: string;
    isCurrent: boolean;
}

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
    /** 封面渐变（无封面图时的占位） */
    gradient: string;
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
    /** 0 ~ 1 */
    progress: number;
    /** 已下载 / 总大小，如 3.0Mb/4.12Mb */
    sizeText: string;
    speedText?: string;
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

/* ============================== 歌词 ============================== */

export interface LyricLine {
    /** 该行开始时间（秒） */
    time: number;
    text: string;
}
