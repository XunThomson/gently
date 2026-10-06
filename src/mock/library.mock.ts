import type {DownloadTask, LocalTrack, PluginInfo, RecentTrack} from '../types';
import {makeTrack} from './track.mock';
import {SONG_POOL} from './base.data.mock';
import {MOCK_SOURCE_INFO} from '../plugins/builtin/mock-source';
import {appConfig} from '../config/app.config';
import {formatSizeMb} from '../utils/helpers';

/* ============================== 本地音乐 ============================== */

const LOCAL_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7];

export const LOCAL_TRACKS: LocalTrack[] = LOCAL_INDEXES.slice(0, appConfig.mock.localTracks).map(
    (i) => ({
        ...makeTrack(i, 'local'),
        path: `D:/Music/${SONG_POOL[i][1]} - ${SONG_POOL[i][0]}.flac`,
        sizeText: `${(8 + (i % 5) * 1.7).toFixed(1)} MB`,
        addedAt: Date.now() - i * 86400000,
    }),
);

/* ============================== 最近播放 ============================== */

const RECENT_INDEXES = [3, 0, 7, 2, 9, 5];

export const RECENT_TRACKS: RecentTrack[] = RECENT_INDEXES.slice(0, appConfig.mock.recentTracks).map(
    (i, order) => ({
        ...makeTrack(i, 'mock'),
        playedAt: Date.now() - order * 3600_000,
        playCount: 6 - order,
    }),
);

/* ============================== 下载任务 ============================== */

interface DownloadSeed {
    index: number;
    status: DownloadTask['status'];
    progress: number;
    totalMb: number;
    speedText?: string;
}

const DOWNLOAD_SEEDS: DownloadSeed[] = [
    {index: 0, status: 'downloading', progress: 0.73, totalMb: 4.12, speedText: '1.2Mb/s'},
    {index: 1, status: 'downloading', progress: 0.12, totalMb: 3.12, speedText: '620Kb/s'},
    {index: 2, status: 'paused', progress: 0.46, totalMb: 3.9},
    {index: 3, status: 'error', progress: 0.31, totalMb: 3.5},
    {index: 4, status: 'done', progress: 1, totalMb: 4.05},
    {index: 5, status: 'done', progress: 1, totalMb: 3.62},
];

export const DOWNLOAD_TASKS: DownloadTask[] = DOWNLOAD_SEEDS.slice(
    0,
    appConfig.mock.downloadTasks,
).map((seed) => ({
    id: `dl:${seed.index}`,
    track: makeTrack(seed.index, 'mock'),
    status: seed.status,
    progress: seed.progress,
    totalMb: seed.totalMb,
    sizeText: formatSizeMb(seed.progress * seed.totalMb, seed.totalMb),
    speedText: seed.speedText,
}));

/* ============================== 已安装插件 ============================== */

export const INSTALLED_PLUGINS: PluginInfo[] = [
    MOCK_SOURCE_INFO,
    {
        id: 'bilibili',
        name: 'Bilibili 音源',
        version: '0.8.3',
        author: 'gently-community',
        description: '从 B 站视频提取音频，支持无损与合集解析。',
        builtin: false,
        enabled: true,
        homepage: 'https://github.com/gently-plugins/bilibili',
    },
    {
        id: 'netease',
        name: '网易云音源',
        version: '1.2.0',
        author: 'gently-community',
        description: '网易云音乐搜索、歌单与榜单。',
        builtin: false,
        enabled: false,
        homepage: 'https://github.com/gently-plugins/netease',
    },
    {
        id: 'qqmusic',
        name: 'QQ 音乐音源',
        version: '0.5.1',
        author: 'gently-community',
        description: 'QQ 音乐搜索与歌单解析。',
        builtin: false,
        enabled: false,
    },
    {
        id: 'kugou',
        name: '酷狗音源',
        version: '0.3.0',
        author: 'third-party',
        description: '酷狗音乐搜索。',
        builtin: false,
        enabled: false,
    },
];
