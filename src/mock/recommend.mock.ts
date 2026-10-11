import {CURATED_PLAYLISTS, buildAlbums, discoveryPool} from './catalog.mock';
import type {
    RecommendationBundle,
    RecommendationReason,
    RecommendedAlbum,
    RecommendedPlaylist,
    RecommendedTrack,
} from '../types';

/**
 * **预置**推荐数据（浏览器预览用）。
 *
 * 推荐算法已经**只在核心实现一份**（`core/src/recommend.rs`，与旧前端实现同一套行为），
 * 这里刻意不再抄一份打分逻辑——那正是 AGENTS 第 15 条禁止的「同一算法两份实现」。
 * 浏览器里没有核心，就给出形状正确的预置结果，让页面能完整渲染。
 *
 * 桌面端的真实数据来自 `recommend.home`（读本机播放史与收藏）。
 */

const REASONS: RecommendationReason[] = [
    {kind: 'tag', value: '深夜', score: 0.82},
    {kind: 'artist', value: '示例歌手', score: 0.74},
    {kind: 'trending', value: '', score: 0.4},
];

const withReason = <T,>(item: T, index: number): T & {reason: RecommendationReason} => ({
    ...item,
    reason: {...REASONS[index % REASONS.length]},
});

export function mockRecommendBundle(limit = 6): RecommendationBundle {
    const tracks: RecommendedTrack[] = discoveryPool()
        .slice(0, limit)
        .map((track, index) => withReason(track, index));

    const albums: RecommendedAlbum[] = buildAlbums()
        .slice(0, 3)
        .map((album, index) => withReason(album, index));

    const playlists: RecommendedPlaylist[] = CURATED_PLAYLISTS.slice(0, 3).map((playlist, index) =>
        withReason(playlist, index),
    );

    return {
        // 没有核心时画像是空的（界面会显示「多听几首再来」）
        profile: {tags: {}, artists: {}, sampleSize: 0, updatedAt: Date.now()},
        tracks,
        albums,
        playlists,
    };
}
