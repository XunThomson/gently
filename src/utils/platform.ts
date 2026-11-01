/**
 * 平台判定（只服务**渲染决策**）。
 *
 * 为什么不用 `system.status.platform`（那里也有 `android-<arch>`）：
 * 它是异步的，而外壳形态必须在**首帧**就定下来，否则会先闪一下桌面三栏再跳到移动外壳。
 * 所以这里用一个同步判定（安卓 WebView 的 UA 必然含 `Android`）；
 * 数据能力（能不能读核心、核心是什么平台）仍一律以 `system.status` 为准，不在这里重复。
 *
 * 桌面端恒为 `desktop`（Windows / macOS / Linux 的 UA 里没有 `Android`）。
 */
export type AppPlatform = 'desktop' | 'mobile';

export function detectPlatform(): AppPlatform {
    if (typeof navigator === 'undefined') return 'desktop';
    return /android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

/** 常见用法的便捷判断（外壳、窗口能力、桥的开关都按它分支） */
export function isMobilePlatform(): boolean {
    return detectPlatform() === 'mobile';
}
