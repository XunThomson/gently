import {useSyncExternalStore} from 'react';
import {appConfig} from '../config/app.config';

export interface WindowSize {
    width: number;
    height: number;
}

/**
 * 屏幕 / 窗口尺寸的兜底值（SSR、首帧）。
 *
 * 和 `appConfig.window.normal` 保持一致：首帧按完整界面排版，
 * 等 `resize` / 真实测量到位后再决定要不要收起外壳，避免启动时闪一下迷你播放器。
 */
const FALLBACK: WindowSize = {
    width: appConfig.window.normal.width,
    height: appConfig.window.normal.height,
};

let cached: WindowSize | null = null;

function read(): WindowSize {
    if (typeof window === 'undefined') return FALLBACK;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!cached || cached.width !== width || cached.height !== height) {
        cached = {width, height};
    }
    return cached;
}

function subscribe(onChange: () => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
}

/** 供 `useShellMode` 订阅同一个 resize 源；不要把监听器复制成第二份。 */
export {subscribe as subscribeWindowSize};

/**
 * 订阅窗口逻辑尺寸。
 *
 * 用 `useSyncExternalStore` 而不是 `useState + useEffect`：
 * 首帧就能拿到真实尺寸（不会先渲染一次假宽度再纠正），
 * 且 `resize` 高频触发时由 React 合并重渲染。
 * 快照是**同一个对象引用**（只有尺寸变化才换新对象），否则会无限重渲染。
 */
export function useWindowSize(): WindowSize {
    return useSyncExternalStore(subscribe, read, () => FALLBACK);
}
