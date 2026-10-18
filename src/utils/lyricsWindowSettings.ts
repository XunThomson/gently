/**
 * 桌面歌词窗口的显示设置（背景样式 / 逐字展开）。
 *
 * 为什么单独一个模块：三个地方要读同一份值——设置页（写入）、主窗口的桥（随载荷推过去）、
 * 歌词窗口（渲染）。放在一个文件里就能保证**默认值与键名只有一份**，不会出现
 * 「设置页写 `bg`、桥读 `background`」这种永远对不上的错。
 *
 * 存储用 localStorage：它只影响窗口观感，不属于核心数据（不需要进 SQLite）。
 * 没有 localStorage 时（冒烟测试 / SSR）一律返回默认值，不抛异常。
 */

export type LyricsBackground = 'solid' | 'translucent' | 'transparent';

export interface LyricsWindowSettings {
    /** 窗口背景：不透明 / 半透明 / 全透明（只有字） */
    background: LyricsBackground;
    /** 当前行是否「从左到右」逐字展开（卡拉 OK 式高亮） */
    sweep: boolean;
}

export const LYRICS_SETTINGS_KEY = 'gently:lyrics-window-settings';

/**
 * 默认值 = **保持现状**：不透明背景、关闭逐字展开。
 *
 * 透明背景在浅色桌面壁纸上会看不清字，逐字展开也不是所有人都想要，
 * 所以两项都做成「用户显式打开」，而不是升级后突然变化。
 */
export const DEFAULT_LYRICS_WINDOW_SETTINGS: LyricsWindowSettings = {
    background: 'solid',
    sweep: false,
};

const BACKGROUNDS: LyricsBackground[] = ['solid', 'translucent', 'transparent'];

function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

/** 读当前设置（坏数据 / 没有存储都退回默认值） */
export function readLyricsWindowSettings(): LyricsWindowSettings {
    const raw = storage()?.getItem(LYRICS_SETTINGS_KEY);
    if (!raw) return {...DEFAULT_LYRICS_WINDOW_SETTINGS};
    try {
        const value = JSON.parse(raw) as Partial<LyricsWindowSettings> | null;
        const background =
            value && BACKGROUNDS.includes(value.background as LyricsBackground)
                ? (value.background as LyricsBackground)
                : DEFAULT_LYRICS_WINDOW_SETTINGS.background;
        return {
            background,
            sweep: typeof value?.sweep === 'boolean' ? value.sweep : DEFAULT_LYRICS_WINDOW_SETTINGS.sweep,
        };
    } catch {
        return {...DEFAULT_LYRICS_WINDOW_SETTINGS};
    }
}

type Listener = (settings: LyricsWindowSettings) => void;
const listeners = new Set<Listener>();

/** 写设置并通知订阅者（主窗口的桥据此立刻把新观感推给歌词窗口） */
export function writeLyricsWindowSettings(patch: Partial<LyricsWindowSettings>): LyricsWindowSettings {
    const next: LyricsWindowSettings = {...readLyricsWindowSettings(), ...patch};
    try {
        storage()?.setItem(LYRICS_SETTINGS_KEY, JSON.stringify(next));
    } catch (err) {
        // 存不下只是「重启后回到默认」，不该影响当前窗口
        console.warn('[lyrics] 保存桌面歌词显示设置失败', err);
    }
    for (const listener of listeners) listener(next);
    return next;
}

/** 订阅设置变化；返回退订函数（桥用它把变化即时推过去，不必等 1s 心跳） */
export function subscribeLyricsWindowSettings(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
