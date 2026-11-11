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
    /**
     * 「发现」视图聚焦时是否自动试听高潮片段（默认开启）。
     * 显式可关：有人不希望鼠标划过一首歌就出声。
     */
    discoverAutoPreview?: boolean;
    /** 宠物实验开关（默认关；2.x 形态，1.x 阶段只用于预开发验证） */
    petEnabled?: boolean;
    /** 移动端「主页」路径（启动后根路径重定向到这里） */
    homePath?: string;
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

/**
 * 清空全部 UI 设置（设置页「恢复默认设置」）。
 *
 * 只删 `gently:ui`：本地音乐、插件、下载文件、凭据都在核心的数据库/文件里，
 * 不在这里。清完由调用方 reload，让主题/背景/音源等全部回到默认值。
 */
export function resetPersistedUi(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(STORAGE_KEY);
        /* 语言由 i18next 单独持久化（键名 `lang`），也属于界面设置 */
        window.localStorage.removeItem('lang');
    } catch {
        /* 清不掉就保持现状，由设置页的二次确认兜底 */
    }
}
