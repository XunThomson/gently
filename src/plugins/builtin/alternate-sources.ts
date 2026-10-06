import {createMockMusicSource} from './source-factory';
import type {MusicSourcePlugin} from '../types';

/**
 * 额外两个「行为真实」的模拟音源。
 *
 * 它们与内置示例源返回**大体相同但不完全一致**的曲库，
 * 用来演示产品要解决的核心问题：
 * 1. 同一首歌会有多个音源候选 → 聚合展示不会出现重复条目；
 * 2. 某些音源的某些内容**无法播放** → 播放时自动切换到下一个候选；
 * 3. 各源支持的音质档位不同 → 音质选择需要按源降级。
 */

/** B 站音源：支持无损，但约 1/4 内容解析失败 */
export const bilibiliSource: MusicSourcePlugin = createMockMusicSource({
    id: 'bilibili',
    name: 'Bilibili 音源',
    author: 'gently-community',
    description: '从 B 站视频提取音频，支持无损与合集解析（模拟源，约 1/4 内容不可播）。',
    enabled: true,
    homepage: 'https://github.com/gently-plugins/bilibili',
    qualities: ['lossless', 'high', 'standard'],
    chartRows: 16,
    recommendRows: 6,
    unavailableRate: 0.25,
    latencyFactor: 1.15,
});

/** 网易云音源：支持 Hi-Res，约 1/3 内容不可播，速度较慢 */
export const neteaseSource: MusicSourcePlugin = createMockMusicSource({
    id: 'netease',
    name: '网易云音源',
    author: 'gently-community',
    description: '网易云音乐搜索、歌单与榜单（模拟源，约 1/3 内容不可播）。',
    enabled: true,
    homepage: 'https://github.com/gently-plugins/netease',
    qualities: ['hires', 'lossless', 'high', 'standard'],
    chartRows: 14,
    recommendRows: 6,
    unavailableRate: 0.33,
    latencyFactor: 1.3,
});
