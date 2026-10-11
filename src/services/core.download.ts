/**
 * 核心侧「下载」的前端门面。
 *
 * 与 `core.catalog.ts` 的分工一致：命令走 `core.bridge`，**事件订阅**在这里适配成回调
 * （下载进度是长任务，只能靠事件推进），无宿主时全部是安全空操作。
 */

import type {CoreResult} from '../api';
import type {DownloadTask, TrackQuality, Track} from '../types';
import {coreAvailable, invokeCore} from './core.bridge';
import {CORE_EVENTS} from './core.events';
import {trackRefOf} from './core.library';

/** 下载事件回调（`download:progress` / `download:done` / `download:error`）。 */
export interface DownloadHandlers {
    onProgress?: (payload: {id: string; received: number; total?: number; speed?: number}) => void;
    onDone?: (payload: {id: string; path: string; bytes: number}) => void;
    onError?: (payload: {id: string; code: string; message: string}) => void;
}

/** 订阅一个核心事件；无核心时是安全的空操作。 */
async function listenCore<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!coreAvailable()) return () => undefined;
    const {listen} = await import('@tauri-apps/api/event');
    return listen<T>(event, (message) => handler(message.payload));
}

/**
 * 下载是否由本机核心持有。
 *
 * store 用它决定「要不要跑 mock 的进度模拟」：`loadDownloads()` 在浏览器里
 * 也会返回 mock 任务（非 null），所以**不能**用「有没有任务」来判断核心在不在管。
 */
export function coreDownloadsAvailable(): boolean {
    return coreAvailable();
}

/**
 * 建下载任务。
 *
 * 返回**信封**而不是 `null | 任务`：核心为什么拒绝（插件未安装、解析不到地址）必须能到界面上——
 * 只说「拿不到任务」会让「点了下载没反应」变成一句都说不出的 bug。
 * 浏览器（无核心）返回 `common.unsupported_platform` 失败，调用方据此走模拟进度。
 */
export function coreCreateDownload(
    track: Track,
    quality: TrackQuality = 'standard',
    dir?: string,
): Promise<CoreResult<DownloadTask>> {
    return invokeCore<DownloadTask>('download.create', {
        ref: trackRefOf(track),
        quality,
        ...(dir ? {dir} : {}),
        // 曲目快照：任务列表在插件被卸载后仍能显示歌名
        track,
    });
}

/** 统一的单任务命令包装：无核心时返回 `{ok: false}`（调用方忽略即可） */
function taskCommand(command: string, id: string): Promise<CoreResult<DownloadTask>> {
    return invokeCore<DownloadTask>(command, {id});
}

export function corePauseDownload(id: string): Promise<CoreResult<DownloadTask>> {
    return taskCommand('download.pause', id);
}

export function coreResumeDownload(id: string): Promise<CoreResult<DownloadTask>> {
    return taskCommand('download.resume', id);
}

export function coreRemoveDownload(id: string, deleteFile = false): Promise<CoreResult<unknown>> {
    return invokeCore('download.remove', {id, deleteFile});
}

export function coreClearFinishedDownloads(): Promise<CoreResult<unknown>> {
    return invokeCore('download.clearFinished', {});
}

/**
 * 订阅下载事件；返回退订函数。
 *
 * 无核心时返回空操作（mock 下载由 store 的定时器推进），因此浏览器预览行为不变。
 */
export async function coreListenDownloads(handlers: DownloadHandlers): Promise<() => void> {
    if (!coreAvailable()) return () => undefined;
    const unlisteners = await Promise.all([
        listenCore<{id: string; received: number; total?: number; speed?: number}>(
            CORE_EVENTS['download:progress'],
            (payload) => handlers.onProgress?.(payload),
        ),
        listenCore<{id: string; path: string; bytes: number}>(CORE_EVENTS['download:done'], (payload) =>
            handlers.onDone?.(payload),
        ),
        listenCore<{id: string; code: string; message: string}>(CORE_EVENTS['download:error'], (payload) =>
            handlers.onError?.(payload),
        ),
    ]);
    return () => {
        for (const unlisten of unlisteners) unlisten();
    };
}
