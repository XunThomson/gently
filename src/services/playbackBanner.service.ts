/**
 * 手机上的「播放通知 / 前台服务」同步（P2-1 · R112）。
 *
 * 为什么需要它：真机实测（`docs/ANDROID-PLAN.md` §7.4）表明，熄屏或切到后台后，
 * 系统会把 WebView 里的媒体挂起——先音频停住，时间再长一点直接回收渲染进程。
 * 把应用提到「前台服务」档次，系统才会把它当「正在放音的应用」。
 *
 * 边界（刻意做小）：
 * - 只在**手机宿主**上做（桌面端/浏览器里是空操作，不产生任何 IPC）；
 * - 只在「开始播放 / 停止播放 / 换歌」时推一次，**不跟随进度**——
 *   播放状态仍以前端 store 为唯一权威，Kotlin 那边只是输出层；
 * - 失败只打一条 warn：通知起不来不该影响播放本身。
 */

let lastSynced = '';

/**
 * 同步播放通知。
 *
 * @param active 是否正在播放（false 时关掉前台服务）
 * @param title  当前曲目标题（空串表示没有曲目）
 * @param artist 当前曲目歌手
 */
export async function syncPlaybackBanner(
    active: boolean,
    title: string,
    artist: string,
): Promise<void> {
    if (typeof window === 'undefined') return;
    /* 只在「Tauri 宿主 + 手机平台」上调用：桌面端那条命令虽然是空操作，
       但没有理由为它付出一次无用的 IPC；浏览器预览里更是没有宿主。 */
    if (!('__TAURI_INTERNALS__' in window)) return;

    const key = `${active ? 1 : 0}|${title}|${artist}`;
    if (key === lastSynced) return;
    lastSynced = key;

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        await invoke('playback_banner', {active, title, artist});
    } catch (err) {
        // 失败就允许下次重试（比如服务还没起、或 API 级别不允许前台服务）
        lastSynced = '';
        console.warn('[playback] 播放通知同步失败', err);
    }
}
