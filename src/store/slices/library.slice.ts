import {libraryService} from '../../services';
import type {LibraryActions, LibraryState, StoreCtx} from '../types';

/** 本地曲库与最近播放切片 */
export function createLibrarySlice(ctx: StoreCtx) {
    const state: LibraryState = {
        local: [],
        recent: [],
        query: '',
        loaded: false,
    };

    const patch = (partial: Partial<LibraryState>) => {
        ctx.setState({library: {...ctx.getState().library, ...partial}});
    };

    const actions: LibraryActions = {
        async load() {
            if (ctx.getState().library.loaded) return;
            const [local, recent] = await Promise.all([
                libraryService.loadLocal(),
                libraryService.loadRecent(),
            ]);
            patch({local, recent, loaded: true});
        },

        setQuery(query) {
            patch({query});
        },

        /** 播放即写入最近播放：按 id 去重后置顶，最多保留 100 条 */
        recordPlay(track) {
            const {recent} = ctx.getState().library;
            const prev = recent.find((r) => r.id === track.id);
            const next = [
                {...track, playedAt: Date.now(), playCount: (prev?.playCount ?? 0) + 1},
                ...recent.filter((r) => r.id !== track.id),
            ].slice(0, 100);
            patch({recent: next});
        },

        clearRecent() {
            patch({recent: []});
        },

        removeLocal(id) {
            patch({local: ctx.getState().library.local.filter((t) => t.id !== id)});
        },
    };

    return {key: 'library' as const, state, actions};
}
