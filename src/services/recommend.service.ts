import {appConfig} from '../config/app.config';
import {buildAlbums, CURATED_PLAYLISTS, discoveryPool} from '../mock/catalog.mock';
import type {RecommendationBundle, RecentTrack, Track} from '../types';
import {buildTasteProfile, rankAlbums, rankPlaylists, rankTracks} from '../utils/recommend';

/**
 * 个性化推荐门面。
 *
 * 目前全部在本地完成：由最近播放 + 收藏聚合口味画像，再对候选池打分排序。
 * 接入后端后，只需把 `build` 换成调用个性化接口（返回同样的 `RecommendationBundle`）。
 */

const delay = (ms: number = appConfig.latency.sourceMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

export const recommendService = {
    /** 刷新推荐结果 */
    async suggest(input: {recent: RecentTrack[]; favorites: Track[]}): Promise<RecommendationBundle> {
        await delay();

        const profile = buildTasteProfile(input);

        // 排除最近听过的，避免推荐里全是刚播放过的歌
        const excludeIds = new Set(input.recent.slice(0, 5).map((track) => track.id));

        return {
            profile,
            tracks: rankTracks(
                discoveryPool(),
                profile,
                appConfig.list.recommendLimit,
                excludeIds,
            ),
            albums: rankAlbums(buildAlbums(), profile, appConfig.list.albumLimit),
            playlists: rankPlaylists(CURATED_PLAYLISTS, profile, appConfig.list.playlistLimit),
        };
    },
};
