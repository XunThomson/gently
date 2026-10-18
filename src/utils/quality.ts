import type {DownloadQualityFallback, TrackQuality} from '../types';

/** 音质档位，由低到高 */
export const QUALITY_ORDER: readonly TrackQuality[] = ['standard', 'high', 'lossless', 'hires'];

/** 全部档位（由高到低，用于 UI 列表） */
export const QUALITIES_DESC: readonly TrackQuality[] = [...QUALITY_ORDER].reverse();

/** 展示用的中文/英文文案 key */
export const qualityLabelKey = (quality: TrackQuality): string => `quality.${quality}`;

export const qualityRank = (quality: TrackQuality): number =>
    QUALITY_ORDER.indexOf(quality);

/**
 * 在可用档位里挑最合适的：
 * 优先取「不高于期望」的最高档；若期望档位都不可用，则退回可用档里的最高档。
 */
export function pickQuality(
    available: readonly TrackQuality[],
    preferred: TrackQuality,
): TrackQuality | null {
    if (available.length === 0) return null;

    const sorted = [...available].sort((a, b) => qualityRank(b) - qualityRank(a));
    const preferredRank = qualityRank(preferred);

    return sorted.find((q) => qualityRank(q) <= preferredRank) ?? sorted[0];
}

/**
 * 下载用：期望档位不可用时按用户设置往「更低」或「更高」取。
 *
 * 与播放的 `pickQuality` 分开：播放总是「不高于期望」，而下载允许用户选
 * 「宁可大一点也要更高音质」。两边都是纯函数，行为可以各自钉住。
 */
export function pickQualityWithFallback(
    available: readonly TrackQuality[],
    preferred: TrackQuality,
    fallback: DownloadQualityFallback,
): TrackQuality {
    /* 来源没说支持哪些档位（比如收藏快照里没有候选信息）：不猜，交给插件/核心按 preferred 处理 */
    if (available.length === 0) return preferred;
    if (available.includes(preferred)) return preferred;

    const preferredRank = qualityRank(preferred);
    const lower = [...available]
        .filter((q) => qualityRank(q) < preferredRank)
        .sort((a, b) => qualityRank(b) - qualityRank(a))[0];
    const higher = [...available]
        .filter((q) => qualityRank(q) > preferredRank)
        .sort((a, b) => qualityRank(a) - qualityRank(b))[0];

    /* 用户选的方向优先；那个方向没有档位时退到另一边（总比拿一个确定不支持的档位去问强） */
    return fallback === 'lower' ? lower ?? higher ?? preferred : higher ?? lower ?? preferred;
}
