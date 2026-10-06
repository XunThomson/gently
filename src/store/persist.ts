import type {ThemeMode} from '../theme/types';

/**
 * UI 偏好持久化（主题模式 / 主题市场预设）。
 * 非浏览器环境（冒烟测试 / SSR）下为安全空操作。
 */

const STORAGE_KEY = 'gently:ui';

export interface PersistedUi {
    themeMode?: ThemeMode;
    themePresetId?: string;
}

export function readPersistedUi(): PersistedUi {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as PersistedUi;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function writePersistedUi(ui: PersistedUi): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
    } catch {
        /* 忽略隐私模式 / 配额限制 */
    }
}
