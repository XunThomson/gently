import type {
    ChartType,
    DateSelection,
    Period,
    PluginInfo,
    ResolvedSource,
    SongRow,
    Track,
    TrackQuality,
} from '../types';

/** 榜单查询参数 */
export interface ChartQuery {
    chart: ChartType;
    period: Period;
    date: DateSelection;
    /** 稳定数据 / 缓存键 */
    dateKey: string;
}

/**
 * 音乐源插件契约。
 *
 * 任何数据源（内置 mock、B 站、网易云…）都实现该接口，
 * 通过 `registerMusicSource` 接入；UI 只依赖 `services/` 门面，不感知具体实现。
 *
 * 关于「同一首歌多音源」：
 * - 每个源独立返回自己的曲目（`track.source` 为源 id）；
 * - 聚合展示由 `utils/track.groupTracks` 完成；
 * - 播放时按候选顺序调用 `resolveUrl`，返回 `null` 表示该曲目在该源不可播，
 *   调用方据此自动切换到下一个候选音源。
 */
export interface MusicSourcePlugin {
    readonly info: PluginInfo;
    /** 该音源支持的音质档位（由高到低） */
    readonly qualities: readonly TrackQuality[];
    /** 榜单数据 */
    fetchChart(query: ChartQuery): Promise<SongRow[]>;
    /** 推荐 */
    fetchRecommend(limit: number): Promise<Track[]>;
    /** 搜索 */
    search(keyword: string): Promise<Track[]>;
    /** 解析可播放地址；`quality` 为期望档位，实际档位见返回值 */
    resolveUrl(track: Track, quality: TrackQuality): Promise<ResolvedSource | null>;
}
