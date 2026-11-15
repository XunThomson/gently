import {useCallback, useEffect} from 'react';
import {Lyrics} from '../../../components/ui/lyrics';
import {useActions, useSelect} from '../../../store';

/**
 * 歌词页共用的歌词区（R144：桌面 / 移动各自布局，但这一块只有一份）。
 *
 * 单独订阅 `elapsed / lyricsOffset`：播放进度每 250ms 回写一次；如果页面壳订阅它，
 * 封面、标题、工具面板都会跟着重渲染。这里把进度下沉到歌词子树。
 *
 * `centered`：歌词页是舞台语境，默认居中；桌面歌词窗口仍用左对齐（不传）。
 */
export function NowPlayingLyrics({centered = true}: {centered?: boolean}) {
    const lines = useSelect((s) => s.player.lyrics);
    const elapsed = useSelect((s) => s.player.elapsed);
    const offset = useSelect((s) => s.player.lyricsOffset);
    const seek = useActions().player.seek;
    const ensureLyrics = useActions().player.ensureLyrics;

    /* 冷启动恢复的曲目没有歌词快照：打开歌词页这个**用户动作**之后再补，
       启动阶段不碰网络（AGENTS #16）。 */
    useEffect(() => {
        ensureLyrics();
    }, [ensureLyrics]);

    const onSeek = useCallback(
        (time: number) => seek(Math.max(0, time - offset)),
        [seek, offset],
    );

    return (
        <Lyrics
            lines={lines}
            elapsed={elapsed + offset}
            onSeek={onSeek}
            centered={centered}
        />
    );
}

export default NowPlayingLyrics;
