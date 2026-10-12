import {bilibiliSource, neteaseSource} from './alternate-sources';
import {MOCK_SOURCE_INFO, mockMusicSource} from './mock-source';
import type {MusicSourcePlugin} from '../types';

/**
 * 三个内置**演示源**：只在**没有 Tauri 宿主**（浏览器预览）时被加载。
 *
 * 为什么单独一个模块：`plugins/index.ts` 用**动态 `import()`** 拉它，
 * 于是 Vite/Rollup 能把这一整条链（`source-factory` → `src/mock/**` → 约 4MB 的
 * 随包测试音频）从桌面端产物里摇掉——打包后的应用不会有任何演示数据或演示音源。
 */
export const demoMusicSources: MusicSourcePlugin[] = [mockMusicSource, bilibiliSource, neteaseSource];

export {MOCK_SOURCE_INFO};
