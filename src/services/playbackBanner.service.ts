/**
 * 手机上的「播放通知 / 前台服务 / MediaSession」同步 + 传输动作回调（P2 · R112/R115）。
 *
 * 为什么需要它：真机实测（`docs/ANDROID-PLAN.md` §7.4）表明，熄屏或切到后台后，
 * 系统会把 WebView 里的媒体挂起——先音频停住，时间再长一点直接回收渲染进程。
 * 把应用提到「前台服务」档次，系统才会把它当「正在放音的应用」。
 *
 * 两个方向（边界刻意做小）：
 * - **页面 → 原生**：`syncPlaybackBanner()` 只在「在播 / 停 / 换歌」时推一次（不跟随进度）；
 * - **原生 → 页面**：`installMediaActionHandler()` 装一个全局函数，通知栏 / 锁屏 / 耳机键
 *   的按钮由 Kotlin 侧 `evaluateJavascript` 调它，前端再去改 store——
 *   **原生不拥有播放状态**，它只显示与转发。
 * - 失败只打一条 warn：通知起不来不该影响播放本身。
 */

/** 原生能派发的传输动作（与 Kotlin `MediaActionBridge` 的字符串一一对应） */
export type MediaAction = 'toggle' | 'next' | 'prev';

/** 页面里那个全局函数的键名（原生侧硬编码同一个名字） */
const HANDLER_KEY = '__gentlyMediaAction';

let lastSynced = '';

/**
 * 去重用的键（纯函数，冒烟直接钉）。
 *
 * 只有这四项变化才值得一次 IPC：`active`（服务起停）、`playing`（按钮图标）、
 * `title`/`artist`（换歌）、`line`（**歌词换行**，R116 起通知第二行显示当前歌词）。
 * 位置不在这里——它每秒都在变，绝不能进键。
 */
export function playbackBannerKey(
    active: boolean,
    playing: boolean,
    title: string,
    artist: string,
    line: string,
): string {
    return `${active ? 1 : 0}|${playing ? 1 : 0}|${title}|${artist}|${line}`;
}

/**
 * 同步播放通知（含 MediaSession 的元数据与播放态，以及通知栏歌词）。
 *
 * @param active  是否有当前曲目（false 时关掉前台服务）
 * @param title   当前曲目标题（空串表示没有曲目）
 * @param artist  当前曲目歌手
 * @param playing 是否在播（决定通知按钮与锁屏控件显示「播放」还是「暂停」）
 * @param line    当前歌词行（没有歌词时给空串 → 通知第二行退回歌手）
 */
export async function syncPlaybackBanner(
    active: boolean,
    title: string,
    artist: string,
    playing: boolean,
    line = '',
): Promise<void> {
    if (typeof window === 'undefined') return;
    /* 只在「Tauri 宿主」上调用：桌面端那条命令是空操作，浏览器里更没有宿主。 */
    if (!('__TAURI_INTERNALS__' in window)) return;

    const key = playbackBannerKey(active, playing, title, artist, line);
    if (key === lastSynced) return;
    lastSynced = key;

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        await invoke('playback_banner', {active, title, artist, playing, line});
    } catch (err) {
        // 失败就允许下次重试（比如服务还没起、或 API 级别不允许前台服务）
        lastSynced = '';
        console.warn('[playback] 播放通知同步失败', err);
    }
}

/**
 * 安装「原生 → 页面」的传输动作回调，返回卸载函数。
 *
 * 只在有 Tauri 宿主时挂：浏览器里那个全局函数没有任何调用方，
 * 挂上去只会让「页面有个看不见的入口」，排查时反而迷惑。
 */
export function installMediaActionHandler(
    handler: (action: MediaAction) => void,
): () => void {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
        return () => undefined;
    }

    const target = window as unknown as Record<string, unknown>;
    target[HANDLER_KEY] = (action: unknown) => {
        if (action === 'toggle' || action === 'next' || action === 'prev') handler(action);
    };

    return () => {
        delete target[HANDLER_KEY];
    };
}
