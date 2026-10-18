import type {ThemeMode} from '../../theme';

/** 主窗口 → 桌面歌词窗口的同步载荷（窗口间事件 `gently:lyrics:update`）。 */
export interface DesktopLyricsPayload {
    title: string;
    artist: string;
    /** 当前应高亮的那一行（没有歌词时为空串） */
    line: string;
    translation?: string;
    /** 下一行：桌面歌词通常显示「当前 + 下一句」，让用户有准备 */
    next: string;
    playing: boolean;
    /** 当前曲目没有任何歌词 */
    empty: boolean;
    /** 歌词来源显示名（自动匹配 / 用户从搜索里选的源） */
    source: string;
    /** 主窗口当前的主题模式：歌词窗口是独立 WebView，主题不会自动跟着变 */
    themeMode: ThemeMode;
}
