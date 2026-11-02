import {useEffect} from 'react';
import {useActions, useSelect} from '../store';
import {audioEngine, installMediaActionHandler, syncPlaybackBanner} from '../services';
import {currentLyricLine} from '../utils/lyrics';

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
    const {setProgress, next, markUnplayable, recoverPlayback, markInterrupted, toggle, prev} =
        useActions().player;

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
     * 手机的「播放通知 / 前台服务 / MediaSession / 通知栏歌词」（P2-1 / P2-2 / P4）。
     *
     * 三个入参各管一件事，**不能合并**：
     * - `active` = 有没有当前曲目（决定服务起不起）；
     * - `playing` = 在不在播（决定按钮图标与 `PlaybackState`）；
     * - `line` = 当前歌词行（通知第二行显示它，没有歌词时退回歌手）。
     * 第一版把 active 与 playing 写成同一个值，结果一暂停就把服务和会话一起关了——
     * 通知没了、耳机键也不再响应（R115 真机抓到的）。
     *
     * `line` 用**派生成字符串的选择器**：只有「唱到另一行」时才重渲染并推一次 IPC，
     * 订阅 `elapsed`（每秒变）会把整棵外壳每秒重渲染一次。
     */
    const hasTrack = useSelect((s) => !!s.player.current);
    const trackTitle = useSelect((s) => s.player.current?.title ?? '');
    const trackArtist = useSelect((s) => s.player.current?.artist ?? '');
    const lyricLine = useSelect((s) =>
        currentLyricLine(s.player.lyrics, s.player.elapsed + s.player.lyricsOffset),
    );
    useEffect(() => {
        void syncPlaybackBanner(hasTrack, trackTitle, trackArtist, playing, lyricLine);
    }, [hasTrack, playing, trackTitle, trackArtist, lyricLine]);

    /**
     * 通知栏 / 锁屏 / 耳机键的传输动作（P2-2）。
     *
     * 原生侧不拥有播放状态：它只把动作（toggle / next / prev）送进页面，
     * 这里翻译成 store 的命令——与界面上的按钮走同一条路，行为不会分叉。
     */
    useEffect(() => {
        return installMediaActionHandler((action) => {
            if (action === 'toggle') toggle();
            else if (action === 'next') next();
            else prev();
        });
    }, [toggle, next, prev]);

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

        const escalate = (result: 'ok' | 'reloaded' | 'failed') => {
            if (result !== 'failed') return;

            if (recoveredPlayId !== playId) {
                recoveredPlayId = playId;
                attempts = 0;
            }

            /* 有 `MediaError`：地址确实坏了（token/直链过期、上游 403）——重新解析。
               没有 `MediaError`、只是 `play()` 超时 / 位置不动：**系统把管道掐了**
               （安卓锁屏/后台）。这种也值得重新解析一次（新地址 + 新的 load 能把管道拉回来），
               但只给一次机会，之后如实停表并说明是「被系统中断」，而不是假装还在播。 */
            const budget = audioEngine.hadError() ? 2 : 1;
            if (attempts < budget) {
                attempts += 1;
                recoverPlayback();
                return;
            }
            markInterrupted();
        };

        const resumeIfStalled = () => {
            // 页面在后台时不抢播放：切回来（visibilitychange 会再触发一次）才恢复
            if (document.visibilityState === 'hidden') return;
            // 1) 元素停着（被暂停 / 被策略拦下）：叫它继续
            if (audioEngine.isPausedNow()) {
                void audioEngine.resume().then(escalate);
                return;
            }
            /* 2) 元素**以为自己在播、位置却不动**（安卓锁屏/后台后的僵死）。
               只判 `paused` 会漏掉这一种——界面就永远「播放中、进度不动」（R111 真机）。 */
            if (audioEngine.isStalledNow()) {
                void audioEngine.hardRecover().then((outcome) => escalate(outcome === 'ok' ? 'ok' : 'failed'));
            }
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
    }, [audioUrl, playing, playable, playId, recoverPlayback, markInterrupted]);
}
