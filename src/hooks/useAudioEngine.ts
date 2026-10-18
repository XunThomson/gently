import {useEffect} from 'react';
import {useActions, useSelect} from '../store';
import {audioEngine} from '../services/audio.service';

/**
 * 把 store 的播放状态与真实音频引擎对接：
 * - store → 引擎：切歌载入音源、播放 / 暂停、音量、切歌归零
 * - 引擎 → store：timeupdate 回写进度与时长，ended 自动下一首，错误走「换源 / 停播 + 说明」
 *
 * 应用内只需挂载一次（App 中调用）。
 */
export function useAudioEngine(): void {
    const playId = useSelect((s) => s.player.current?.playId ?? null);
    const audioUrl = useSelect((s) => s.player.audioUrl);
    const playing = useSelect((s) => s.player.playing);
    const playable = useSelect((s) => s.player.playable);
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
        audioEngine.load(audioUrl);
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

    /**
     * 看门狗：音源解析成功、界面也切到「播放中」，但**媒体元素其实还停着**时兜底。
     *
     * 为什么需要：有些失败不会触发 `error`（自动播放被拦、地址能连上却没数据、
     * 容器被代理换过头导致解码器直接放弃），界面就会一直显示播放、进度却不动。
     * 这里等一小会儿再看一眼元素：还停着就当这个源播不了——交给 `markUnplayable`
     * 去换下一个候选源，全都试完才停播并给出原因。
     */
    useEffect(() => {
        if (!audioUrl || !playing || !playable) return;
        const startedAt = audioEngine.currentTime();
        const timer = window.setTimeout(() => {
            if (!audioEngine.isPausedNow()) return;
            if (audioEngine.currentTime() > startedAt) return;
            markUnplayable('媒体元素没有开始播放');
        }, 2500);
        return () => window.clearTimeout(timer);
    }, [audioUrl, playing, playable, markUnplayable]);
}
