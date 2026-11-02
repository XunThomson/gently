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
 * 变化了才值得一次 IPC：`active`（服务起停）、`playing`（按钮图标）、
 * `title`/`artist`（换歌）、`line`（**歌词换行**，R116 起通知第二行显示当前歌词）、
 * `position`/`duration`（**进度跳变**：拖进度条、续播、暂停那一刻，R117）。
 *
 * 位置**不进**这个键的日常来源——`elapsed` 每秒都在变，订阅它会把整棵外壳每秒重渲染好几次；
 * 调用方只在「播放 / 暂停 / 换歌 / 换歌词行 / 拖了进度」时调用本函数，位置按需从 store 读。
 */
export function playbackBannerKey(
    active: boolean,
    playing: boolean,
    title: string,
    artist: string,
    line: string,
    positionMs = 0,
    durationMs = 0,
): string {
    return `${active ? 1 : 0}|${playing ? 1 : 0}|${title}|${artist}|${line}|${positionMs}|${durationMs}`;
}

/**
 * 把当前曲目也写进**页面自己的** `navigator.mediaSession`（R137）。
 *
 * 为什么要多这一步：Android WebView（Chromium）判断「这次播放算不算后台媒体」时会看页面的
 * MediaSession；页面没有活动会话时，activity 一进后台它就把 `<audio>` 暂停，而之后页面再
 * `play()` 会被 autoplay 门禁拒掉（真机 logcat：`HwMedia::Play hbs_autoplay_ = 0`）。
 * 这里只挂元数据与播放态（通知仍是原生那条 MediaStyle，不抢它），拿不到就静默跳过——
 * 桌面端 / 老 WebView 没有这个 API 也不该报错。
 */
function syncPageMediaSession(title: string, artist: string, playing: boolean): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
        const session = navigator.mediaSession;
        const MediaMetadataCtor = (window as unknown as {MediaMetadata?: new (init: MediaMetadataInit) => MediaMetadata}).MediaMetadata;
        if (MediaMetadataCtor) {
            session.metadata = new MediaMetadataCtor({title, artist, album: ''});
        }
        /* `playbackState` 只在真在播/暂停时设：'none' 会让系统以为这条会话不在了 */
        session.playbackState = playing ? 'playing' : 'paused';
    } catch {
        /* 某些 WebView 会对 metadata 抛（不是标准错误），不影响播放，忽略 */
    }
}

/**
 * 同步播放通知（含 MediaSession 的元数据与播放态、通知栏歌词、进度）。
 *
 * @param active     是否有当前曲目（false 时关掉前台服务）
 * @param title      当前曲目标题（空串表示没有曲目）
 * @param artist     当前曲目歌手
 * @param playing    是否在播（决定通知按钮与锁屏控件显示「播放」还是「暂停」）
 * @param line       当前歌词行（没有歌词时给空串 → 通知第二行退回歌手）
 * @param positionMs 已播放毫秒数（给锁屏 / 车机画进度；播放中由系统按 1× 速度自行推算）
 * @param durationMs 总时长毫秒数（0 表示未知 → 原生侧不画进度条）
 */
export async function syncPlaybackBanner(
    active: boolean,
    title: string,
    artist: string,
    playing: boolean,
    line = '',
    positionMs = 0,
    durationMs = 0,
): Promise<void> {
    if (typeof window === 'undefined') return;
    /* 页面自己的 MediaSession 与宿主无关：桌面端/浏览器顺手也同步一份（无害） */
    syncPageMediaSession(title, artist, playing);

    /* 只在「Tauri 宿主」上调用：桌面端那条命令是空操作，浏览器里更没有宿主。 */
    if (!('__TAURI_INTERNALS__' in window)) return;

    const key = playbackBannerKey(active, playing, title, artist, line, positionMs, durationMs);
    if (key === lastSynced) return;
    lastSynced = key;

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        await invoke('playback_banner', {
            active,
            title,
            artist,
            playing,
            line,
            /* 毫秒整数：Kotlin 侧不做浮点换算，也就没有「四舍五入在哪一侧」的分歧 */
            position: Math.max(0, Math.round(positionMs)),
            duration: Math.max(0, Math.round(durationMs)),
        });
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
