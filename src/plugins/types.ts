import type {ChartType, DateSelection, Period, PluginInfo, SongRow, Track} from '../types';

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
 */
export interface MusicSourcePlugin {
    readonly info: PluginInfo;
    /** 榜单数据 */
    fetchChart(query: ChartQuery): Promise<SongRow[]>;
    /** 推荐 */
    fetchRecommend(limit: number): Promise<Track[]>;
    /** 搜索 */
    search(keyword: string): Promise<Track[]>;
    /** 解析可播放地址；纯 UI 阶段允许返回 null */
    resolveUrl(track: Track): Promise<string | null>;
}
