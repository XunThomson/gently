import {appConfig} from '../../config/app.config';
import {libraryService} from '../../services';
import type {LibraryActions, LibraryState, StoreCtx} from '../types';

/** 本地曲库与最近播放切片 */
export function createLibrarySlice(ctx: StoreCtx) {
    const state: LibraryState = {
        local: [],
        recent: [],
        query: '',
        loaded: false,
        scanning: false,
        scanProgress: null,
        scanSummary: null,
        scanError: null,
    };

    const patch = (partial: Partial<LibraryState>) => {
        ctx.setState({library: {...ctx.getState().library, ...partial}});
    };

    const actions: LibraryActions = {
        async load(options: {force?: boolean} = {}) {
            if (ctx.getState().library.loaded && !options.force) return;
            const [local, recent] = await Promise.all([
                libraryService.loadLocal(),
                libraryService.loadRecent(),
            ]);
            patch({local, recent, loaded: true});
        },

        setQuery(query) {
            patch({query});
        },

        /**
         * 扫描本地目录并入库。
         *
         * 三件事都要做对，否则用户会觉得这个功能是坏的：
         * 1. **订阅进度**（`library:scan:progress`）——扫一个大目录可能要几十秒，
         *    没有反馈就是「卡住了」；订阅失败不影响扫描本身（门面里已兜住）；
         * 2. **把统计结果留下来**——「完成」两个字说明不了任何事，界面要能说出
         *    新增/更新/移除/跳过各多少；
         * 3. **结束后强制重读列表**——扫描的成果必须立刻出现在页面上。
         */
        async scan({dirs, recursive = true}) {
            const clean = dirs.map((dir) => dir.trim()).filter(Boolean);
            if (clean.length === 0) return;

            patch({scanning: true, scanProgress: null, scanSummary: null, scanError: null});

            const unsubscribe = await libraryService.listenScanProgress((progress) => {
                patch({scanProgress: progress});
            });

            try {
                const result = await libraryService.scanLocal(clean, recursive);
                if (!result.ok) {
                    patch({scanError: result.error, scanning: false, scanProgress: null});
                    return;
                }
                patch({scanSummary: result.data, scanning: false, scanProgress: null});
                await actions.load({force: true});
            } finally {
                unsubscribe();
            }
        },

        /**
         * 播放即写入最近播放（**只更新界面**）：按 id 去重后置顶，条数上限由 appConfig 控制。
         *
         * 落库由播放器在「一首歌结束/被切走/暂停/停止」时用 `playback.report` 完成——
         * 那时才知道**实际播成的音源**与真实播放秒数（候选回退后来源可能与这里不同）。
         * 两处若都写核心，同一首歌的播放次数会被记两次。
         */
        recordPlay(track) {
            const {recent} = ctx.getState().library;
            const prev = recent.find((r) => r.id === track.id);
            const next = [
                {...track, playedAt: Date.now(), playCount: (prev?.playCount ?? 0) + 1},
                ...recent.filter((r) => r.id !== track.id),
            ].slice(0, appConfig.list.recentLimit);
            patch({recent: next});
        },

        clearRecent() {
            patch({recent: []});
            void libraryService.clearHistory();
        },

        removeLocal(id) {
            patch({local: ctx.getState().library.local.filter((t) => t.id !== id)});
            // 只移出曲库：删磁盘文件必须由用户在二次确认里明确选择（`deleteFile`）
            void libraryService.removeLocal(id);
        },
    };

    return {key: 'library' as const, state, actions};
}
