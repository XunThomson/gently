import {appConfig} from '../config/app.config';
import {mockRecommendBundle} from '../mock/recommend.mock';
import type {RecommendationBundle, RecentTrack, RecommendedTrack, Track} from '../types';
import {coreAvailable} from './core.bridge';
import {coreRecommendHome, coreRecommendSimilar, type SimilarSeed} from './core.library';

/**
 * 个性化推荐门面。
 *
 * **桌面端：本机核心**（`recommend.home` / `recommend.similar`）——画像由核心按播放史与收藏
 * 聚合（权重、12h 半衰期、可解释理由都在 `core/src/recommend.rs`，只有一份实现），
 * 且**不发起任何外部请求**（ADR-0005）。
 *
 * **浏览器预览：预置数据**（`src/mock/recommend.mock.ts`）——这里刻意不再留第二份打分算法，
 * 避免「同一算法两份实现」；页面形状完全一致，视图不需要分支。
 * 预置数据**只在没有核心时**出现，见 `suggest()`。
 */

const delay = (ms: number = appConfig.latency.sourceMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 诚实的空推荐：核心在却给不出结果时的返回值。
 *
 * 形状与核心返回的 `RecommendationBundle` 完全一致（画像为空、三个区块为空数组），
 * 视图因此不需要分支——画像为空自然会显示 `recommend.profileEmpty`。
 */
const emptyBundle = (): RecommendationBundle => ({
    profile: {tags: {}, artists: {}, sampleSize: 0, updatedAt: Date.now()},
    tracks: [],
    albums: [],
    playlists: [],
});

export interface SuggestInput {
    recent: RecentTrack[];
    favorites: Track[];
}

export const recommendService = {
    /**
     * 刷新推荐结果。
     *
     * **`recommend.home` 返回 `null` 有两种含义**，不能用同一个 fallback：
     * 「没有核心」（浏览器预览 → 用预置数据撑住界面）与「核心在但读失败/没算出来」
     * （→ **如实返回空 bundle**）。核心在却退回 mock 的话，用户看到的是别人的
     * 假播放史与假收藏推出来的歌（AGENTS 第 4 节末行的红线）。
     *
     * 空 bundle 与真实 bundle **同形**（空数组 + 空画像），视图因此走的是同一套渲染：
     * 画像为空时显示 `recommend.profileEmpty`（「多听几首再来」），而不是假曲目。
     */
    async suggest(_input: SuggestInput): Promise<RecommendationBundle> {
        // 桌面端：核心读**本机库**（播放史 + 收藏），因此不需要把 mock 数组传下去
        const viaCore = await coreRecommendHome(appConfig.list.recommendLimit);
        if (viaCore) return viaCore;
        if (coreAvailable()) return emptyBundle();

        await delay();
        return mockRecommendBundle(appConfig.list.recommendLimit);
    },

    /**
     * 相似推荐：核心从本机库找邻居（浏览器端返回空数组——**没有核心就没有这套算法**，
     * 这里不编一份 mock 打分，避免「同一算法两份实现」）。
     */
    async similar(seed: SimilarSeed, limit: number = appConfig.list.recommendLimit): Promise<RecommendedTrack[]> {
        return (await coreRecommendSimilar(seed, limit)) ?? [];
    },
};
