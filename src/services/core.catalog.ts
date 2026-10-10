/**
 * 核心侧「搜索 + 播放解析」的前端门面。
 *
 * 为什么单独一个文件而不是直接改 `catalog.service.ts`：
 * 核心的搜索是**流式**的（`searchId` + 事件），与现有 mock 门面的同步分页形状不同；
 * 先把「事件订阅 → Promise + 逐源回调」这层适配做扎实并测到，再让 store/视图换用，
 * 可以避免在视图里同时改动数据形状与渲染逻辑。
 *
 * 两条硬约束：
 * 1. **永不抛异常**：无核心（浏览器）时返回 `null`，由调用方决定退回 mock；
 * 2. **streamUrl 是唯一该播放的地址**：`originUrl`/`headers` 只用于展示与排障。
 */

import type {CoreError, CoreResult, ResolvedMedia} from '../api';
import type {GroupedTrack, TrackQuality} from '../types';
import {coreAvailable, invokeCore} from './core.bridge';

/** 搜索时的逐源回调（流式：一个源返回就回调一次）。 */
export interface SearchHandlers {
    /** 某个源返回了原始结果（未跨源合并） */
    onPartial?: (payload: {source: string; tracks: unknown[]; failed?: CoreError}) => void;
}

export interface CoreSearchResult {
    items: GroupedTrack[];
    sources: string[];
    failedSources: string[];
}

/** 事件从核心推来时的原始形状（与契约 §3 一致）。 */
interface PartialPayload {
    searchId: string;
    source: string;
    tracks: unknown[];
    failed?: CoreError;
}

interface DonePayload {
    searchId: string;
    items: GroupedTrack[];
    sources: string[];
    failedSources: string[];
}

/** 订阅一个核心事件；返回退订函数。无核心时是安全的空操作。 */
async function listenCore<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!coreAvailable()) return () => undefined;
    const {listen} = await import('@tauri-apps/api/event');
    const unlisten = await listen<T>(event, (message) => handler(message.payload));
    return unlisten;
}

/**
 * 流式搜索：返回 `searchId` 后立即开始接收事件，
 * `Promise` 在 `catalog.search.done` 到达时以合并结果兑现。
 *
 * `timeoutMs` 是兜底：核心异常退出时不能让 await 永远挂着。
 */
export async function coreSearch(
    keyword: string,
    options: {sources?: string[]; limit?: number; handlers?: SearchHandlers; timeoutMs?: number} = {},
): Promise<CoreSearchResult | null> {
    if (!coreAvailable()) return null;

    const timeoutMs = options.timeoutMs ?? 20_000;
    const started = await invokeCore<{searchId: string; sourceCount: number}>('catalog.search', {
        keyword,
        ...(options.sources ? {sources: options.sources} : {}),
        ...(options.limit ? {limit: options.limit} : {}),
    });
    if (!started.ok) return null;

    const {searchId} = started.data;

    return new Promise<CoreSearchResult | null>((resolve) => {
        const unlisteners: Array<() => void> = [];
        let settled = false;

        const finish = (value: CoreSearchResult | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            for (const unlisten of unlisteners) unlisten();
            resolve(value);
        };

        const timer = window.setTimeout(() => {
            // 超时：取消这次搜索并如实返回 null，调用方据此退回 mock
            void invokeCore('catalog.searchCancel', {searchId});
            finish(null);
        }, timeoutMs);

        void (async () => {
            unlisteners.push(
                await listenCore<PartialPayload>('catalog.search.partial', (payload) => {
                    if (payload.searchId !== searchId) return; // 只处理本次搜索
                    options.handlers?.onPartial?.({
                        source: payload.source,
                        tracks: payload.tracks ?? [],
                        ...(payload.failed ? {failed: payload.failed} : {}),
                    });
                }),
            );
            unlisteners.push(
                await listenCore<DonePayload>('catalog.search.done', (payload) => {
                    if (payload.searchId !== searchId) return;
                    finish({
                        items: payload.items ?? [],
                        sources: payload.sources ?? [],
                        failedSources: payload.failedSources ?? [],
                    });
                }),
            );
        })();
    });
}

export function coreCancelSearch(searchId: string): Promise<CoreResult<unknown>> {
    return invokeCore('catalog.searchCancel', {searchId});
}

/**
 * 解析播放地址：核心按候选顺序回退，全部失败返回 `null`（前端退回模拟时钟）。
 *
 * 只返回 `streamUrl` 对应的播放地址——**前端不要直接播 `originUrl`**：
 * WebView 的 `<audio>` 无法设置 Referer/UA/Cookie，必须走核心的回环代理。
 */
export async function coreResolveUrl(
    reference: string,
    quality: TrackQuality,
    candidates?: string[],
): Promise<{url: string; source: string; quality: string} | null> {
    if (!coreAvailable()) return null;

    const result = await invokeCore<ResolvedMedia | null>('playback.resolve', {
        reference,
        quality,
        ...(candidates && candidates.length > 0 ? {candidates} : {}),
    });
    if (!result.ok || result.data === null) return null;

    const media = result.data;
    return {url: media.streamUrl, source: media.source, quality: media.quality};
}
