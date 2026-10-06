import type {ThemeMode} from '../theme/types';
import type {SourceDisplayMode, SourceFilterStyle, TrackQuality} from '../types';

/**
 * UI 偏好持久化（主题 + 音源展示方式）。
 * 非浏览器环境（冒烟测试 / SSR）下为安全空操作。
 */

const STORAGE_KEY = 'gently:ui';

export interface PersistedUi {
    themeMode?: ThemeMode;
    themePresetId?: string;
    sourceDisplay?: SourceDisplayMode;
    sourceFilterStyle?: SourceFilterStyle;
    preferredSource?: string | null;
    preferredQuality?: TrackQuality;
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
