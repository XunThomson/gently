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

    private emitEnded = () => this.handlers.onEnded?.();

    private emitError = () => {
        const err = this.el?.error;
        this.handlers.onError?.(err ? `code ${err.code}` : 'unknown media error');
    };

    /** 切换音源；URL 相同时不重新加载，避免打断连续播放 */
    load(url: string): void {
        const el = this.ensure();
        if (!el) return;
        if (el.dataset.src === url) return;

        el.dataset.src = url;
        el.src = url;
        this.safeSetVolume(el);
        el.load();
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
}

export const audioEngine = new AudioEngine();
