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
    const {setProgress, next, markUnplayable, recoverPlayback} = useActions().player;

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

    /**
     * **休眠 / 长时间失焦之后接着播**（R87 修的 bug）。
     *
     * 现象：电脑睡一觉回来，界面还显示「播放中」，声音却没了；点播放/暂停也没用，
     * 只能重新点一遍这首歌。根因有两层：
     * 1. 系统休眠会掐断媒体元素（WebView2 里 `paused` 变 true，或元素直接进 error 态）；
     *    而 `audioUrl` 没变，`useEffect` 不会重跑，所以没有任何代码去把声音叫回来；
     * 2. 恢复时旧地址**已经作废**——回环流代理的 token 只有 30 分钟 TTL，
     *    上游给的直链通常更短。地址不换，重载多少次都放不出来。
     *
     * 所以这里做两段式恢复：先让引擎原地续播（必要时硬重载），不行就让 store
     * `recoverPlayback()` 去核心重新解析一次（**保留当前进度**），拿新地址继续放。
     * 定时的兜底扫描覆盖「窗口一直有焦点、系统照样睡了」这种没有任何事件的情况。
     */
    useEffect(() => {
        if (!audioUrl || !playing || !playable) return;

        /* 每次播放最多自动重新解析两次：够覆盖「token/直链过期」，又不会在
           真的不可播时变成每 5 秒一轮的网络请求（那会同时打满核心和插件）。 */
        let recoveredPlayId: number | null = null;
        let attempts = 0;

        const resumeIfStalled = () => {
            // 页面在后台时不抢播放：切回来（visibilitychange 会再触发一次）才恢复
            if (document.visibilityState === 'hidden') return;
            // 元素还在播就什么都不做：只有「界面说在播、元素却停着」才是要修的状态
            if (!audioEngine.isPausedNow()) return;

            void audioEngine.resume().then((result) => {
                if (result !== 'failed') return;
                // 只有**错误态**才值得重新解析地址；单纯被暂停/被策略拦下换 URL 也没用
                if (!audioEngine.hadError()) return;
                if (playId !== null && recoveredPlayId === playId && attempts >= 2) return;
                if (recoveredPlayId !== playId) {
                    recoveredPlayId = playId;
                    attempts = 0;
                }
                attempts += 1;
                // 地址已经作废：交给核心重新解析（保留进度），用户不需要手动重播
                recoverPlayback();
            });
        };

        window.addEventListener('focus', resumeIfStalled);
        window.addEventListener('pageshow', resumeIfStalled);
        document.addEventListener('visibilitychange', resumeIfStalled);
        // 系统休眠期间定时器会被挂起，唤醒后第一拍就会跑；5s 的粒度足够，代价可忽略
        const timer = window.setInterval(resumeIfStalled, 5000);

        return () => {
            window.removeEventListener('focus', resumeIfStalled);
            window.removeEventListener('pageshow', resumeIfStalled);
            document.removeEventListener('visibilitychange', resumeIfStalled);
            window.clearInterval(timer);
        };
    }, [audioUrl, playing, playable, playId, recoverPlayback]);
}
