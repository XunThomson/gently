import {createMockMusicSource} from './source-factory';
import type {PluginInfo} from '../../types';

/**
 * 内置示例源：**始终可播**（不带不可播模拟），作为自动回退的兜底音源。
 * 它同时也是「播放链路」的测试音源（见 source-factory 的 testAudioUrl）。
 */
export const MOCK_SOURCE_INFO: PluginInfo = {
    id: 'mock',
    name: '内置示例源',
    version: '1.0.0',
    author: 'Gently',
    description: '内置 mock 数据源，用于 UI 联调与播放链路测试；接入真实源后会被替换。',
    builtin: true,
    enabled: true,
};

export const mockMusicSource = createMockMusicSource({
    id: MOCK_SOURCE_INFO.id,
    name: MOCK_SOURCE_INFO.name,
    author: MOCK_SOURCE_INFO.author,
    description: MOCK_SOURCE_INFO.description,
    builtin: true,
    enabled: true,
    qualities: ['high', 'standard'],
    chartRows: 20,
    recommendRows: 8,
    unavailableRate: 0,
});
