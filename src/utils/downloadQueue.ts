import type {DownloadTask, Track} from '../types';

/** 队列匹配用到的曲目字段 */
export type QueueTrackLike = Pick<Track, 'id' | 'source' | 'title' | 'artist'>;

/** 队列键之间的分隔符（标题/歌手可能带空格与竖线，用控制字符最安全） */
const KEY_SEP = '\u0001';

/**
 * 曲目的统一引用 `source:trackId`（与核心的 `TrackRef` 同一口径）。
 *
 * `track.id` 有时已经是完整引用、有时只有源内 id，这里统一成一种写法。
 * 放在工具层是为了让「按引用比对」只有一份实现：`services/core.library` 的
 * `trackRefOf` 与列表里的下载标记都从这里取。
 */
export function trackReference(track: Pick<Track, 'id' | 'source'>): string {
    return track.id.startsWith(`${track.source}:`) ? track.id : `${track.source}:${track.id}`;
}

/**
 * 一首曲目在下载队列里的两个匹配键。
 *
 * 1. **引用**（`source:rawId`）精确匹配；
 * 2. **「同源 + 同标题 + 同歌手」**兜底——同一首歌 / 同一个视频在不同列表里的 rawId
 *    可能不同（有的带 `|cid`、有的只有主 id），只按引用比会漏掉「明明已经下载过，
 *    却还显示下载入口」的情况。
 */
export function queueKeysOf(track: QueueTrackLike): string[] {
    return [trackReference(track), `${track.source}|${track.title}|${track.artist}`];
}

/** 任务的匹配键（用于订阅：只随「队列里有哪些歌」变化，不受进度每秒刷新的影响） */
export function downloadQueueKeyList(tasks: DownloadTask[]): string[] {
    return tasks.flatMap((task) => (task.track ? queueKeysOf(task.track) : []));
}

/** 队列键的稳定字符串形态（给 selector 用：`join` 后内容不变就不会触发重渲染） */
export function downloadQueueKeyString(tasks: DownloadTask[]): string {
    return downloadQueueKeyList(tasks).join(KEY_SEP);
}

/** 解析回键集合 */
export function parseQueueKeyString(value: string): Set<string> {
    return new Set(value ? value.split(KEY_SEP) : []);
}

/** 这组键里是否有这首曲目 */
export function isQueued(keys: Iterable<string>, track: QueueTrackLike): boolean {
    const wanted = queueKeysOf(track);
    if (keys instanceof Set) return wanted.some((key) => keys.has(key));
    const list = [...keys];
    return wanted.some((key) => list.includes(key));
}

/**
 * 下载队列里属于这首曲目的任务（列表标记要显示状态与进度，因此返回任务本身）。
 */
export function queuedDownloadsOf(tasks: DownloadTask[], track: Track): DownloadTask[] {
    return tasks.filter((task) => (task.track ? isQueued(queueKeysOf(task.track), track) : false));
}

/**
 * 这首曲目是否**已经在下载队列里**（排队 / 下载中 / 已暂停 / 已下载 / 失败都算）。
 *
 * 用途是**隐藏下载入口**：已经入队的曲目再给一个「下载」按钮，等于允许用户
 * 对同一首歌反复提交（重复任务、并发槽被自己占满，都可能把队列弄乱）。
 */
export function isInDownloadQueue(tasks: DownloadTask[], track: QueueTrackLike): boolean {
    return tasks.some((task) => (task.track ? isQueued(queueKeysOf(task.track), track) : false));
}
