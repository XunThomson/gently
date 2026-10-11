import {appConfig} from '../config/app.config';
import {mockRecommendBundle} from '../mock/recommend.mock';
import type {RecommendationBundle, RecentTrack, RecommendedTrack, Track} from '../types';
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
 */

const delay = (ms: number = appConfig.latency.sourceMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SuggestInput {
    recent: RecentTrack[];
    favorites: Track[];
}

export const recommendService = {
    /** 刷新推荐结果 */
    async suggest(_input: SuggestInput): Promise<RecommendationBundle> {
        // 桌面端：核心读**本机库**（播放史 + 收藏），因此不需要把 mock 数组传下去
        const viaCore = await coreRecommendHome(appConfig.list.recommendLimit);
        if (viaCore) return viaCore;

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
