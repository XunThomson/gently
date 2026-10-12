import {catalogService} from '../../services';
import type {RankingActions, RankingState, StoreCtx} from '../types';

/**
 * 榜单/分类切片。
 *
 * **按源渲染**：真实源给的是任意分类树（契约 `catalog.topLists`），因此这里不保存
 * 「热歌/新歌 + 日/周/月」这类固定查询条件，只保存「源 → 分类树 → 选中项 → 已加载页」。
 *
 * `ui.sourceFilter` 变化时由视图触发 `load()` 重新拉树（源换了，分类树也就换了）；
 * `all` 表示「让应用挑一个优先级最高的源」（榜单无法跨源聚合）。
 *
 * **错误如实保留**：源报错（上游失败 / 插件抛错）时记下原始错误，
 * 界面据此区分「这个源没有榜单」与「源跑挂了」——静默吞掉只会让用户看到空列表。
 */
export function createRankingSlice(ctx: StoreCtx) {
    const state: RankingState = {
        sourceId: null,
        groups: [],
        selectedId: null,
        rows: [],
        hasMore: false,
        loading: false,
        loaded: false,
        error: null,
    };

    /** 正在进行的请求键：避免同一条件重复请求（含 StrictMode 双调用） */
    let inflight: string | null = null;

    const patch = (partial: Partial<RankingState>) => {
        ctx.setState({ranking: {...ctx.getState().ranking, ...partial}});
    };

    /** 拉取某个分类的一页；`append` 为 true 时把结果接在已加载列表后面 */
    const fetchPage = async (sourceId: string, itemId: string, page: number, append: boolean) => {
        const requestKey = `${sourceId}|${itemId}|${page}`;
        if (inflight === requestKey) return;
        inflight = requestKey;

        patch({loading: true});
        try {
            const {page: result, error} = await catalogService.fetchTopList(sourceId, itemId, page);
            const previous = append ? ctx.getState().ranking.rows : [];
            patch({
                rows: [...previous, ...result.items],
                hasMore: result.hasMore,
                nextPage: result.nextPage,
                loading: false,
                loaded: true,
                error: error ?? null,
            });
        } catch (err) {
            console.error('[ranking] 榜单加载失败', err);
            patch({rows: append ? ctx.getState().ranking.rows : [], hasMore: false, loading: false, loaded: true});
        } finally {
            if (inflight === requestKey) inflight = null;
        }
    };

    const actions: RankingActions = {
        async load() {
            // 音源清单以 store 的插件列表为准（桌面端来自核心）：榜单是按源的，
            // 选错源就等于拿不到数据，所以这里必须先确保列表就绪再挑源。
            await ctx.getActions().plugin.load();

            const {sourceFilter} = ctx.getState().ui;
            const enabled = ctx.getState().plugin.list.filter((plugin) => plugin.enabled);
            const sourceId: string | null =
                sourceFilter === 'all'
                    ? (enabled[0]?.id ?? catalogService.defaultSourceId())
                    : sourceFilter;

            /**
             * **一个源都没有**：不再往下走。
             *
             * `defaultSourceId()` 现在返回 `null`（以前是抛异常），视图据此显示
             * 「还没有安装任何音源」——继续拉数据只会在空源上报错，把「没装音源」
             * 说成「源跑挂了」。
             */
            if (!sourceId) {
                patch({
                    loading: false,
                    loaded: true,
                    sourceId: null,
                    groups: [],
                    rows: [],
                    selectedId: null,
                    hasMore: false,
                    nextPage: undefined,
                    error: null,
                });
                return;
            }

            // 同一个源已经加载过就不再重复拉（视图在挂载 / 筛选变化时都会调用）
            const current = ctx.getState().ranking;
            if (current.loaded && current.sourceId === sourceId) return;

            patch({
                loading: true,
                sourceId,
                rows: [],
                hasMore: false,
                nextPage: undefined,
                error: null,
            });

            const {groups, error} = await catalogService.fetchTopLists(sourceId);
            // 默认选中第一个分类（树为空说明该源没有提供榜单，视图给空态/错误提示）
            const first = groups.flatMap((group) => group.items)[0] ?? null;
            patch({
                groups,
                selectedId: first?.id ?? null,
                loading: false,
                loaded: true,
                error: error ?? null,
            });

            if (!first) return;
            await fetchPage(sourceId, first.id, 1, false);
        },

        async selectItem(itemId) {
            const {sourceId, selectedId} = ctx.getState().ranking;
            if (!sourceId || itemId === selectedId) return;

            patch({selectedId: itemId, rows: [], hasMore: false, nextPage: undefined, error: null});
            await fetchPage(sourceId, itemId, 1, false);
        },

        async loadMore() {
            const {sourceId, selectedId, hasMore, nextPage} = ctx.getState().ranking;
            if (!sourceId || !selectedId || !hasMore) return;
            // 源没给 `nextPage` 时按「当前页 + 1」推进（协议里 nextPage 可选）
            const page = nextPage ?? 2;
            await fetchPage(sourceId, selectedId, page, true);
        },
    };

    return {key: 'ranking' as const, state, actions};
}
