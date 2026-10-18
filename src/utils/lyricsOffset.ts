/**
 * 歌词时间轴偏移：按曲目持久化到 localStorage。
 *
 * 为什么是逐曲目：歌词与音频对不上往往与**那一份歌词**有关（不同源、不同版本），
 * 换一首歌就不该沿用上一首的校正值。存储上限 500 首，超出时丢最旧的。
 *
 * 「偏移」的语义：`offset > 0` 表示歌词比音频**晚**，渲染时用 `elapsed + offset` 定位高亮行；
 * 点某行跳转时反过来用 `line.time - offset`。这是唯一一处解释这个方向的地方。
 */

const STORAGE_KEY = 'gently:lyrics-offsets';
const MAX_ENTRIES = 500;

/** 偏移上限（秒）：超过这个范围基本是选错了歌词，而不是对不齐 */
export const LYRICS_OFFSET_LIMIT_SEC = 30;
/** 校正按钮的步长（秒）：0.5s 足够跟上常见的前奏/延迟差异 */
export const LYRICS_OFFSET_STEP_SEC = 0.5;

/** 把任意输入钳成合法偏移（保留 1 位小数） */
export function clampLyricsOffset(seconds: number): number {
    if (!Number.isFinite(seconds)) return 0;
    const rounded = Math.round(seconds * 10) / 10;
    return Math.min(LYRICS_OFFSET_LIMIT_SEC, Math.max(-LYRICS_OFFSET_LIMIT_SEC, rounded));
}

function readAll(): Record<string, number> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

/** 读某首曲目的偏移；从没校正过 → 0 */
export function readLyricsOffset(trackId: string): number {
    return clampLyricsOffset(readAll()[trackId] ?? 0);
}

/** 写某首曲目的偏移；写 0 等于删掉这条记录（不占存储） */
export function writeLyricsOffset(trackId: string, seconds: number): void {
    if (typeof window === 'undefined') return;
    const value = clampLyricsOffset(seconds);
    const all = readAll();
    if (value === 0) delete all[trackId];
    else all[trackId] = value;

    // 插入顺序就是写入顺序：删最旧的键，直到回到上限内
    const keys = Object.keys(all);
    while (keys.length > MAX_ENTRIES) {
        const oldest = keys.shift();
        if (oldest) delete all[oldest];
    }

    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
        /* 隐私模式 / 配额限制：偏移只是体验优化，写不进去不影响播放 */
    }
}
