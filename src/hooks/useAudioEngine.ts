import {useEffect} from 'react';
import {useActions, useSelect} from '../store';
import {audioEngine} from '../services/audio.service';

/**
 * 把 store 的播放状态与真实音频引擎对接：
 * - store → 引擎：切歌载入音源、播放 / 暂停、音量、切歌归零
 * - 引擎 → store：timeupdate 回写进度与时长，ended 自动下一首，错误回退模拟时钟
 *
 * 应用内只需挂载一次（App 中调用）。
 */
export function useAudioEngine(): void {
    const playId = useSelect((s) => s.player.current?.playId ?? null);
    const audioUrl = useSelect((s) => s.player.audioUrl);
    const playing = useSelect((s) => s.player.playing);
    const volume = useSelect((s) => s.player.volume);
    const {setProgress, next, markUnplayable} = useActions().player;

    /* 引擎事件 → store */
    useEffect(() => {
        audioEngine.setHandlers({
            onTime: setProgress,
            onEnded: next,
            onError: markUnplayable,
        });
        return () => audioEngine.setHandlers({});
    }, [setProgress, next, markUnplayable]);

    /* 音源 → 引擎 */
    useEffect(() => {
        if (!audioUrl) return;
        void audioEngine.load(audioUrl);
    }, [audioUrl]);

    /* 播放状态 → 引擎（音源变化时同样需要重新 play） */
    useEffect(() => {
        if (!audioUrl) return;
        if (playing) audioEngine.play();
        else audioEngine.pause();
    }, [playing, audioUrl]);

    /* 音量 */
    useEffect(() => {
        audioEngine.setVolume(volume);
    }, [volume]);

    /* 切歌归零（同一音源重复使用时要显式回到开头） */
    useEffect(() => {
        if (playId === null) return;
        audioEngine.seek(0);
    }, [playId]);
}
