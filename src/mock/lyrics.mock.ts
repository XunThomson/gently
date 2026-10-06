import {appConfig} from '../config/app.config';
import type {LyricLine, Track} from '../types';
import {hashStr, mulberry32} from '../utils/helpers';

/**
 * 歌词 mock 数据源。
 * 由曲目标题 / 歌手稳定哈希生成，保证同一首歌每次得到同样的歌词与时间轴。
 * 后续接入真实数据源时，只需替换 `libraryService.loadLyrics`。
 */

const INTRO = '（前奏）';

const VERSES = [
    '晚风把街灯吹得很慢',
    '我数着回家的第三盏',
    '你说的话还在耳边打转',
    '像一句没写完的晚安',
    '城市的霓虹落进杯底',
    '我们把沉默调成背景',
    '路灯把影子拉得好长',
    '谁的脚步还留在原地',
    '窗外的雨下得很轻',
    '像你不经意的叹息',
    '我把心事折成纸飞机',
    '顺着风的方向扔出去',
    '时间在耳边慢慢流淌',
    '把昨天收进旧的行囊',
    '如果这一切都是幻觉',
    '请让我再多看一遍',
    '天快亮了梦还没醒',
    '远处的车灯忽明忽暗',
    '我沿着来时的路走回',
    '发现你还在那里等我',
];

const CHORUS = [
    '就这样一直走下去吧',
    '直到天边泛起微光',
    '把所有的遗憾都留下',
    '让风替我们说完',
];

const BRIDGE = [
    '（间奏）',
    '如果时间可以重来',
    '我还是会选择遇见你',
];

const OUTRO = '（尾奏）';

function pick(pool: string[], rand: () => number, count: number): string[] {
    const indexes = pool.map((_, i) => i);
    for (let i = indexes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    return indexes.slice(0, count).map((i) => pool[i]);
}

export function makeLyrics(track: Track): LyricLine[] {
    const rand = mulberry32(hashStr(`${track.title}|${track.artist}|lyrics`));
    const {verseLines, verseRepeatLines, outroLines, leadInSec, leadOutSec} = appConfig.lyrics;

    const lines: string[] = [
        INTRO,
        ...pick(VERSES, rand, verseLines),
        ...CHORUS,
        ...pick(VERSES, rand, verseRepeatLines),
        ...BRIDGE,
        ...CHORUS,
        ...pick(VERSES, rand, outroLines),
        OUTRO,
    ];

    const total = Math.max(90, track.durationSec);
    const step = (total - leadInSec - leadOutSec) / lines.length;

    return lines.map((text, index) => ({
        time: Math.round(leadInSec + index * step),
        text,
    }));
}
