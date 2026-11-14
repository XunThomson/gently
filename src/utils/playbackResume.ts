/**
 * 恢复播放时「要不要重新解析流地址」的判定（纯函数，冒烟可直接钉住）。
 *
 * 背景（R141 真机反馈）：安卓把应用放后台很久以后，媒体管道可能已经被系统回收，
 * 但 store 里仍然留着旧 `audioUrl` 与 `playable:true`。此时只把 `playing` 翻成 true，
 * 界面会切到「播放中」，媒体元素却起不来——进度条一动不动。
 *
 * 因此恢复播放前先问四件事：
 * 1. 有没有地址（没有当然要解析）；
 * 2. 这次暂停是不是已经很久（旧地址的 token / 直链大概率过期）；
 * 3. 媒体元素是否已经进了 error 态；
 * 4. 元素是否「以为自己在播、位置却不动」（被系统掐断后的僵死）。
 */
export const LONG_PAUSE_REFRESH_MS = 30_000;

export interface ResumeHealth {
    /** 距离按下暂停过去了多少毫秒；没有暂停记录时为 `null` */
    pausedForMs: number | null;
    hasAudioUrl: boolean;
    /** 媒体元素已产生 `MediaError` */
    hadError: boolean;
    /** 媒体元素以为在播、位置却不再前进 */
    stalled: boolean;
}

/** 恢复播放前是否需要让核心重新解析一次地址 */
export function shouldRefreshStreamOnResume(health: ResumeHealth): boolean {
    if (!health.hasAudioUrl || health.hadError || health.stalled) return true;
    return health.pausedForMs !== null && health.pausedForMs >= LONG_PAUSE_REFRESH_MS;
}
