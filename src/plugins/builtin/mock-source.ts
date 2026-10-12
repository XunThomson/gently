import {createMockMusicSource} from './source-factory';
import {MOCK_SOURCE_INFO} from './demo-source-info';

export {MOCK_SOURCE_INFO};

/**
 * 内置示例源：**始终可播**（不带不可播模拟），作为自动回退的兜底音源。
 * 它同时也是「播放链路」的测试音源（见 source-factory 的 testAudioUrl）。
 *
 * 只在浏览器预览里被加载（见 `plugins/builtin/demo-sources.ts` 的说明）。
 */
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
