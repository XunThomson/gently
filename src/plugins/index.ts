import {MOCK_SOURCE_INFO, mockMusicSource} from './builtin/mock-source';
import {registerMusicSource} from './registry';

/* 内置插件注册（副作用模块：被 services 引入一次即可） */
registerMusicSource(mockMusicSource);

export {MOCK_SOURCE_INFO};

export {
    registerMusicSource,
    getMusicSource,
    listMusicSources,
    getActiveMusicSource,
} from './registry';

export type {MusicSourcePlugin, ChartQuery} from './types';
