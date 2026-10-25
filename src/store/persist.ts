import type {ThemeMode, ThemeSkin} from '../theme/types';
import type {BackgroundSettings} from '../utils/backgroundSettings';
import type {
    DownloadQualityFallback,
    SourceDisplayMode,
    SourceFilterStyle,
    TrackQuality,
} from '../types';

/**
 * UI 偏好持久化（主题 / 音源 / 皮肤 / 确认开关）。
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
    confirmDestructive?: boolean;
    /** 下载目录（空串 = 核心默认目录） */
    downloadDir?: string;
    downloadQuality?: TrackQuality;
    downloadQualityFallback?: DownloadQualityFallback;
    downloadMaxConcurrent?: number;
    /** 用户导入的皮肤（体积小，直接存本地） */
    customSkins?: ThemeSkin[];
    /** 背景元数据 + 展示参数 + 预设（视频 / 网页正文在 IndexedDB，不进 localStorage） */
    background?: BackgroundSettings;
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
