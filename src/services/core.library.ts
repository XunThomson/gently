/**
 * 核心侧「本机库」的前端门面：收藏 / 歌单 / 播放历史 / 本地曲库 / 下载。
 *
 * 与 `core.catalog.ts` 同一套约定：
 * 1. **无核心（浏览器）时一律返回 `null`**，由调用方退回 mock——前端必须始终能在浏览器里跑；
 * 2. **写入不抛异常**：桌面端调用核心，浏览器端是安全空操作（`{ok: false}` 由调用方忽略）；
 * 3. 引用统一用 `TrackRef`（`{id, source, sourceTrackId}`），由 `trackRefOf` 从 Track 派生。
 */

import type {CoreResult, LocalScanResult, TrackRef} from '../api';
import type {
    DownloadTask,
    LocalTrack,
    Playlist,
    RecentTrack,
    RecommendationBundle,
    RecommendedTrack,
    Track,
} from '../types';
import {coreAvailable, invokeCore} from './core.bridge';
import {CORE_EVENTS} from './core.events';
import {trackReference} from '../utils/downloadQueue';

/** 从曲目派生统一引用：`id` 是完整引用 `source:trackId`（实现在 `utils/downloadQueue`，全局只有一份）。 */
export function trackRefOf(track: Track): TrackRef {
    const id = trackReference(track);
    return {id, source: track.source, sourceTrackId: id.slice(track.source.length + 1)};
}

interface Page<T> {
    items: T[];
    hasMore: boolean;
    total?: number;
    nextCursor?: string;
}

/** 分页读取：列表命令都返回 `Page<T>`，这里只要第一页（视图按需再翻）。 */
async function readPage<T>(command: string, params: Record<string, unknown>): Promise<T[] | null> {
    if (!coreAvailable()) return null;
    const result = await invokeCore<Page<T>>(command, params);
    return result.ok ? (result.data?.items ?? []) : null;
}

/** 写入：桌面端落到核心，浏览器端安全空操作。 */
async function write(command: string, params: Record<string, unknown>): Promise<CoreResult<unknown>> {
    return invokeCore(command, params);
}

/* ------------------------------ 读 ------------------------------ */

export function coreLoadFavorites(limit = 500): Promise<Track[] | null> {
    return readPage<Track>('library.favorites.list', {limit});
}

export function coreLoadPlaylists(): Promise<Playlist[] | null> {
    if (!coreAvailable()) return Promise.resolve(null);
    return invokeCore<Playlist[]>('library.playlists.list', {}).then((result) =>
        result.ok ? result.data : null,
    );
}

export function coreLoadRecent(limit = 200): Promise<RecentTrack[] | null> {
    return readPage<RecentTrack>('library.history.list', {limit});
}

export function coreLoadLocal(limit = 500, query?: string): Promise<LocalTrack[] | null> {
    return readPage<LocalTrack>('library.local.list', {
        limit,
        ...(query && query.trim() ? {query} : {}),
    });
}

export function coreLoadDownloads(): Promise<DownloadTask[] | null> {
    if (!coreAvailable()) return Promise.resolve(null);
    return invokeCore<DownloadTask[]>('download.list', {}).then((result) =>
        result.ok ? result.data : null,
    );
}

/* ------------------------------ 写 ------------------------------ */

/**
 * 收藏/取消收藏。`track` 是**曲目快照**：本机库存快照而不是引用，
 * 因此插件被卸载后收藏列表仍能显示（核心侧语义，见契约 §4）。
 */
export function coreSetFavorite(track: Track, favorite: boolean): Promise<CoreResult<unknown>> {
    return write('library.favorites.set', {ref: trackRefOf(track), favorite, track});
}

/** 新建（无 `id`）或整体覆盖（有 `id`，顺序 = `trackRefs` 顺序）。 */
export function coreSavePlaylist(input: {
    id?: string;
    name: string;
    tracks: Track[];
}): Promise<Playlist | null> {
    if (!coreAvailable()) return Promise.resolve(null);
    return invokeCore<Playlist>('library.playlists.save', {
        ...(input.id ? {id: input.id} : {}),
        name: input.name,
        trackRefs: input.tracks.map(trackRefOf),
        tracks: input.tracks,
    }).then((result) => (result.ok ? result.data : null));
}

export function coreDeletePlaylist(id: string): Promise<CoreResult<unknown>> {
    return write('library.playlists.delete', {id});
}

/** 记一次播放（写历史；`track` 是快照，离线也能列出）。 */
export function corePushHistory(track: Track, playedSec = 0, completed = false): Promise<CoreResult<unknown>> {
    return write('library.history.push', {ref: trackRefOf(track), playedSec, completed, track});
}

/**
 * 上报一次**真实播放**（`playback.report`）。
 *
 * 与 `corePushHistory` 写的是同一份历史（核心侧同一实现，见契约 §2），区别只有一点：
 * 这里带上**实际播成的** `source`（候选回退后可能与引用的来源不同）与真实播放秒数。
 * 前端在「一首歌放完/被切走/暂停/停止」时调用一次，而不是刚开始播就记 0 秒。
 */
export function corePlaybackReport(
    track: Track,
    input: {source?: string; quality?: string; playedSec?: number; completed?: boolean} = {},
): Promise<CoreResult<unknown>> {
    const source = input.source ?? track.source;
    return write('playback.report', {
        ref: trackRefOf(track),
        source,
        ...(input.quality ? {quality: input.quality} : {}),
        playedSec: Math.max(0, Math.round(input.playedSec ?? 0)),
        completed: input.completed ?? false,
        track,
    });
}

/** 清空播放记录（历史，不影响收藏）。 */
export function coreClearHistory(): Promise<CoreResult<unknown>> {
    return write('library.history.clear', {});
}

/** 从曲库移除本地曲目；`deleteFile` 才真的删磁盘文件（界面必须二次确认）。 */
export function coreRemoveLocal(id: string, deleteFile = false): Promise<CoreResult<unknown>> {
    return write('library.local.remove', {id, deleteFile});
}

/** 扫描本地目录（进度经 `library:scan:progress` 事件推送）。 */
export function coreScanLocal(dirs: string[], recursive = true): Promise<CoreResult<LocalScanResult>> {
    return invokeCore('library.local.scan', {dirs, recursive});
}

/**
 * 订阅扫描进度（`library:scan:progress`）。
 *
 * 返回退订函数；**无核心时是安全空操作**。订阅失败不抛异常——进度只是「让等待有反馈」，
 * 扫描本身与最终统计走命令返回值，不该因为订阅出问题就整件事做不成。
 */
export async function coreListenScanProgress(
    handler: (progress: {dir: string; found: number; percent?: number}) => void,
): Promise<() => void> {
    if (!coreAvailable()) return () => undefined;
    try {
        const {listen} = await import('@tauri-apps/api/event');
        return await listen<{dir: string; found: number; percent?: number}>(
            CORE_EVENTS['library:scan:progress'],
            (message) => handler(message.payload),
        );
    } catch (err) {
        console.warn('[core] 扫描进度订阅失败（扫描仍会照常执行）', err);
        return () => undefined;
    }
}

/* ------------------------------ 推荐 ------------------------------ */

/** 口味画像 + 三类推荐（核心读本机库；不发起任何外部请求，ADR-0005）。 */
export function coreRecommendHome(limit?: number): Promise<RecommendationBundle | null> {
    if (!coreAvailable()) return Promise.resolve(null);
    return invokeCore<RecommendationBundle>('recommend.home', {
        ...(limit ? {limit} : {}),
    }).then((result) => (result.ok ? result.data : null));
}

/**
 * 相似推荐的种子：曲目（本机库里能找到的），或专辑 id。
 *
 * 专辑种子按**专辑内曲目的标签/歌手并集**找邻居，并且不会把这张专辑自己的曲目推回来；
 * 用专辑种子要求 `albumId` 与快照里的 `albumId` 一致（插件没提供该字段时，
 * 用曲目种子更可靠——界面因此默认用曲目种子）。
 */
export type SimilarSeed = Track | {albumId: string};

const isAlbumSeed = (seed: SimilarSeed): seed is {albumId: string} => 'albumId' in seed;

/** 相似推荐：种子可以是曲目或专辑 id。 */
export function coreRecommendSimilar(
    seed: SimilarSeed,
    limit?: number,
): Promise<RecommendedTrack[] | null> {
    if (!coreAvailable()) return Promise.resolve(null);
    return invokeCore<RecommendedTrack[]>('recommend.similar', {
        seed: isAlbumSeed(seed) ? {albumId: seed.albumId} : trackRefOf(seed),
        ...(limit ? {limit} : {}),
    }).then((result) => (result.ok ? result.data : null));
}

/** 推荐反馈（`skip` 的进度决定它是负信号还是噪音）。 */
export function coreRecommendFeedback(
    track: Track,
    action: 'play' | 'skip' | 'like' | 'unlike' | 'complete',
    progress?: number,
): Promise<CoreResult<unknown>> {
    return write('recommend.feedback', {
        ref: trackRefOf(track),
        action,
        ...(progress === undefined ? {} : {progress}),
        track,
    });
}
