import {
    getActiveMusicSource,
    getMusicSource,
    getMusicSourceQualities,
    listEnabledMusicSources,
    listMusicSourceInfos,
    registerMusicSource,
    setMusicSourceEnabled,
    unregisterMusicSource,
    type ChartQuery,
} from '../plugins';
import type {
    GroupedTrack,
    PluginInfo,
    ResolvedSource,
    SongRow,
    Track,
    TrackQuality,
} from '../types';
import {coreResolveUrl, coreSearch} from './core.catalog';
import {groupTracks, sortCandidates} from '../utils/track';

/**
 * 在线曲库门面。
 *
 * 多音源策略：
 * - **聚合（aggregate）**：向所有已启用音源发起请求，按 (标题, 歌手) 合并成
 *   「一首歌一条」，多个音源作为候选挂在 `candidates` 上 —— 避免同一首歌重复出现；
 * - **分源（perSource）**：只请求指定音源，返回原始条目（不做合并）；
 * - 播放时按候选顺序调用 `resolveUrl`，`null` 表示该源不可播，由播放器自动切换到下一个。
 */

/** 榜单结果缓存：同一 (音源, 榜单, 时间) 不重复请求 */
const chartCache = new Map<string, SongRow[]>();

export const catalogService = {
    /* ---------------- 音源元数据 ---------------- */

    /** 已安装音源（含 enabled 状态），供页面筛选与插件管理复用 */
    listSources(): PluginInfo[] {
        return listMusicSourceInfos();
    },

    /** 已实现且已启用的音源：参与聚合与自动回退的集合 */
    listActiveSources(): PluginInfo[] {
        return listEnabledMusicSources().map((plugin) => ({...plugin.info, enabled: true}));
    },

    setSourceEnabled(id: string, enabled: boolean): void {
        setMusicSourceEnabled(id, enabled);
    },

    /** 卸载音源（内置源由调用方拦截） */
    unregisterSource(id: string): void {
        unregisterMusicSource(id);
    },

    sourceQualities(id: string): readonly TrackQuality[] {
        return getMusicSourceQualities(id);
    },

    /** 注册一个音源（真实插件接入时使用） */
    registerSource(plugin: Parameters<typeof registerMusicSource>[0]): void {
        registerMusicSource(plugin);
    },

    /* ---------------- 榜单（按源提供，聚合模式下取优先级最高的源） ---------------- */

    async fetchChart(query: ChartQuery, sourceId?: string): Promise<SongRow[]> {
        const plugin = (sourceId ? getMusicSource(sourceId) : undefined) ?? getActiveMusicSource();
        const key = `${plugin.info.id}|${query.chart}|${query.dateKey}|${query.period}`;

        const cached = chartCache.get(key);
        if (cached) return cached;

        const rows = await plugin.fetchChart(query);
        chartCache.set(key, rows);
        return rows;
    },

    /* ---------------- 推荐 / 搜索 ---------------- */

    /** 单源推荐 */
    fetchRecommendFrom(limit: number, sourceId?: string): Promise<Track[]> {
        const plugin = (sourceId ? getMusicSource(sourceId) : undefined) ?? getActiveMusicSource();
        return plugin.fetchRecommend(limit);
    },

    /** 单源搜索 */
    searchIn(keyword: string, sourceId?: string): Promise<Track[]> {
        const plugin = (sourceId ? getMusicSource(sourceId) : undefined) ?? getActiveMusicSource();
        return plugin.search(keyword);
    },

    /** 多源推荐 → 聚合去重 */
    async fetchRecommendAll(limit: number): Promise<GroupedTrack[]> {
        return this.aggregate((plugin) => plugin.fetchRecommend(limit));
    },

    /**
     * 多源搜索 → 聚合去重。
     *
     * **桌面宿主优先走本机核心**：核心并发请求各源、逐源推事件、在核心内完成跨源合并
     * （候选顺序 = 优先级）。浏览器预览或核心不可用时返回 null，退回下面的模拟音源路径，
     * 因此这里不需要视图配合，行为与改造前完全一致。
     *
     * 逐源的流式结果（`catalog.search.partial`）留给搜索页的「分源视图」用，
     * 需要 store 增加一个部分结果字段，因此这一步先只接合并结果。
     */
    async searchAll(keyword: string): Promise<GroupedTrack[]> {
        if (!keyword.trim()) return [];

        const viaCore = await coreSearch(keyword);
        if (viaCore) return viaCore.items;

        return this.aggregate((plugin) => plugin.search(keyword));
    },

    /**
     * 并发请求所有已启用音源并按用户偏好排序候选。
     * 单个音源失败不影响整体（`Promise.allSettled`）。
     */
    async aggregate(fetchOne: (plugin: ReturnType<typeof getActiveMusicSource>) => Promise<Track[]>): Promise<GroupedTrack[]> {
        const sources = listEnabledMusicSources();
        if (sources.length === 0) return [];

        const settled = await Promise.allSettled(sources.map((plugin) => fetchOne(plugin)));

        const merged: Track[] = [];
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') merged.push(...result.value);
            else console.warn(`[catalog] 音源 ${sources[index].info.id} 请求失败`, result.reason);
        });

        return groupTracks(merged, (source) => this.sourceQualities(source));
    },

    /** 按用户音源偏好给候选排序（`preferredSource` 为空表示按注册顺序） */
    orderCandidates(track: GroupedTrack, preferredSource?: string | null): GroupedTrack {
        if (!preferredSource) return track;
        return {...track, candidates: sortCandidates(track.candidates, [preferredSource])};
    },

    /* ---------------- 播放地址 ---------------- */

    /**
     * 解析可播放地址；返回 null 表示该曲目在该音源不可播。
     * 自动回退由播放器按候选顺序调用本方法完成。
     */
    async resolveUrl(
        track: Track,
        quality: TrackQuality,
        sourceId?: string,
    ): Promise<ResolvedSource | null> {
        const id = sourceId ?? track.source;

        // 桌面宿主：核心按候选顺序回退，并返回**回环代理**地址
        // （WebView 的 <audio> 无法设置 Referer/UA/Cookie，必须经代理播放）。
        // 核心里没有这个音源时返回 null，继续走下面的模拟音源路径。
        const viaCore = await coreResolveUrl(this.trackRef(id, track), quality);
        if (viaCore) {
            return {url: viaCore.url, source: viaCore.source, quality: viaCore.quality as TrackQuality};
        }

        const plugin = getMusicSource(id);
        if (!plugin) return null;
        return plugin.resolveUrl(track, quality);
    },

    /** 统一曲目引用 `source:rawId`；避免 id 已经带前缀时重复拼接 */
    trackRef(sourceId: string, track: Track): string {
        return track.id.startsWith(`${sourceId}:`) ? track.id : `${sourceId}:${track.id}`;
    },
};
