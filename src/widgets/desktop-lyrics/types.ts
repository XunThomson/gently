import type {ThemeMode} from '../../theme';
import type {LyricsBackground} from '../../utils/lyricsWindowSettings';

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
    /** 当前播放位置（秒）：歌词窗口据此自己插值出逐字展开进度 */
    elapsed: number;
    /** 当前行的开始时间（秒）；没有当前行时为 0 */
    lineStart: number;
    /** 当前行的结束时间（= 下一行开始；没有下一行时按行时长兜底，秒） */
    lineEnd: number;
    /** 窗口背景样式（设置页可调） */
    background: LyricsBackground;
    /** 是否逐字展开（卡拉 OK 式高亮，设置页可开关） */
    sweep: boolean;
}
