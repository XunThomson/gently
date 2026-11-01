import {useSyncExternalStore} from 'react';
import {appConfig} from '../config/app.config';
import {detectPlatform} from '../utils/platform';
import {resolveShellMode, type ShellMode} from '../utils/shellMode';
import {subscribeWindowSize} from './useWindowSize';

/**
 * 当前外壳形态（平台 + 窗口尺寸驱动）。
 *
 * **只返回形态字符串**，不返回宽高：快照是稳定字符串时，`useSyncExternalStore`
 * 只在跨过断点时才通知 App 重渲染；返回宽高会让每次 `resize` 事件都重渲染外壳
 * （窗口拖动 2 秒可达上百次，而形态通常只变 0–2 次）。
 *
 * 平台是同步判定的常量（见 `utils/platform.ts`），所以手机上第一帧就是 `mobile`，
 * 不会先闪一下桌面三栏再跳过去。
 */
function readShellMode(): ShellMode {
    if (typeof window === 'undefined') return 'regular';
    return resolveShellMode(
        window.innerWidth,
        window.innerHeight,
        appConfig.window.breakpoints,
        detectPlatform(),
    );
}

export function useShellMode(): ShellMode {
    return useSyncExternalStore(
        subscribeWindowSize,
        readShellMode,
        () => 'regular',
    );
}
