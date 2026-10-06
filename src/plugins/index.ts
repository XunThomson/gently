import {bilibiliSource, neteaseSource} from './builtin/alternate-sources';
import {MOCK_SOURCE_INFO, mockMusicSource} from './builtin/mock-source';
import {registerMusicSource} from './registry';

/* 内置插件注册（副作用模块：被 services 引入一次即可） */
registerMusicSource(mockMusicSource);
registerMusicSource(bilibiliSource);
registerMusicSource(neteaseSource);

export {MOCK_SOURCE_INFO};

export {
    registerMusicSource,
    unregisterMusicSource,
    getMusicSource,
    listMusicSources,
    listEnabledMusicSources,
    listMusicSourceInfos,
    getMusicSourceQualities,
    isMusicSourceEnabled,
    setMusicSourceEnabled,
    getActiveMusicSource,
} from './registry';

export type {MusicSourcePlugin, ChartQuery} from './types';
export type {MockSourceOptions} from './builtin/source-factory';
