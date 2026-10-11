import type {PluginInfo, ResolvedSource, Track, TrackQuality} from '../types';
import type {TopListGroup, TopListPage} from '../api';

/**
 * 音乐源插件契约（**浏览器预览的 mock 兜底**，不是核心的插件 ABI）。
 *
 * 任何数据源（内置 mock、真实插件…）都实现该接口，通过 `registerMusicSource` 接入；
 * UI 只依赖 `services/` 门面，不感知具体实现。
 *
 * 关于「同一首歌多音源」：
 * - 每个源独立返回自己的曲目（`track.source` 为源 id）；
 * - 聚合展示由 `utils/track.groupTracks` 完成；
 * - 播放时按候选顺序调用 `resolveUrl`，返回 `null` 表示该曲目在该源不可播，
 *   调用方据此自动切换到下一个候选音源。
 *
 * 榜单/分类**不假设结构**：`fetchTopLists` 返回的是源自定义的分类树，
 * `fetchTopList` 按分类取一页曲目（与契约的 `catalog.topLists` / `catalog.topList` 同形）。
 */
export interface MusicSourcePlugin {
    readonly info: PluginInfo;
    /** 该音源支持的音质档位（由高到低） */
    readonly qualities: readonly TrackQuality[];
    /** 该音源的榜单/分类树（标题 + 条目，结构由源决定） */
    fetchTopLists(): Promise<TopListGroup[]>;
    /** 某个榜单/分类的一页内容 */
    fetchTopList(id: string, page?: number): Promise<TopListPage>;
    /** 推荐 */
    fetchRecommend(limit: number): Promise<Track[]>;
    /** 搜索 */
    search(keyword: string): Promise<Track[]>;
    /** 解析可播放地址；`quality` 为期望档位，实际档位见返回值 */
    resolveUrl(track: Track, quality: TrackQuality): Promise<ResolvedSource | null>;
}
