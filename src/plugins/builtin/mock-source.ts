import {appConfig} from '../../config/app.config';
import {RECOMMENDED, SONG_POOL} from '../../mock/base.data.mock';
import {makeTrack} from '../../mock/track.mock';
import {buildChartData} from '../../utils/chart';
import type {PluginInfo, Track} from '../../types';
import type {ChartQuery, MusicSourcePlugin} from '../types';

/**
 * 内置测试音频（项目自带的测试文件）。
 * 仅用于验证「播放 / 暂停 / 进度 / 音量」整条链路；
 * 接入真实音乐源插件后，由插件返回真实可播放地址。
 */
import testAudioUrl from '../../assets/yihuik苡慧 - 致你.m4s';

/** 内置示例源的插件元数据（插件列表以这里为准） */
export const MOCK_SOURCE_INFO: PluginInfo = {
    id: 'mock',
    name: '内置示例源',
    version: '1.0.0',
    author: 'Gently',
    description: '内置 mock 数据源，用于 UI 联调；接入真实源后会被替换。',
    builtin: true,
    enabled: true,
};

/** 模拟网络延迟，保证 UI 的加载态与真实数据源一致 */
const LATENCY_MS = appConfig.latency.sourceMs;
const delay = (ms = LATENCY_MS) => new Promise<void>((r) => setTimeout(r, ms));

const indexPath = (title: string) => SONG_POOL.findIndex((row) => row[0] === title);

export const mockMusicSource: MusicSourcePlugin = {
    info: MOCK_SOURCE_INFO,

    async fetchChart({chart, dateKey}: ChartQuery) {
        await delay();
        return buildChartData(chart, dateKey);
    },

    async fetchRecommend(limit: number): Promise<Track[]> {
        await delay();
        return RECOMMENDED.slice(0, limit).map(([title], i) => {
            const idx = indexPath(title);
            return makeTrack(idx >= 0 ? idx : i, MOCK_SOURCE_INFO.id);
        });
    },

    async search(keyword: string): Promise<Track[]> {
        await delay();
        const kw = keyword.trim().toLowerCase();
        if (!kw) return [];

        return SONG_POOL.map((row, i) => ({row, i}))
            .filter(({row}) =>
                row[0].toLowerCase().includes(kw) ||
                row[1].toLowerCase().includes(kw) ||
                row[2].toLowerCase().includes(kw),
            )
            .slice(0, appConfig.list.searchLimit)
            .map(({i}) => makeTrack(i, MOCK_SOURCE_INFO.id));
    },

    /** 纯 UI 阶段没有真实播放地址：统一下发内置测试音频 */
    async resolveUrl(): Promise<string | null> {
        return testAudioUrl;
    },
};
