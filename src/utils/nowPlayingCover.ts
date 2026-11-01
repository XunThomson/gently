/**
 * 手机歌词页的封面策略（**手机端的显示偏好**，不是主题样式）。
 *
 * 用户 2026-11-01 的取舍：手机上歌词才是主角 —— 大封面挤掉的正是歌词行数，
 * 所以**默认不显示封面**；想要氛围感的可以在歌词页右上角把它切成「作为背景」
 * （铺满、压暗 + 虚化，歌词压在上面）。
 *
 * 为什么存在 localStorage 而不是全局 store：这是**单个页面的显示偏好**，
 * 与 `lyricsWindowSettings`（桌面歌词窗口）同一种做法——只被歌词页消费，
 * 进 store 反而要为一个布尔值改切片、类型与持久化三处。
 * 桌面端不受影响（桌面仍是「封面 + 歌词」两栏）。
 */
export type CoverMode = 'hidden' | 'background';

const KEY = 'gently:now-playing-cover';

const listeners = new Set<(mode: CoverMode) => void>();

function normalize(raw: unknown): CoverMode {
    return raw === 'background' ? 'background' : 'hidden';
}

export function readCoverMode(): CoverMode {
    if (typeof window === 'undefined') return 'hidden';
    try {
        return normalize(window.localStorage.getItem(KEY));
    } catch {
        return 'hidden';
    }
}

export function saveCoverMode(mode: CoverMode): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(KEY, mode);
    } catch {
        /* 隐私模式等场景写不进去：只影响下次启动，不改当前行为 */
    }
    listeners.forEach((fn) => fn(mode));
}

export function subscribeCoverMode(fn: (mode: CoverMode) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
