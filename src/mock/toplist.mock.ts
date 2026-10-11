import type {TopListGroup, TopListPage} from '../api';
import type {Track} from '../types';
import {appConfig} from '../config/app.config';
import {SONG_POOL} from './base.data.mock';
import {makeTrack} from './track.mock';
import {hashStr, mulberry32} from '../utils/helpers';

/**
 * **预置**的榜单分类树（浏览器预览用，桌面端一律来自核心 `catalog.topLists`）。
 *
 * 为什么是「分类树」而不是「热歌榜/新歌榜 + 日/周/月」：真实源提供的是任意分类
 * （契约 §2 已把 v0.1 的固定枚举换成 `topLists` / `topList`），日期周期那些字段
 * 没有源会返回，界面因此按**源给的树**渲染，不假设结构。
 *
 * 名称一律是通用类别名，不指向任何第三方音源（ADR-0005）。
 */
export const TOP_LIST_GROUPS: TopListGroup[] = [
    {
        title: '热歌',
        items: [
            {id: 'hot', title: '热歌榜', description: '最近播放最多'},
            {id: 'new', title: '新歌榜'},
            {id: 'rise', title: '飙升榜'},
        ],
    },
    {
        title: '风格',
        items: [
            {id: 'pop', title: '流行'},
            {id: 'rock', title: '摇滚'},
            {id: 'folk', title: '民谣'},
            {id: 'electronic', title: '电子'},
        ],
    },
    {
        title: '场景',
        items: [
            {id: 'work', title: '工作'},
            {id: 'night', title: '深夜'},
        ],
    },
];

/**
 * 生成某个分类的一页曲目（确定性：同一 `(source, 分类, 页号)` 结果稳定）。
 *
 * 分页刻意做成「一页 10 条、共 3 页」，这样 `hasMore` / `nextPage` 这条真实协议路径
 * 在浏览器预览里也会被走到（否则分页代码永远没被验证过）。
 */
export function buildTopListPage(sourceId: string, itemId: string, page = 1): TopListPage {
    const size = appConfig.list.topListPageSize;
    const seed = `${sourceId}|${itemId}`;
    const rand = mulberry32(hashStr(seed));

    const indexes = SONG_POOL.map((_, index) => index);
    for (let i = indexes.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }

    const safePage = Math.max(1, Math.floor(page));
    const start = (safePage - 1) * size;
    const slice = indexes.slice(start, start + size);

    const items: Track[] = slice.map((index, offset) => {
        const track = makeTrack(index, sourceId);
        // id 带上分类与页内位置，避免与搜索/推荐的 id 撞车
        return {...track, id: `${sourceId}:${seed}:${start + offset}`};
    });

    const hasMore = start + size < indexes.length;
    return {
        items,
        hasMore,
        ...(hasMore ? {nextPage: safePage + 1} : {}),
    };
}
