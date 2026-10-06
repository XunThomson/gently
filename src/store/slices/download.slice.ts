import {libraryService} from '../../services';
import {formatSizeMb} from '../../utils/helpers';
import type {DownloadActions, DownloadState, StoreCtx} from '../types';

/** 每秒推进的下载进度（mock 引擎速度） */
const PROGRESS_PER_TICK = 0.03;
/** 曲目时长 → 文件大小（MB）的粗略估算 */
const sizeOf = (durationSec: number) => Math.max(1, Math.round((durationSec / 30) * 10) / 10);

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

            const totalMb = sizeOf(track.durationSec);
            patch({
                tasks: [
                    {
                        id: `dl:${track.id}`,
                        track,
                        status: 'pending',
                        progress: 0,
                        totalMb,
                        sizeText: formatSizeMb(0, totalMb),
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

        /** 推进所有「下载中」的任务；在同一帧内批量更新，避免多次通知 */
        tick() {
            const {tasks} = ctx.getState().download;
            if (!tasks.some((task) => task.status === 'downloading')) return;

            patch({
                tasks: tasks.map((task) => {
                    if (task.status !== 'downloading') return task;

                    const progress = Math.min(1, task.progress + PROGRESS_PER_TICK);
                    const done = progress >= 1;
                    const speedMb = (PROGRESS_PER_TICK * task.totalMb).toFixed(1);

                    return {
                        ...task,
                        progress,
                        status: done ? 'done' : 'downloading',
                        sizeText: formatSizeMb(progress * task.totalMb, task.totalMb),
                        speedText: done ? undefined : `${speedMb}Mb/s`,
                    };
                }),
            });
        },
    };

    return {key: 'download' as const, state, actions};
}
