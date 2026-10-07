import {recommendService} from '../../services';
import type {RecommendActions, RecommendState, StoreCtx} from '../types';

/**
 * 个性化推荐切片。
 *
 * 输入是「用户行为」（最近播放 + 收藏），输出是可直接渲染的区块集合；
 * 计算在 `services/recommend.service.ts`（纯函数在 `utils/recommend.ts`），
 * 接入后端后这里只需换成 `api.recommend.home()`。
 */
export function createRecommendSlice(ctx: StoreCtx) {
    const state: RecommendState = {bundle: null, loading: false, loaded: false};

    const patch = (partial: Partial<RecommendState>) => {
        ctx.setState({recommend: {...ctx.getState().recommend, ...partial}});
    };

    const load = async (force = false) => {
        const current = ctx.getState().recommend;
        if (current.loading) return;
        // 已经算过且未要求刷新时直接复用（默认进入页面即刷新，成本很低）
        if (current.loaded && !force && current.bundle) return;

        // 推荐依赖用户行为：最近播放来自 library，收藏来自 collection
        await Promise.all([
            ctx.getActions().library.load(),
            ctx.getActions().collection.load(),
        ]);

        const {recent} = ctx.getState().library;
        const {favorites} = ctx.getState().collection;
        patch({loading: true});
        try {
            const bundle = await recommendService.suggest({recent, favorites});
            patch({bundle, loading: false, loaded: true});
        } catch (err) {
            console.error('[recommend] 推荐生成失败', err);
            patch({loading: false});
        }
    };

    const actions: RecommendActions = {load};

    return {key: 'recommend' as const, state, actions};
}
