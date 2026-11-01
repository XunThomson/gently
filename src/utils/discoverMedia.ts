import type {Track} from '../types';

/**
 * 「发现」视图的**媒介形态**与**试听片段**（R87）。
 *
 * 两块都是纯函数，便于冒烟断言：
 * - 形态：同一首歌每次进来必须还是同一种包装（按 id 稳定哈希，不随排序变化）；
 * - 试听：从「高潮处」开始。**没有数据就退化成估计**——见 `previewWindow` 的说明。
 */
export type MediaKind = 'vinyl' | 'cassette' | 'cd';

const MEDIA_KINDS: MediaKind[] = ['vinyl', 'cassette', 'cd'];

/**
 * 稳定哈希（FNV-1a 32 位）：只用于「挑一种包装」，不用于任何安全判断。
 * 用 id 而不是标题：同名歌曲很多，按标题会让两首不同的歌长成一模一样。
 */
function hash32(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** 这首歌用哪种包装展示（黑胶 / 磁带 / 光盘）。同一个 id 恒定。 */
export function mediaKindOf(key: string): MediaKind {
    return MEDIA_KINDS[hash32(key) % MEDIA_KINDS.length];
}

/** 试听片段的长度（秒） */
export const PREVIEW_SECONDS = 20;

/**
 * 「高潮处」大约在整首歌的哪个位置。
 *
 * 诚实说明：**没有任何插件/源给我们 chorus 时间戳**（契约里也没有这个字段）。
 * 因此这里不假装知道——按流行歌的结构取 38% 处作为**估计**，并且：
 * - 太短的歌（< 60 秒）直接不试听（没有「高潮」可言，试听只会听到前奏）；
 * - 片段不超过 `PREVIEW_SECONDS`，且不会越过结尾。
 *
 * 一旦将来契约里加上 `previewStart`，这里就是唯一要改的地方（调用方不用动）。
 */
export function previewWindow(durationSec: number): {start: number; end: number} | null {
    if (!Number.isFinite(durationSec) || durationSec < 60) return null;
    const start = Math.min(Math.max(durationSec * 0.38, 20), Math.max(20, durationSec - PREVIEW_SECONDS - 5));
    const end = Math.min(durationSec, start + PREVIEW_SECONDS);
    if (end - start < 5) return null;
    return {start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10};
}

/**
 * 能不能试听：本地文件与在线源都可以（都走 `catalogService.resolveUrl`），
 * 但**没有时长的曲目**（源没给 duration）不试听——算不出该从哪开始。
 */
export function canPreview(track: Pick<Track, 'durationSec'>): boolean {
    return previewWindow(track.durationSec) !== null;
}
