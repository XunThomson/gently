import {appConfig} from '../../config/app.config';
import {catalogService, libraryService, recommendService} from '../../services';
import type {RecommendActions, RecommendState, StoreCtx} from '../types';

/**
 * 推荐切片：**两类推荐并存**。
 *
 * - `bundle`：本机画像推荐（`recommend.home`）——从播放史 + 收藏打分，给「因为你听过 X」的理由；
 * - `sourceTracks`：**源侧推荐**（`catalog.recommend`）——当前音源自己的 `getRecommend`
 *   （插件知道自己的榜单与热度，这是我们算不出来的）。
 *
 * 两者不重叠也不互相替代：前者是本机理解，后者是源的编辑推荐。
 */
export function createRecommendSlice(ctx: StoreCtx) {
    const state: RecommendState = {
        bundle: null,
        loading: false,
        loaded: false,
        sourceTracks: [],
        sourceId: null,
        sourceLoading: false,
        sourceLoaded: false,
    };

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

    /**
     * 拉源侧推荐。
     *
     * 源可能没有 `getRecommend`（能力探测回 `common.not_implemented`）或直接跑挂——
     * 两种都只是「这个源没有推荐」，退回空列表、不打扰用户
     * （`fetchRecommendFrom` 与 `coreRecommend` 已经这么约定；界面按空态呈现）。
     */
    const loadSource = async (force = false) => {
        const current = ctx.getState().recommend;
        if (current.sourceLoading) return;
        if (current.sourceLoaded && !force) return;

        const sourceId = catalogService.defaultSourceId();
        patch({sourceLoading: true, sourceId});
        try {
            const tracks = await catalogService.fetchRecommendFrom(appConfig.list.recommendSourceLimit, sourceId);
            patch({sourceTracks: tracks, sourceLoading: false, sourceLoaded: true});
        } catch (err) {
            console.error('[recommend] 源侧推荐失败', err);
            patch({sourceTracks: [], sourceLoading: false, sourceLoaded: true});
        }
    };

    const actions: RecommendActions = {
        load,
        loadSource,

        /**
         * 不喜欢这条推荐。
         *
         * `skip` + `progress: 0` 是契约里唯一的**显式负反馈**动作（核心只把 `< 0.5` 的跳过当负信号，
         * 见 `build_taste`）；上报后立刻把条目从列表里去掉——用户的动作必须马上看得见，
         * 而不是等下一次重新生成才生效。
         */
        dislike(track) {
            void libraryService.recommendFeedback(track, 'skip', 0);
            const {bundle, sourceTracks} = ctx.getState().recommend;
            patch({
                ...(bundle
                    ? {bundle: {...bundle, tracks: bundle.tracks.filter((item) => item.id !== track.id)}}
                    : {}),
                sourceTracks: sourceTracks.filter((item) => item.id !== track.id),
            });
        },
    };

    return {key: 'recommend' as const, state, actions};
}
