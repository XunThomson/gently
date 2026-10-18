/**
 * 歌词搜索结果的**会话级**缓存。
 *
 * 场景（用户报的）：第一次搜到一份词并配对好，切到别的歌再切回来，搜索面板又是空的——
 * 只能重新搜一遍。可是「刚才搜到什么」这件事在本次运行里明明还没丢，丢掉的是组件 state。
 *
 * 为什么只放内存、不放 localStorage：
 * - 每条结果都带歌词**全文**（一份几 KB，一次可能好几条），落盘到 localStorage 只会挤占配额，
 *   而它要解决的只是「本次会话里切来切去」；
 * - 真正需要跨重启记住的是「这一首挑了哪份词 + 偏移」——那两份已经在
 *   `utils/lyricsSyncCache.ts` 与 `utils/lyricsOffset.ts` 里持久化了，本缓存丢了也不影响播放。
 *
 * 上层按曲目 id 取，最多留 8 首（超出丢最早写入的）。
 */

import type {LyricSearchItem, LyricSearchResult} from '../api';

const MAX_ENTRIES = 8;

const cache = new Map<string, LyricSearchResult>();

/** 只保留渲染与「使用」需要的字段：核心给的结果形状很宽，全存没必要 */
function compact(item: LyricSearchItem): LyricSearchItem {
    return {
        source: item.source,
        sourceName: item.sourceName,
        track: item.track,
        lyrics: item.lyrics,
    };
}

function compactResult(result: LyricSearchResult): LyricSearchResult {
    return {
        items: result.items.map(compact),
        searchedSources: result.searchedSources,
        failedSources: result.failedSources,
        skippedSources: result.skippedSources,
        timedOutSources: result.timedOutSources,
    };
}

/** 某首曲目上次的搜索结果；没有就是 `null` */
export function readCachedLyricSearch(trackId: string): LyricSearchResult | null {
    if (!trackId) return null;
    const hit = cache.get(trackId);
    if (!hit) return null;
    // 读一次就挪到「最新」：Map 的插入顺序就是淘汰顺序
    cache.delete(trackId);
    cache.set(trackId, hit);
    return hit;
}

/** 记下这次搜索的结果（同一首再搜一次就覆盖） */
export function saveCachedLyricSearch(trackId: string, result: LyricSearchResult): void {
    if (!trackId) return;
    cache.delete(trackId);
    cache.set(trackId, compactResult(result));
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
}

/** 清空（测试用；应用里没有「清缓存」入口——它随会话消失） */
export function clearCachedLyricSearch(): void {
    cache.clear();
}

/** 当前缓存了多少首（测试用） */
export function cachedLyricSearchCount(): number {
    return cache.size;
}
