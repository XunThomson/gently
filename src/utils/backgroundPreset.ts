import {
    normalizeBackgroundOptions,
    type BackgroundFit,
    type BackgroundOptions,
} from './backgroundSettings';

/**
 * 外部壁纸预设的 best-effort 解析。
 *
 * 外部工具的 “Share JSON” 是**按壁纸类型生成的键值对**，没有通用 schema；
 * 这里只映射我们认识的展示参数，其余键原样列进 `unmapped`，绝不假装已还原。
 * 支持直接对象，也支持 `{properties: {...}}` 这种包装。
 */
export interface ParsedExternalPreset {
    name: string;
    options: BackgroundOptions;
    unmapped: string[];
    mappedCount: number;
}

export type PresetParseResult =
    | {ok: true; preset: ParsedExternalPreset}
    | {ok: false; reason: 'invalid' | 'empty'};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function fitValue(value: unknown): BackgroundFit | null {
    if (typeof value !== 'string') return null;
    const normalized = value.toLowerCase();
    if (normalized.includes('free')) return 'free';
    if (normalized.includes('contain')) return 'contain';
    if (normalized.includes('fill') || normalized.includes('stretch')) return 'fill';
    if (normalized.includes('cover')) return 'cover';
    return null;
}

/** 外部键名大小写/命名不一致，统一按小写比较 */
const KNOWN_KEYS = new Set([
    'name',
    'title',
    'presetname',
    'version',
    'properties',
    'fit',
    'alignment',
    'scaling',
    'objectfit',
    'playbackrate',
    'playbackspeed',
    'speed',
    'rate',
    'opacity',
    'alpha',
    'contentopacity',
    'surfaceopacity',
    'contentblur',
    'surfaceblur',
    'draweropacity',
    'drawerblur',
    'blur',
    'bluramount',
    'blurstrength',
]);

export function parseExternalBackgroundPreset(input: unknown): PresetParseResult {    let root: unknown = input;
    if (typeof input === 'string') {
        try {
            root = JSON.parse(input);
        } catch {
            return {ok: false, reason: 'invalid'};
        }
    }
    if (!isRecord(root)) return {ok: false, reason: 'invalid'};

    const source = isRecord(root.properties) ? root.properties : root;
    if (Object.keys(source).length === 0) return {ok: false, reason: 'empty'};

    let fit: BackgroundFit | null = null;
    let playbackRate = 1;
    let opacity: number | null = null;
    let contentOpacity: number | null = null;
    let contentBlurPx: number | null = null;
    let drawerOpacity: number | null = null;
    let drawerBlurPx: number | null = null;
    let blurPx: number | null = null;
    let name = '';
    let mappedCount = 0;
    const unmapped: string[] = [];

    for (const [key, value] of Object.entries(source)) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === 'name' || normalizedKey === 'title' || normalizedKey === 'presetname') {
            if (typeof value === 'string' && value.trim()) name = value.trim().slice(0, 40);
            continue;
        }
        if (!KNOWN_KEYS.has(normalizedKey)) {
            unmapped.push(key);
            continue;
        }
        if (normalizedKey === 'version' || normalizedKey === 'properties') continue;

        if (['fit', 'alignment', 'scaling', 'objectfit'].includes(normalizedKey)) {
            const fitMatch = fitValue(value);
            if (fitMatch) {
                fit = fitMatch;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (['playbackrate', 'playbackspeed', 'speed', 'rate'].includes(normalizedKey)) {
            const rate = numberValue(value);
            if (rate !== null) {
                playbackRate = rate;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (['opacity', 'alpha'].includes(normalizedKey)) {
            const raw = numberValue(value);
            if (raw !== null) {
                opacity = raw > 1 && raw <= 100 ? raw / 100 : raw;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (['contentopacity', 'surfaceopacity'].includes(normalizedKey)) {
            const raw = numberValue(value);
            if (raw !== null) {
                contentOpacity = raw > 1 && raw <= 100 ? raw / 100 : raw;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (['contentblur', 'surfaceblur'].includes(normalizedKey)) {
            const raw = numberValue(value);
            if (raw !== null) {
                contentBlurPx = raw;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (normalizedKey === 'draweropacity') {
            const raw = numberValue(value);
            if (raw !== null) {
                drawerOpacity = raw > 1 && raw <= 100 ? raw / 100 : raw;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (normalizedKey === 'drawerblur') {
            const raw = numberValue(value);
            if (raw !== null) {
                drawerBlurPx = raw;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
            continue;
        }
        if (['blur', 'bluramount', 'blurstrength'].includes(normalizedKey)) {
            const raw = numberValue(value);
            if (raw !== null) {
                blurPx = raw;
                mappedCount += 1;
            } else {
                unmapped.push(key);
            }
        }
    }

    if (mappedCount === 0) return {ok: false, reason: 'empty'};

    return {
        ok: true,
        preset: {
            name,
            options: normalizeBackgroundOptions({
                fit: fit ?? undefined,
                playbackRate,
                opacity,
                blurPx,
                contentOpacity,
                contentBlurPx,
                drawerOpacity,
                drawerBlurPx,
            }),
            unmapped: unmapped.slice(0, 20),
            mappedCount,
        },
    };
}

/**
 * 导出成外部壁纸工具也能读的扁平 JSON。
 *
 * 键名用 `playbackrate / alignment / opacity / blur`，和解析器同一套映射；
 * opacity / blur 为 null 时写入当前生效值（主题默认），保证导出后再导入不丢参数。
 */
export function exportExternalBackgroundPreset(
    name: string,
    options: BackgroundOptions,
    effective: {
        opacity: number;
        blurPx: number;
        contentOpacity: number;
        contentBlurPx: number;
        drawerOpacity: number;
        drawerBlurPx: number;
    },
): string {
    const payload: JsonRecord = {
        playbackrate: Number(options.playbackRate.toFixed(2)),
        alignment: options.fit,
        opacity: Number((options.opacity ?? effective.opacity).toFixed(3)),
        blur: Number((options.blurPx ?? effective.blurPx).toFixed(1)),
        contentOpacity: Number((options.contentOpacity ?? effective.contentOpacity).toFixed(3)),
        contentBlur: Number((options.contentBlurPx ?? effective.contentBlurPx).toFixed(1)),
        drawerOpacity: Number((options.drawerOpacity ?? effective.drawerOpacity).toFixed(3)),
        drawerBlur: Number((options.drawerBlurPx ?? effective.drawerBlurPx).toFixed(1)),
    };
    const trimmed = name.trim().slice(0, 40);
    if (trimmed) payload.name = trimmed;
    return JSON.stringify(payload, null, 2);
}
