import type {TasteProfile} from '../types';

/**
 * 口味画像的**展示**助手：取权重最高的若干标签。
 *
 * 这里刻意只做「排序 + 截断」——画像本身（权重、时间衰减、归一化）只由本机核心聚合一份
 * （`core/src/recommend.rs`），前端不保留任何第二份口味算法。
 */
export function topTags(profile: TasteProfile, limit = 3): string[] {
    return Object.entries(profile.tags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag]) => tag);
}
