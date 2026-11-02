import type {Lyrics} from '../api';
import type {LyricLine} from '../types';

/**
 * 当前应高亮的行：最后一行满足 `line.time <= elapsed`；早于所有行时返回 -1。
 *
 * 歌词页、桌面歌词与（2.x）宠物共用同一份实现——高亮判断只允许一份。
 */
export function activeLyricIndex(lines: LyricLine[], elapsed: number): number {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].time <= elapsed) return i;
    }
    return -1;
}

/**
 * 当前这一行的文字（没有歌词 / 还没到第一行时返回空串）。
 *
 * 手机的通知栏用它显示「正在唱哪一句」（R116）：通知的第二行从歌手换成歌词，
 * **行变化才推一次 IPC**（不跟随每秒进度）。判定复用 {@link activeLyricIndex}，
 * 「唱到哪一行」只允许一份实现。
 */
export function currentLyricLine(lines: LyricLine[], elapsed: number): string {
    const index = activeLyricIndex(lines, elapsed);
    if (index < 0) return '';
    return lines[index]?.text?.trim() ?? '';
}

export interface MiniLyricSlot {
    index: number;
    line: LyricLine | null;
}

/**
 * 迷你播放器的三行窗口：上/当前/下。
 *
 * 为什么不是渲染整份歌词再滚动：迷你视口只够三行，整份歌词会创建几百个按钮，
 * 滚动跟随也没有意义。固定三槽让当前行永远在中间；当前行在首/尾时用空槽占位，
 * 保持纵向位置不跳。
 */
export function miniLyricSlots(
    lines: LyricLine[],
    activeIndex: number,
): [MiniLyricSlot, MiniLyricSlot, MiniLyricSlot] {
    if (lines.length === 0) {
        return [
            {index: -1, line: null},
            {index: -1, line: null},
            {index: -1, line: null},
        ];
    }
    const current = activeIndex < 0 ? 0 : Math.min(lines.length - 1, activeIndex);
    const slot = (index: number): MiniLyricSlot => ({
        index,
        line: index >= 0 && index < lines.length ? lines[index] : null,
    });
    return [slot(current - 1), slot(current), slot(current + 1)];
}

/**
 * 当前行已经唱到的比例（0~1）：桌面歌词的「逐字展开」用它算遮罩宽度。
 *
 * `end` 是**下一行的开始时间**（没有下一行时由调用方给一个合理的收尾时间）。
 * 边界都要能算：`end <= start`（同一时间戳的重复行）、`elapsed` 在行之前/之后，
 * 都夹到 0~1，绝不让遮罩出现负数宽度。
 */
export function lyricLineProgress(start: number, end: number, elapsed: number): number {
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(elapsed)) return 0;
    if (end <= start) return elapsed >= end ? 1 : 0;
    const ratio = (elapsed - start) / (end - start);
    return Math.min(1, Math.max(0, ratio));
}

/**
 * 歌词解析：把核心给的**原文**（契约 `Lyrics{format, content, translated?}`）转成
 * 视图要的行数组（`{time, text, translation?}`）。
 *
 * 为什么解析留在前端：核心只交付歌词原文，**解析成行是纯展示问题**（高亮用哪一行、
 * 翻译怎么对齐），放到核心等于把 UI 细节塞进 ABI。同一个解析器也只有这一份。
 *
 * 支持三种输入：核心已解析好的 `lines`、带时间轴的 `lrc`、没有时间轴的 `plain`。
 */

/** `[mm:ss]` / `[mm:ss.xx]` / `[mm:ss.xxx]`；一行可以带多个标签（共用同一段文本） */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** LRC 元数据标签（`[ar:]` / `[ti:]` / `[offset:]` 等），不是歌词行 */
const META_TAG = /^\[[a-zA-Z]{2,}:/;

/**
 * 纯文本歌词的**占位**时序：源没给时间轴，按行均分只会让高亮显得很准。
 * 这里取一个稳定的阅读节奏（每行 4 秒）并明确标注是占位，而不是假装真实时间。
 */
const PLAIN_LINE_SEC = 4;

function toSeconds(minutes: string, seconds: string, fraction?: string): number {
    const base = Number(minutes) * 60 + Number(seconds);
    if (!fraction) return base;
    // 两位是百分秒、三位是毫秒，都按小数位补齐
    return base + Number(fraction) / 10 ** fraction.length;
}

/** 解析一份 LRC 文本 → `时间 → 文本`（同一时间多行时用数组保序） */
function parseTimed(content: string): Map<number, string[]> {
    const timed = new Map<number, string[]>();
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || META_TAG.test(line)) continue;

        TIME_TAG.lastIndex = 0;
        const stamps: number[] = [];
        let lastEnd = 0;
        let match: RegExpExecArray | null;
        while ((match = TIME_TAG.exec(line)) !== null) {
            stamps.push(toSeconds(match[1], match[2], match[3]));
            lastEnd = match.index + match[0].length;
        }
        if (stamps.length === 0) continue;

        const text = line.slice(lastEnd).trim();
        if (!text) continue;
        for (const stamp of stamps) {
            const bucket = timed.get(stamp);
            if (bucket) bucket.push(text);
            else timed.set(stamp, [text]);
        }
    }
    return timed;
}

/** 把翻译按**同一时间戳**贴到原文行上（时间戳对不上就忽略那一行，不硬凑）。 */
function mergeTranslation(original: Map<number, string[]>, translated?: string): LyricLine[] {
    const secondary = translated ? parseTimed(translated) : null;
    return [...original.keys()]
        .sort((a, b) => a - b)
        .map((time) => {
            const text = original.get(time)?.join(' ') ?? '';
            const translation = secondary?.get(time)?.join(' ');
            return translation ? {time, text, translation} : {time, text};
        });
}

/** 纯文本 → 行（`time` 是按行序的占位秒数，只为让高亮能推进） */
function parsePlain(content: string): LyricLine[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((text, index) => ({time: index * PLAIN_LINE_SEC, text}));
}

/** 契约 `Lyrics` → 视图行数组。核心已经解析好（`lines`）时直接用，不再二次解析。 */
export function toLyricLines(lyrics: Lyrics): LyricLine[] {
    if (lyrics.lines && lyrics.lines.length > 0) return lyrics.lines;

    if (lyrics.format === 'plain') return parsePlain(lyrics.content);

    const timed = mergeTranslation(parseTimed(lyrics.content), lyrics.translated);
    // 标了 lrc 但一个时间标签都没有（源给了假格式）：退回纯文本，别显示空歌词
    return timed.length > 0 ? timed : parsePlain(lyrics.content);
}
