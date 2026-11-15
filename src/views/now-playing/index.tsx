import {useSelect} from '../../store';
import {useShellMode} from '../../hooks/useShellMode';
import {DesktopNowPlaying} from './desktop';
import {EmptyNowPlaying} from './empty';
import {MobileNowPlaying} from './mobile';

/**
 * 歌词页入口（R144）。
 *
 * 桌面与移动的歌词页**不再共用一套布局**：两端的导航、控件密度、主视觉都不一样，
 * 共用一个组件只能靠 `isMobile` 在里面互相打架。这里只做一次分叉：
 * - `mobile` 外壳 → `MobileNowPlaying`（全屏播放页：居中歌词 + 底部操作/进度/传输）；
 * - 其它（regular / compact）→ `DesktopNowPlaying`（居中歌词 + 右上角图标栏）。
 *
 * 共用的是**与布局无关**的块：歌词区（`NowPlayingLyrics`）、工具内容
 * （`PlaybackModes` / `PlaybackOptions` / `LyricsTools` / `QueuePanel`）与 store 动作。
 */
export default function NowPlayingView() {
    const mode = useShellMode();
    const current = useSelect((s) => s.player.current);

    if (!current) return <EmptyNowPlaying/>;
    return mode === 'mobile' ? <MobileNowPlaying/> : <DesktopNowPlaying/>;
}
