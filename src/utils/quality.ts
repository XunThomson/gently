import type {TrackQuality} from '../types';

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
