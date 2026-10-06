import {appConfig} from '../../config/app.config';
import {RECOMMENDED, SONG_POOL} from '../../mock/base.data.mock';
import {makeTrack} from '../../mock/track.mock';
import {buildChartData} from '../../utils/chart';
import {hashStr} from '../../utils/helpers';
import {pickQuality} from '../../utils/quality';
import type {PluginInfo, ResolvedSource, Track, TrackQuality} from '../../types';
import type {ChartQuery, MusicSourcePlugin} from '../types';

/**
 * 内置测试音频：仅用于验证「播放 / 暂停 / 进度 / 音量」整条链路，
 * 以及「同一首歌多音源自动切换」。接入真实源后由插件返回真实地址。
 */
import testAudioUrl from '../../assets/yihuik苡慧 - 致你.m4s';

export interface MockSourceOptions {
    id: string;
    name: string;
    author: string;
    description: string;
    builtin?: boolean;
    enabled?: boolean;
    homepage?: string;
    /** 支持的音质档位（由高到低） */
    qualities: TrackQuality[];
    /** 榜单返回条数（各源略有差异，便于观察聚合效果） */
    chartRows: number;
    /** 推荐条数上限 */
    recommendRows: number;
    /** 模拟「该源部分内容无法播放」的比例 0~1 */
    unavailableRate?: number;
    /** 延迟倍率，制造各源速度差异 */
    latencyFactor?: number;
}

/**
 * 用内置数据生成一个「行为真实」的模拟音源：
 * 同一首歌在不同源下是不同 Track（id 不同、来源不同），
 * 但 (标题, 歌手) 相同，因此聚合时可以合并成多个候选。
 */
export function createMockMusicSource(options: MockSourceOptions): MusicSourcePlugin {
    const info: PluginInfo = {
        id: options.id,
        name: options.name,
        version: '1.0.0',
        author: options.author,
        description: options.description,
        builtin: options.builtin ?? false,
        enabled: options.enabled ?? false,
        homepage: options.homepage,
    };

    const latency = () =>
        new Promise<void>((resolve) =>
            setTimeout(resolve, appConfig.latency.sourceMs * (options.latencyFactor ?? 1)),
        );

    const sourceOf = (index: number, seed: string): Track => {
        const track = makeTrack(index, options.id);
        // 各源把曲目 id 打上自己的前缀，避免跨源 id 冲突
        return {...track, id: `${options.id}:${seed}:${index}`};
    };

    return {
        info,
        qualities: options.qualities,

        async fetchChart({chart, dateKey}: ChartQuery) {
            await latency();
            // 每个源用不同的 seed，因此返回的榜单集合「大体相同但不完全一致」
            const rows = buildChartData(chart, `${options.id}|${dateKey}`);
            return rows.slice(0, options.chartRows);
        },

        async fetchRecommend(limit: number) {
            await latency();
            const take = Math.min(limit, options.recommendRows);
            return RECOMMENDED.slice(0, take).map(([title], i) => {
                const index = SONG_POOL.findIndex((row) => row[0] === title);
                return sourceOf(index >= 0 ? index : i, 'rec');
            });
        },

        async search(keyword: string) {
            await latency();
            const kw = keyword.trim().toLowerCase();
            if (!kw) return [];

            return SONG_POOL.map((row, index) => ({row, index}))
                .filter(({row}) => row[0].toLowerCase().includes(kw) ||
                    row[1].toLowerCase().includes(kw) ||
                    row[2].toLowerCase().includes(kw))
                .slice(0, appConfig.list.searchLimit)
                .map(({index}) => sourceOf(index, 'search'));
        },

        async resolveUrl(track: Track, quality: TrackQuality): Promise<ResolvedSource | null> {
            await latency();

            // 模拟「该源的部分内容无法播放」：同一首歌结果稳定
            const rate = options.unavailableRate ?? 0;
            if (rate > 0 && (hashStr(`${options.id}|${track.title}`) % 100) < rate * 100) {
                return null;
            }

            const picked = pickQuality(options.qualities, quality);
            if (!picked) return null;

            return {url: testAudioUrl, source: options.id, quality: picked};
        },
    };
}
