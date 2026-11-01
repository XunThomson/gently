/**
 * 音频播放引擎。
 *
 * 把 `<audio>` 元素这一浏览器副作用封装在服务层：
 * store 只保存事实（playable / audioUrl / elapsed），UI 只派发命令。
 * 非浏览器环境（冒烟测试 / SSR）下所有方法都是安全空操作。
 */

export interface AudioHandlers {
    /** 播放进度（秒） */
    onTime?: (currentTime: number, duration: number) => void;
    /** 自然播放结束 */
    onEnded?: () => void;
    /** 加载 / 解码 / 自动播放策略失败：调用方应回退到模拟时钟 */
    onError?: (message: string) => void;
}

class AudioEngine {
    private el: HTMLAudioElement | null = null;
    private handlers: AudioHandlers = {};
    private volume = 1;

    setHandlers(handlers: AudioHandlers): void {
        this.handlers = handlers;
    }

    /** 惰性创建音频元素；非浏览器环境返回 null */
    private ensure(): HTMLAudioElement | null {
        if (this.el) return this.el;
        if (typeof window === 'undefined' || typeof window.Audio !== 'function') return null;

        const el = new window.Audio();
        el.preload = 'metadata';
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
        this.safeSetVolume(el);
        el.load();
    }

    /** 硬重载当前地址（不看 `dataset.src` 的去重）：媒体出错后的第一步恢复手段 */
    reload(): void {
        const el = this.el;
        const url = el?.dataset.src;
        if (!el || !url) return;
        el.src = url;
        this.safeSetVolume(el);
        el.load();
    }

    /**
     * 试着从「被系统中断」的状态里恢复播放（窗口重新聚焦 / 页面重新可见时调用）。
     *
     * - `ok`：元素只是被暂停了，直接播起来；
     * - `reloaded`：元素处在 error 状态，硬重载后播起来了；
     * - `failed`：这个地址真的不能用了——调用方应让核心**重新解析**一次（进度保留）。
     */
    async resume(): Promise<'ok' | 'reloaded' | 'failed'> {
        const el = this.ensure();
        if (!el || !el.dataset.src) return 'failed';

        if (!el.error) {
            try {
                await el.play();
                return 'ok';
            } catch {
                /* 落到下面的硬重载 */
            }
        }

        try {
            this.reload();
            await el.play();
            return 'reloaded';
        } catch {
            return 'failed';
        }
    }

    play(): void {
        const el = this.ensure();
        if (!el) return;
        const result = el.play();
        if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => {
                this.handlers.onError?.(err instanceof Error ? err.message : String(err));
            });
        }
    }

    pause(): void {
        this.el?.pause();
    }

    seek(seconds: number): void {
        const el = this.el;
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
     * 元素是否处在**错误态**（`MediaError` 已产生）。
     *
     * 与「暂停」区分开很关键：暂停是用户要的状态，错误是地址/解码真的坏了。
     * 前者重载多少次都没意义，后者只有重新解析地址（换新 URL）才能救回来。
     */
    hadError(): boolean {
        return Boolean(this.el?.error);
    }
}

export const audioEngine = new AudioEngine();
