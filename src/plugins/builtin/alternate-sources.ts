import {createMockMusicSource} from './source-factory';
import type {MusicSourcePlugin} from '../types';

/**
 * 额外两个「行为真实」的模拟音源。
 *
 * ⚠️ **它们是纯粹的本机模拟**：不访问任何网络、不解析任何真实音源，只播放随包测试音频。
 * 真实音源一律由用户自行导入的插件提供（见 `docs/adr/0005-neutral-third-party.md`）。
 * 这里保留 `bilibili` / `netease` 两个 id 只是因为模拟数据与冒烟断言在引用它们，
 * **不代表产品内置或在推荐任何第三方服务**；M2 之后它们会被真正的插件宿主取代。
 *
 * 与内置示例源返回**大体相同但不完全一致**的曲库，用来演示产品要解决的核心问题：
 * 1. 同一首歌会有多个音源候选 → 聚合展示不会出现重复条目；
 * 2. 某些音源的某些内容**无法播放** → 播放时自动切换到下一个候选；
 * 3. 各源支持的音质档位不同 → 音质选择需要按源降级。
 */

/** 模拟源 B：支持无损，但约 1/4 内容解析失败 */
export const bilibiliSource: MusicSourcePlugin = createMockMusicSource({
    id: 'bilibili',
    name: '模拟音源 B',
    author: 'gently-mock',
    description: '模拟源：支持无损、约 1/4 内容不可播，用于演示播放回退（不访问网络）。',
    enabled: true,
    qualities: ['lossless', 'high', 'standard'],
    chartRows: 16,
    recommendRows: 6,
    unavailableRate: 0.25,
    latencyFactor: 1.15,
});

/** 模拟源 C：支持 Hi-Res，约 1/3 内容不可播，速度较慢 */
export const neteaseSource: MusicSourcePlugin = createMockMusicSource({
    id: 'netease',
    name: '模拟音源 C',
    author: 'gently-mock',
    description: '模拟源：支持 Hi-Res、约 1/3 内容不可播且较慢，用于演示音质降级（不访问网络）。',
    enabled: true,
    qualities: ['hires', 'lossless', 'high', 'standard'],
    chartRows: 14,
    recommendRows: 6,
    unavailableRate: 0.33,
    latencyFactor: 1.3,
});
