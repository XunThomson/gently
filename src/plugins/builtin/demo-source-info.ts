import type {PluginInfo} from '../../types';

/**
 * 内置演示源的元数据（`PluginInfo`）。
 *
 * **只有元数据、没有任何 mock 数据依赖**：`plugins/index.ts` 静态 import 它，
 * 因此 Vite 能把它旁边那三个真源（连带 `src/mock/**` 与随包音频）整块摇掉，
 * 桌面端产物里不留演示数据。
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
