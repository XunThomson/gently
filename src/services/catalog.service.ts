import {getActiveMusicSource, type ChartQuery} from '../plugins';
import type {SongRow, Track} from '../types';

/**
 * 在线曲库门面。
 *
 * UI 只与这里交互；具体数据来自「当前启用的音乐源插件」。
 * 后续接入真实音乐源时，只需要新增一个 plugin 实现，本文件无需改动。
 */

/** 榜单结果缓存：同一 (榜单, 时间) 不重复请求 */
const chartCache = new Map<string, SongRow[]>();

export const catalogService = {
    async fetchChart(query: ChartQuery): Promise<SongRow[]> {
        const key = `${query.chart}|${query.dateKey}|${query.period}`;
        const cached = chartCache.get(key);
        if (cached) return cached;

        const rows = await getActiveMusicSource().fetchChart(query);
        chartCache.set(key, rows);
        return rows;
    },

    fetchRecommend(limit = 8): Promise<Track[]> {
        return getActiveMusicSource().fetchRecommend(limit);
    },

    search(keyword: string): Promise<Track[]> {
        return getActiveMusicSource().search(keyword);
    },

    resolveUrl(track: Track): Promise<string | null> {
        return getActiveMusicSource().resolveUrl(track);
    },
};
