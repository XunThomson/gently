import {appConfig} from '../config/app.config';

/**
 * 背景（P1：本地视频 + 展示参数预设）。
 *
 * 这里只定义**可持久化的数据形状与归一化规则**；真正的视频 Blob 存在 IndexedDB
 * （`services/background.service.ts`），localStorage 只存元数据与预设。
 * 从 localStorage / 剪贴板 / 外部 JSON 进来的值一律走 `normalize*`，不信任输入。
 */
export type BackgroundFit = 'cover' | 'contain';
export type BackgroundKind = 'video' | 'web';

export interface BackgroundAsset {
    id: string;
    name: string;
    /** 字节数（展示与上限校验） */
    size: number;
    /** 原始 MIME（可能为空，导入时已按扩展名校验） */
    type: string;
    importedAt: number;
}

/** 单文件网页壁纸的元数据；HTML 正文在 IndexedDB `pages` 里。 */
export interface WebAsset {
    id: string;
    name: string;
    size: number;
}

export interface BackgroundOptions {
    fit: BackgroundFit;
    /** 0.25~2 */
    playbackRate: number;
    /** null = 跟随主题的 background.opacity */
    opacity: number | null;
    /** null = 跟随主题的 background.blurPx */
    blurPx: number | null;
    /**
     * 内容表面（卡片/外壳）的背景不透明度；null = 跟随主题的 background.contentOpacity。
     * 只作用于 `--surface-chrome` 的 alpha，不改变文字/图标。
     */
    contentOpacity?: number | null;
    /**
     * 内容表面（卡片/外壳）的背景虚化半径（px）；null = 跟随主题的 background.surfaceBlurPx。
     * 只作用于 `--surface-blur`（backdrop-filter），不改变文字。
     */
    contentBlurPx?: number | null;
    /**
     * 抽屉/浮层（菜单、面板、搜索建议）的背景不透明度；
     * null = 跟随主题的 background.drawerOpacity。与内容表面独立。
     */
    drawerOpacity?: number | null;
    /**
     * 抽屉/浮层的背景虚化半径（px）；null = 跟随主题的 background.drawerBlurPx。
     * 与内容表面的虚化独立。
     */
    drawerBlurPx?: number | null;
}

export interface BackgroundPreset {
    id: string;
    name: string;
    options: BackgroundOptions;
    /** 外部 JSON 里未能映射的键名（保留但不应用） */
    unmapped: string[];
    createdAt: number;
}

export interface BackgroundSettings {
    enabled: boolean;
    /**
     * 系统开启 `prefers-reduced-motion` 时是否仍播放。
     * 默认 false（尊重系统设置），但用户可以在设置页显式覆盖——
     * 系统动画偏好不该替用户决定壁纸是否播放。
     */
    playWhenReducedMotion: boolean;
    /** 当前背景类型；两种素材都保留，切换时不需要重新导入 */
    kind: BackgroundKind;
    asset: BackgroundAsset | null;
    web: WebAsset | null;
    options: BackgroundOptions;
    presets: BackgroundPreset[];
    activePresetId: string | null;
}

export const DEFAULT_BACKGROUND_OPTIONS: BackgroundOptions = {
    fit: 'cover',
    playbackRate: 1,
    opacity: null,
    blurPx: null,
    contentOpacity: null,
    contentBlurPx: null,
    drawerOpacity: null,
    drawerBlurPx: null,
};

const MAX_PRESETS = 30;
const MAX_NAME = 40;
const MAX_UNMAPPED = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function clampPlaybackRate(value: number): number {
    const {minPlaybackRate, maxPlaybackRate} = appConfig.background;
    if (!Number.isFinite(value)) return 1;
    return Math.min(maxPlaybackRate, Math.max(minPlaybackRate, value));
}

export function normalizeBackgroundOptions(input: unknown): BackgroundOptions {
    if (!isRecord(input)) return {...DEFAULT_BACKGROUND_OPTIONS};
    const fit = input.fit === 'contain' ? 'contain' : 'cover';
    const rawRate = typeof input.playbackRate === 'number' ? input.playbackRate : 1;
    const opacity =
        typeof input.opacity === 'number' && Number.isFinite(input.opacity)
            ? Math.min(1, Math.max(0, input.opacity))
            : null;
    const blurPx =
        typeof input.blurPx === 'number' && Number.isFinite(input.blurPx)
            ? Math.min(appConfig.background.maxBlurPx, Math.max(0, input.blurPx))
            : null;
    const contentOpacity =
        typeof input.contentOpacity === 'number' && Number.isFinite(input.contentOpacity)
            ? Math.min(1, Math.max(appConfig.background.minContentOpacity, input.contentOpacity))
            : null;
    const contentBlurPx =
        typeof input.contentBlurPx === 'number' && Number.isFinite(input.contentBlurPx)
            ? Math.min(appConfig.background.maxBlurPx, Math.max(0, input.contentBlurPx))
            : null;
    const drawerOpacity =
        typeof input.drawerOpacity === 'number' && Number.isFinite(input.drawerOpacity)
            ? Math.min(1, Math.max(appConfig.background.minDrawerOpacity, input.drawerOpacity))
            : null;
    const drawerBlurPx =
        typeof input.drawerBlurPx === 'number' && Number.isFinite(input.drawerBlurPx)
            ? Math.min(appConfig.background.maxBlurPx, Math.max(0, input.drawerBlurPx))
            : null;
    return {
        fit,
        playbackRate: clampPlaybackRate(rawRate),
        opacity,
        blurPx,
        contentOpacity,
        contentBlurPx,
        drawerOpacity,
        drawerBlurPx,
    };
}

function normalizeAsset(input: unknown): BackgroundAsset | null {
    if (!isRecord(input)) return null;
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const size = typeof input.size === 'number' && Number.isFinite(input.size) ? input.size : -1;
    if (!id || !name || size < 0 || size > appConfig.background.maxVideoBytes) return null;
    return {
        id: id.slice(0, 128),
        name: name.slice(0, 255),
        size,
        type: typeof input.type === 'string' ? input.type.slice(0, 80) : '',
        importedAt:
            typeof input.importedAt === 'number' && Number.isFinite(input.importedAt)
                ? input.importedAt
                : Date.now(),
    };
}

function normalizeWebAsset(input: unknown): WebAsset | null {
    if (!isRecord(input)) return null;
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const size = typeof input.size === 'number' && Number.isFinite(input.size) ? input.size : -1;
    if (!id || !name || size < 0 || size > appConfig.background.maxWebBytes) return null;
    return {id: id.slice(0, 128), name: name.slice(0, 255), size};
}

function normalizeUnmapped(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, MAX_UNMAPPED);
}

export function normalizeBackgroundPreset(input: unknown): BackgroundPreset | null {
    if (!isRecord(input)) return null;
    const id = typeof input.id === 'string' ? input.id.trim().slice(0, 128) : '';
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_NAME) : '';
    if (!id || !name) return null;
    return {
        id,
        name,
        options: normalizeBackgroundOptions(input.options),
        unmapped: normalizeUnmapped(input.unmapped),
        createdAt:
            typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
                ? input.createdAt
                : Date.now(),
    };
}

export function defaultBackgroundSettings(): BackgroundSettings {
    return {
        enabled: true,
        playWhenReducedMotion: false,
        kind: 'video',
        asset: null,
        web: null,
        options: {...DEFAULT_BACKGROUND_OPTIONS},
        presets: [],
        activePresetId: null,
    };
}

export function normalizeBackgroundSettings(input: unknown): BackgroundSettings {
    const base = defaultBackgroundSettings();
    if (!isRecord(input)) return base;

    const presets: BackgroundPreset[] = [];
    const seen = new Set<string>();
    if (Array.isArray(input.presets)) {
        for (const raw of input.presets) {
            const preset = normalizeBackgroundPreset(raw);
            if (!preset || seen.has(preset.id)) continue;
            seen.add(preset.id);
            presets.push(preset);
            if (presets.length >= MAX_PRESETS) break;
        }
    }

    const activePresetId =
        typeof input.activePresetId === 'string' &&
        presets.some((preset) => preset.id === input.activePresetId)
            ? input.activePresetId
            : null;

    return {
        enabled: input.enabled !== false,
        playWhenReducedMotion: input.playWhenReducedMotion === true,
        kind: input.kind === 'web' ? 'web' : 'video',
        asset: normalizeAsset(input.asset),
        web: normalizeWebAsset(input.web),
        options: normalizeBackgroundOptions(input.options),
        presets,
        activePresetId,
    };
}

/** 新建一个本地预设（不负责去重/上限，store 负责）。 */
export function createBackgroundPreset(
    name: string,
    options: BackgroundOptions,
    unmapped: string[] = [],
    now = Date.now(),
): BackgroundPreset {
    const random = Math.random().toString(36).slice(2, 8);
    return {
        id: `bgp-${now.toString(36)}-${random}`,
        name: name.trim().slice(0, MAX_NAME) || 'preset',
        options: normalizeBackgroundOptions(options),
        unmapped: normalizeUnmapped(unmapped),
        createdAt: now,
    };
}
