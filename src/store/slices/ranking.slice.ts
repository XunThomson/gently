import {catalogService} from '../../services';
import {thisMonday, toDateKey, today} from '../../utils/date';
import type {RankingActions, RankingState, StoreCtx} from '../types';

/**
 * 榜单切片：查询条件 + 榜单数据。
 * 条件变化后由 `load()` 统一从曲库门面拉取。
 *
 * 周榜按产品约定只展示「本周」，因此 `weekStart` 固定为初始化时的本周一，
 * 不提供修改入口（对应的 action 未实现，避免留下无人调用的 API）。
 */
export function createRankingSlice(ctx: StoreCtx) {
    const state: RankingState = {
        chart: 'hot',
        period: 'day',
        date: today(),
        weekStart: thisMonday(),
        expanded: false,
        query: '',
        rows: [],
        loading: false,
    };

    /** 正在进行的请求键：避免同一条件重复请求（含 StrictMode 双调用） */
    let inflight: string | null = null;

    const patch = (partial: Partial<RankingState>) => {
        ctx.setState({ranking: {...ctx.getState().ranking, ...partial}});
    };

    const load = async () => {
        const {chart, period, date, weekStart} = ctx.getState().ranking;
        const {sourceFilter} = ctx.getState().ui;
        const dateKey = toDateKey(period, date, weekStart);
        const requestKey = `${chart}|${period}|${dateKey}|${sourceFilter}`;

        if (inflight === requestKey) return;
        inflight = requestKey;

        patch({loading: true});
        try {
            // 榜单按音源提供：选中某个音源时只看它的榜，'all' 时用优先级最高的音源
            const rows = await catalogService.fetchChart(
                {chart, period, date, dateKey},
                sourceFilter === 'all' ? undefined : sourceFilter,
            );
            patch({rows, loading: false});
        } catch (err) {
            console.error('[ranking] 榜单加载失败', err);
            patch({rows: [], loading: false});
        } finally {
            if (inflight === requestKey) inflight = null;
        }
    };

    const actions: RankingActions = {
        setChart(chart) {
            patch({chart, expanded: false});
            return load();
        },
        setPeriod(period) {
            patch({period, expanded: false});
            return load();
        },
        setDate(date) {
            patch({date, expanded: false});
            return load();
        },
        toggleExpanded() {
            patch({expanded: !ctx.getState().ranking.expanded});
        },
        setQuery(query) {
            patch({query});
        },
        load,
    };

    return {key: 'ranking' as const, state, actions};
}
