/**
 * 音频播放引擎。
 *
 * 把 `<audio>` 元素这一浏览器副作用封装在服务层：
 * store 只保存事实（playable / audioUrl / elapsed），UI 只派发命令。
 * 非浏览器环境（冒烟测试 / SSR）下所有方法都是安全空操作。
 */

import {isStalled, STALL_THRESHOLD_MS, type StallSample} from '../utils/playbackStall';

export interface AudioHandlers {
    /** 播放进度（秒） */
    onTime?: (currentTime: number, duration: number) => void;
    /** 自然播放结束 */
    onEnded?: () => void;
    /** 加载 / 解码 / 自动播放策略失败：调用方应回退到模拟时钟 */
    onError?: (message: string) => void;
}

/**
 * `play()` 的等待上限。
 *
 * 为什么要给它一个上限：安卓上「锁屏 / 后台一段时间」之后，媒体管道会被系统掐掉，
 * 此时 `play()` 返回的 Promise **既不 resolve 也不 reject**（实测真机：唤醒后
 * 二十多秒仍挂在那里）。谁 await 它就永远不会往下走——看门狗拿不到结果，
 * 于是界面一直显示「播放中」、进度纹丝不动，用户只能杀掉重来（R111 真机定位）。
 */
const PLAY_TIMEOUT_MS = 3000;

/** `play()` 的三种结局：真的开始播 / 明确被拒 / 超时（管道坏了） */
type PlayOutcome = 'ok' | 'rejected' | 'timeout';

class AudioEngine {
    private el: HTMLAudioElement | null = null;
    private handlers: AudioHandlers = {};
    private volume = 1;
    /** 最近一次「位置真的变了」的采样（僵死判定用） */
    private lastSample: StallSample | null = null;
    /**
     * 歌词页律动用的音频图（R139）。
     *
     * **只在 AudioContext 真的 running 时才接线**：`createMediaElementSource` 会把媒体元素
     * 的输出永久改道进音频图——上下文若停在 suspended，声音就没了。所以先 resume，
     * 确认 running 才建 source；建不了就什么都不做（返回 null，画面退回一条直线）。
     */
    private audioCtx: AudioContext | null = null;
    private analyserNode: AnalyserNode | null = null;
    private mediaSource: MediaElementAudioSourceNode | null = null;
    private analyserPending: Promise<AnalyserNode | null> | null = null;

    setHandlers(handlers: AudioHandlers): void {
        this.handlers = handlers;
    }

    /** 惰性创建音频元素；非浏览器环境返回 null */
    private ensure(): HTMLAudioElement | null {
        if (this.el) return this.el;
        if (typeof window === 'undefined' || typeof window.Audio !== 'function') return null;

        const el = new window.Audio();
        el.preload = 'metadata';
        /* 回环媒体代理对 local / remote 都回了 `Access-Control-Allow-Origin: *`（core/src/media.rs）。
           律动只对接了 Web Audio 的音频有效；不声明 CORS 的话 createMediaElementSource 会静音。
           必须在设置 src 之前设，之后改会要求重新 load。 */
        el.crossOrigin = 'anonymous';
        el.addEventListener('timeupdate', this.emitTime);
        el.addEventListener('durationchange', this.emitTime);
        el.addEventListener('loadedmetadata', this.emitTime);
        el.addEventListener('ended', this.emitEnded);
        el.addEventListener('error', this.emitError);

        this.el = el;
        return el;
    }

    private emitTime = () => {
        const el = this.el;
        if (!el) return;
        const duration = Number.isFinite(el.duration) ? el.duration : 0;
        /* 位置变了就记一笔：僵死判定（`isStalled`）靠这组采样，而不是靠 `paused`
           ——元素可能「以为自己在播」，位置却一动不动（R111 真机）。 */
        if (!this.lastSample || this.lastSample.position !== el.currentTime) {
            this.lastSample = {position: el.currentTime, at: Date.now()};
        }
        this.handlers.onTime?.(el.currentTime, duration);
    };

    private emitEnded = () => {
        this.handlers.onEnded?.();
    };    private emitError = () => {
        const err = this.el?.error;
        this.handlers.onError?.(err ? `code ${err.code}` : 'unknown media error');
    };

    /**
     * 切换音源；URL 相同时不重新加载，避免打断连续播放。
     *
     * 地址一律是核心回环流代理的 `http://127.0.0.1:<port>/m/<token>`：
     * `Content-Type` 由代理按扩展名补齐（上游给 `application/octet-stream` 时也是），
     * 因此这里**不需要**再抓成 Blob 强制 `audio/mp4`——M3 的退出标准就是删掉那条路径。
     */
    load(url: string): void {
        const el = this.ensure();
        if (!el) return;
        /* 同一地址不重复 load，避免打断连续播放。**但元素已经进入 error 时必须重来**：
           媒体元素一旦报错就再也 play() 不起来，只有 load() 能把它拉回可用状态
           （电脑休眠回来、流地址过期之后就是这种状态）。 */
        if (el.dataset.src === url && !el.error) return;

        el.dataset.src = url;
        el.src = url;
        this.lastSample = null;
        this.safeSetVolume(el);
        el.load();
    }

    /** 硬重载当前地址（不看 `dataset.src` 的去重）：媒体出错后的第一步恢复手段 */
    reload(): void {
        const el = this.el;
        const url = el?.dataset.src;
        if (!el || !url) return;
        el.src = url;
        this.lastSample = null;
        this.safeSetVolume(el);
        el.load();
    }

    /**
     * 「位置卡住了」的第一次抢救：**先硬重载再播**。
     *
     * 与 `resume()` 的分工：`resume()` 面向「元素停着」（`paused`），这里面向
     * 「元素以为自己在播、位置却不动」（R111 真机上的僵死）。这种状态先 `reload()`
     * 才可能把管道拉回来——单纯 `play()` 会立刻「成功」（因为它本来就没暂停）。
     */
    async hardRecover(): Promise<'ok' | 'failed'> {
        const el = this.ensure();
        if (!el || !el.dataset.src) return 'failed';
        try {
            this.reload();
        } catch {
            return 'failed';
        }
        return (await this.tryPlay(el)) === 'ok' ? 'ok' : 'failed';
    }

    /**
     * 带超时的 `play()`：**绝不让调用方无限等**（见 `PLAY_TIMEOUT_MS` 的注释）。
     *
     * 超时不算失败结论——调用方（看门狗）会决定是重载、重新解析还是如实停表。
     */
    private tryPlay(el: HTMLAudioElement): Promise<PlayOutcome> {
        let timer: number | undefined;
        const timeout = new Promise<PlayOutcome>((resolve) => {
            timer = window.setTimeout(() => resolve('timeout'), PLAY_TIMEOUT_MS);
        });
        const started = Promise.resolve()
            .then(() => el.play())
            .then<PlayOutcome>(() => 'ok')
            .catch<PlayOutcome>(() => 'rejected');
        return Promise.race([started, timeout]).finally(() => {
            if (timer !== undefined) window.clearTimeout(timer);
        });
    }

    /**
     * 试着从「被系统中断」的状态里恢复播放（窗口重新聚焦 / 页面重新可见 / 看门狗轮询）。
     *
     * - `ok`：元素只是被暂停了，直接播起来；
     * - `reloaded`：元素处在 error 态（或 play 超时），硬重载后播起来了；
     * - `failed`：这个地址真的不能用了——调用方应让核心**重新解析**一次（进度保留），
     *   若连重新解析也不行，就该如实停表而不是继续显示「播放中」。
     */
    async resume(): Promise<'ok' | 'reloaded' | 'failed'> {
        const el = this.ensure();
        if (!el || !el.dataset.src) return 'failed';

        if (!el.error) {
            if ((await this.tryPlay(el)) === 'ok') return 'ok';
        }

        try {
            this.reload();
            return (await this.tryPlay(el)) === 'ok' ? 'reloaded' : 'failed';
        } catch {
            return 'failed';
        }
    }

    play(): void {
        const el = this.ensure();
        if (!el) return;
        void this.tryPlay(el).then((outcome) => {
            /* 超时不在这里报错：那会把「系统掐断」误报成「这个源坏了」，
               于是白白换源。留给看门狗判断（它会先重载、再重新解析、最后才停表）。 */
            if (outcome === 'rejected') this.handlers.onError?.('播放被拒（自动播放策略或地址失效）');
        });
    }

    pause(): void {
        this.el?.pause();
    }

    /**
     * 后台专用：只叫一声 `play()`，**不重载、不报错**（R137）。
     *
     * 为什么不能复用 `resume()`：它会「播不动就先 `reload()`」——而华为/EMUI 的 WebView
     * 在页面不可见时会拒绝 `play()`（logcat：`HwMedia::Play hbs_autoplay_ = 0`），于是每 5 秒
     * 重载一次，进度被反复清零（真机实测：熄屏 150 秒后进度只走到 13 秒）。
     * 后台只尝试「叫一声」，失败就算了——回到前台后 `visibilitychange` 再走正规恢复流程。
     */
    nudge(): void {
        const el = this.el;
        if (!el || !el.dataset.src) return;
        void el.play().catch(() => undefined);
    }

    seek(seconds: number): void {
        /* **不要**因为元素还没建就放弃：恢复上次播放位置（R113）时，
           调用顺序是「先 seek 再 load」——此时引擎还是新的、`el` 为 null，
           如果直接 return，用户点播放就会从 0 开始（真机实测过：恢复 30 秒，点了从 0 播）。
           用 `ensure()` 建出来，下面的 `readyState === 0` 分支会把定位挂到 `loadedmetadata` 上。 */
        const el = this.ensure();
        if (!el) return;

        const apply = () => {
            try {
                el.currentTime = Math.max(0, seconds);
            } catch (err) {
                this.handlers.onError?.(err instanceof Error ? err.message : String(err));
            }
        };

        // 元数据尚未就绪时写入 currentTime 可能被忽略，等 metadata 后再定位
        if (el.readyState === 0) el.addEventListener('loadedmetadata', apply, {once: true});
        else apply();
    }

    private safeSetVolume(el: HTMLAudioElement) {
        try {
            el.volume = Math.min(1, Math.max(0, this.volume));
        } catch {
            /* 某些容器下 volume 只读，忽略 */
        }
    }

    setVolume(volume: number): void {
        this.volume = Math.min(1, Math.max(0, volume));
        if (this.el) this.safeSetVolume(this.el);
    }

    /** 当前媒体时间（秒）；没有元素时为 0。看门狗用它判断「进度到底有没有在走」 */
    currentTime(): number {
        return this.el?.currentTime ?? 0;
    }

    /** 元素是否还停着（没有元素也算停着） */
    isPausedNow(): boolean {
        return !this.el || this.el.paused;
    }

    /**
     * 元素是否**以为自己在播、位置却不动**（僵死）。
     *
     * 与 `isPausedNow()` 互补：安卓锁屏/后台一段时间后，元素既不报错也不暂停，
     * 只是 `currentTime` 再也不前进——只看 `paused` 会漏掉这种，界面就永远「播放中」。
     */
    isStalledNow(thresholdMs: number = STALL_THRESHOLD_MS): boolean {
        const el = this.el;
        if (!el || !el.dataset.src) return false;
        if (el.error || el.paused) return false;
        return isStalled(this.lastSample, el.currentTime, Date.now(), thresholdMs);
    }

    /**
     * 元素是否处在**错误态**（`MediaError` 已产生）。
     *
     * 与「暂停」区分开很关键：暂停是用户要的状态，错误是地址/解码真的坏了。
     * 前者重载多少次都没意义，后者只有重新解析地址（换新 URL）才能救回来。
     */
    hadError(): boolean {
        return Boolean(this.el?.error);
    }

    /**
     * 取歌词页律动用的 AnalyserNode（R139）。
     *
     * - 同一次会话里只建一条图；
     * - **上下文不是 running 就返回 null**，绝不在 suspended 状态下接线（那会把正在播的声音掐掉）；
     * - 返回 null 不是错误：歌词页退回「一条静止的直线」，用户下一次点击（手势）会再试一次。
     */
    async ensureAnalyser(): Promise<AnalyserNode | null> {
        if (this.analyserNode) return this.analyserNode;
        if (this.analyserPending) return this.analyserPending;

        const el = this.ensure();
        if (!el) return null;
        const Ctor =
            typeof window === 'undefined'
                ? undefined
                : window.AudioContext ??
                  (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
        if (!Ctor) return null;

        this.analyserPending = (async () => {
            try {
                if (!this.audioCtx) this.audioCtx = new Ctor();
                const ctx = this.audioCtx;
                if (ctx.state === 'suspended') {
                    /* 不 await 一个可能永远挂起的 resume：和 play() 的超时守卫同理 */
                    await Promise.race([
                        ctx.resume().catch(() => undefined),
                        new Promise<void>((resolve) => window.setTimeout(resolve, 800)),
                    ]);
                }
                /* 关键守卫：没有 running 就不建 source（见字段注释） */
                if (ctx.state !== 'running') return null;

                if (!this.mediaSource) this.mediaSource = ctx.createMediaElementSource(el);
                if (!this.analyserNode) {
                    const analyser = ctx.createAnalyser();
                    analyser.fftSize = 1024;
                    analyser.smoothingTimeConstant = 0.8;
                    /* 元素被改道后必须接回 destination，否则正常播放会没声音 */
                    this.mediaSource.connect(analyser);
                    analyser.connect(ctx.destination);
                    this.analyserNode = analyser;
                }
                return this.analyserNode;
            } catch (err) {
                console.warn('[audio] 律动分析器创建失败，退回静态画面', err);
                return null;
            } finally {
                this.analyserPending = null;
            }
        })();
        return this.analyserPending;
    }
}

export const audioEngine = new AudioEngine();
