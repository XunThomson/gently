import {libraryService} from '../../services';
import type {DownloadActions, DownloadState, StoreCtx} from '../types';

/** 下载任务切片 */
export function createDownloadSlice(ctx: StoreCtx) {
    const state: DownloadState = {tasks: [], loaded: false};

    const patch = (partial: Partial<DownloadState>) => {
        ctx.setState({download: {...ctx.getState().download, ...partial}});
    };

    const updateTask = (
        id: string,
        updater: (task: DownloadState['tasks'][number]) => DownloadState['tasks'][number],
    ) => {
        patch({tasks: ctx.getState().download.tasks.map((t) => (t.id === id ? updater(t) : t))});
    };

    const actions: DownloadActions = {
        async load() {
            if (ctx.getState().download.loaded) return;
            const tasks = await libraryService.loadDownloads();
            patch({tasks, loaded: true});
        },

        /** 已存在的曲目不重复入队 */
        add(track) {
            const {tasks} = ctx.getState().download;
            if (tasks.some((task) => task.track.id === track.id)) return;

            patch({
                tasks: [
                    {
                        id: `dl:${track.id}`,
                        track,
                        status: 'pending',
                        progress: 0,
                        sizeText: `0.0Mb/${(track.durationSec / 30).toFixed(1)}Mb`,
                    },
                    ...tasks,
                ],
            });
        },

        remove(id) {
            patch({tasks: ctx.getState().download.tasks.filter((t) => t.id !== id)});
        },

        pause(id) {
            updateTask(id, (t) =>
                t.status === 'downloading' ? {...t, status: 'paused', speedText: undefined} : t,
            );
        },

        resume(id) {
            updateTask(id, (t) =>
                t.status === 'paused' || t.status === 'error' || t.status === 'pending'
                    ? {...t, status: 'downloading', speedText: '1.0Mb/s'}
                    : t,
            );
        },

        clearFinished() {
            patch({tasks: ctx.getState().download.tasks.filter((t) => t.status !== 'done')});
        },
    };

    return {key: 'download' as const, state, actions};
}
