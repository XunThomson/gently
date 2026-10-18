/**
 * 核心侧 catalog 域的前端门面：搜索（流式）/ 播放解析 / 详情（曲目·专辑·歌单·榜单·歌词·源侧推荐）。
 *
 * 为什么单独一个文件而不是直接改 `catalog.service.ts`：
 * 核心的搜索是**流式**的（`searchId` + 事件），与现有 mock 门面的同步分页形状不同；
 * 先把「事件订阅 → Promise + 逐源回调」这层适配做扎实并测到，再让 store/视图换用，
 * 可以避免在视图里同时改动数据形状与渲染逻辑。
 *
 * 三条硬约束：
 * 1. **永不抛异常**：无核心（浏览器）时返回 `null`，由调用方决定退回 mock；
 * 2. **streamUrl 是唯一该播放的地址**：`originUrl`/`headers` 只用于展示与排障；
 * 3. **详情失败也是 `null`**：能力缺失（`common.not_implemented`）与插件未启用是常态，
 *    调用方按「该源不提供」处理，不必区分错误码。
 */

import type {CoreError, CoreResult, Lyrics, LyricSearchResult, ResolvedMedia, TopListGroup, TopListPage} from '../api';
import type {Album, CuratedPlaylist, GroupedTrack, Track, TrackQuality} from '../types';
import {coreAvailable, invokeCore} from './core.bridge';
import {CORE_EVENTS} from './core.events';

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
 * `Promise` 在 `catalog:search:done` 到达时以合并结果兑现。
 *
 * `timeoutMs` 是兜底：核心异常退出时不能让 await 永远挂着。
 *
 * `signal` 用于**用户改主意**（换关键词、切换音源、离开页面）：中止时立刻
 * `catalog.searchCancel`，让还没开始调用插件的源线程不要再打网络——
 * 否则用户每敲一个字符，上一轮搜索还在后台继续跑（既有浪费，也可能让慢源拖住后面的搜索）。
 */
export async function coreSearch(
    keyword: string,
    options: {
        sources?: string[];
        limit?: number;
        handlers?: SearchHandlers;
        timeoutMs?: number;
        signal?: AbortSignal;
    } = {},
): Promise<CoreSearchResult | null> {
    if (!coreAvailable()) return null;

    const timeoutMs = options.timeoutMs ?? 20_000;

    return new Promise<CoreSearchResult | null>((resolve) => {
        const unlisteners: Array<() => void> = [];
        let settled = false;
        let searchId: string | null = null;

        /**
         * **先订阅、再发起搜索**，中间窗口收到的事件先入队。
         *
         * 为什么不能反过来（先 `catalog.search` 拿 searchId 再订阅）：本地插件几乎瞬时返回，
         * 核心可能在命令回来后、前端 `listen` 完成前就把 `partial`/`done` 推出来——
         * 事件直接丢掉，这一轮搜索只能等 20s 超时（真实应用里就是这么卡住的：
         * 界面一直显示「加载中」，最后给出 0 条结果）。网络插件慢，所以这个竞态长期没被发现。
         */
        const buffered: Array<
            {kind: 'partial'; payload: PartialPayload} | {kind: 'done'; payload: DonePayload}
        > = [];

        const applyDone = (payload: DonePayload) => {
            if (payload.searchId !== searchId) return;
            finish({
                items: payload.items ?? [],
                sources: payload.sources ?? [],
                failedSources: payload.failedSources ?? [],
            });
        };

        const deliver = (event: (typeof buffered)[number]) => {
            if (searchId === null) {
                buffered.push(event);
                return;
            }
            if (event.kind === 'done') {
                applyDone(event.payload);
                return;
            }
            const payload = event.payload;
            if (payload.searchId !== searchId) return; // 只处理本次搜索
            options.handlers?.onPartial?.({
                source: payload.source,
                tracks: payload.tracks ?? [],
                ...(payload.failed ? {failed: payload.failed} : {}),
            });
        };

        const onAbort = () => {
            if (searchId) void coreCancelSearch(searchId);
            finish(null);
        };

        const finish = (value: CoreSearchResult | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            for (const unlisten of unlisteners) unlisten();
            resolve(value);
        };

        const timer = window.setTimeout(() => {
            // 超时：取消这次搜索并如实返回 null，调用方据此退回 mock
            if (searchId) void coreCancelSearch(searchId);
            finish(null);
        }, timeoutMs);

        options.signal?.addEventListener('abort', onAbort, {once: true});

        void (async () => {
            unlisteners.push(
                await listenCore<PartialPayload>(CORE_EVENTS['catalog:search:partial'], (payload) =>
                    deliver({kind: 'partial', payload}),
                ),
            );
            unlisteners.push(
                await listenCore<DonePayload>(CORE_EVENTS['catalog:search:done'], (payload) =>
                    deliver({kind: 'done', payload}),
                ),
            );

            /* 订阅就绪后才发起搜索；起始就已被中止（换关键词）则不留后台搜索 */
            if (options.signal?.aborted) {
                finish(null);
                return;
            }

            const started = await invokeCore<{searchId: string; sourceCount: number}>('catalog.search', {
                keyword,
                ...(options.sources ? {sources: options.sources} : {}),
                ...(options.limit ? {limit: options.limit} : {}),
            });
            if (!started.ok) {
                finish(null);
                return;
            }

            searchId = started.data.searchId;
            if (options.signal?.aborted) {
                void coreCancelSearch(searchId);
                finish(null);
                return;
            }

            /* 命令期间（甚至更早）到达的事件按序补投 */
            for (const event of buffered.splice(0)) deliver(event);
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
        // 契约里的参数名是 `ref`（核心为了兼容早期写法也接受 `reference`，但前端只用一个名字）
        ref: reference,
        quality,
        ...(candidates && candidates.length > 0 ? {candidates} : {}),
    });
    if (!result.ok || result.data === null) return null;

    const media = result.data;
    return {url: media.streamUrl, source: media.source, quality: media.quality};
}

/** 调用失败时的回调：调用方可以据此区分「没有核心」与「核心报错」。 */
type FailureHandler = (error: CoreError) => void;

/**
 * 详情类命令的统一包装：无核心或核心报错一律返回 `null`，由调用方退回 mock / 空态。
 *
 * **预期内的失败不吵**：`common.not_implemented`（源没实现这个函数）与
 * `common.not_found`（源没装/被禁用）都是正常情况，界面本来就有兜底。
 * 其它错误（插件跑挂、上游失败、参数不合法）必须留下痕迹——
 * 真实排查时踩到过「界面只显示空列表，日志里只有一行 ok=false，谁也判断不出原因」。
 *
 * `onError` 给需要**如实告知用户**的调用方（如榜单页）：拿不到数据时到底是
 * 「这个源没有这个功能」还是「源跑挂了」，只有这里知道。
 */
async function detail<T>(
    command: string,
    params: Record<string, unknown>,
    onError?: FailureHandler,
): Promise<T | null> {
    if (!coreAvailable()) return null;
    const result = await invokeCore<T | null>(command, params);
    if (result.ok) return result.data;

    const {code, message} = result.error;
    if (code !== 'common.not_implemented' && code !== 'common.not_found') {
        console.warn(`[core] ${command} 失败：${code} ${message}`);
        // 「源没实现」「源没装」不是故障，不往界面上抛
        onError?.(result.error);
    }
    return null;
}

/** 曲目详情（`GroupedTrack`：详情来自单源，但形状与搜索结果一致，视图可复用）。 */
export function coreTrackDetail(reference: string): Promise<GroupedTrack | null> {
    return detail<GroupedTrack>('catalog.track', {ref: reference});
}

export function coreAlbum(source: string, id: string): Promise<Album | null> {
    return detail<Album>('catalog.album', {source, id});
}

export function corePlaylist(source: string, id: string): Promise<CuratedPlaylist | null> {
    return detail<CuratedPlaylist>('catalog.playlist', {source, id});
}

/** 源的榜单/分类树：**分类由源自定义**，前端按返回结构渲染，不能假设固定枚举。 */
export async function coreTopLists(
    source: string,
    onError?: FailureHandler,
): Promise<TopListGroup[] | null> {
    return (await detail<TopListGroup[]>('catalog.topLists', {source}, onError)) ?? null;
}

export function coreTopList(
    source: string,
    id: string,
    page?: number,
    onError?: FailureHandler,
): Promise<TopListPage | null> {
    return detail<TopListPage>(
        'catalog.topList',
        {
            source,
            id,
            ...(page && page > 1 ? {page} : {}),
        },
        onError,
    );
}

/** 源侧推荐（`getRecommend`），**不是**我们的个性化推荐（那个读本机播放史）。 */
export async function coreRecommend(source: string): Promise<Track[] | null> {
    return (await detail<Track[]>('catalog.recommend', {source})) ?? null;
}

/** 歌词：无词返回 `null`（不是错误），调用方据此显示「暂无歌词」。 */
export function coreLyrics(reference: string, withTranslation = false): Promise<Lyrics | null> {
    return detail<Lyrics>('catalog.lyrics', {
        ref: reference,
        ...(withTranslation ? {withTranslation: true} : {}),
    });
}

/**
 * 跨源按关键词找歌词（`catalog.lyricsSearch`）。
 *
 * 不用 `detail()`：它把失败吞成 `null`，而歌词搜索失败时界面要显示原因。
 * 无核心时调用方拿到 `available: false` 并如实说明「需要桌面端」。
 */
export function coreLyricsSearch(
    query: string,
    limit?: number,
): Promise<CoreResult<LyricSearchResult>> {
    return invokeCore<LyricSearchResult>('catalog.lyricsSearch', {
        query,
        ...(limit ? {limit} : {}),
    });
}
