import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import type {RowAction} from '../components/ui/data-table';
import {CORE_LOCAL_SOURCE} from '../services/core.sources';
import {useActions, useSelect} from '../store';
import type {Track} from '../types';
import {downloadQueueKeyString, isQueued, parseQueueKeyString} from '../utils/downloadQueue';

export interface TrackActionOptions {
    /** 播放 / 暂停时使用的队列（通常是当前列表） */
    queue?: Track[];
    /** 追加的行内操作（如移除、在文件夹中显示） */
    extra?: RowAction[];
    /** 是否显示「收藏 / 取消收藏」，默认显示 */
    withFavorite?: boolean;
    /** 是否显示「下载」 */
    withDownload?: boolean;
}

/**
 * 是否给这首曲目提供「下载」操作。
 *
 * **本地文件不提供**：它已经在本机（核心对 `local:` 的 `download.create` 会直接拒绝：
 * 「本地曲目不需要下载（文件已经在本机）」）。给一个点了必然失败的按钮，比没有这个按钮更糟。
 */
export const canDownload = (track: Pick<Track, 'source'>): boolean =>
    track.source !== CORE_LOCAL_SOURCE;

/**
 * 曲目行内操作的统一构造器。
 *
 * 让「播放 / 收藏 / 下载」在排行榜、热门、本地、最近、下载、歌单等所有列表里
 * 保持同一套文案与行为，避免每个视图各写一份。
 */
export function useTrackActions() {
    const {t} = useTranslation();
    const {playOrToggle} = useActions().player;
    const {toggleFavorite} = useActions().collection;
    const {add: addDownload} = useActions().download;
    const favorites = useSelect((s) => s.collection.favorites);
    /* 队列里有哪些曲目：只订阅「匹配键序列」，进度每秒变化不会让整张表重渲染 */
    const queueKeys = useSelect((s) => downloadQueueKeyString(s.download.tasks));
    const queued = useMemo(() => parseQueueKeyString(queueKeys), [queueKeys]);

    return (track: Track, options: TrackActionOptions = {}): RowAction[] => {
        const actions: RowAction[] = [
            {
                key: 'play',
                label: t('common.play'),
                tone: 'primary',
                onClick: () => playOrToggle(track, options.queue),
            },
        ];

        if (options.withFavorite !== false) {
            const isFavorite = favorites.some((item) => item.id === track.id);
            actions.push({
                key: 'favorite',
                label: isFavorite ? t('common.unfavorite') : t('common.favorite'),
                onClick: () => toggleFavorite(track),
            });
        }

        /* 已经在下载队列里 → **不显示下载入口**：同一首歌重复提交只会堆出多余任务，
           真把并发槽占满时界面看起来像「点了没反应」。状态由标题旁的下载标记负责展示。 */
        if (options.withDownload && canDownload(track) && !isQueued(queued, track)) {
            actions.push({
                key: 'download',
                label: t('common.download'),
                onClick: () => addDownload(track),
            });
        }

        return options.extra ? [...actions, ...options.extra] : actions;
    };
}

/** 列表行点击的统一行为：当前曲目切换播放/暂停，其他曲目切歌播放 */
export function usePlayRow() {
    const {playOrToggle} = useActions().player;
    return (track: Track, queue?: Track[]) => playOrToggle(track, queue);
}

/** 当前播放曲目 id：用于列表高亮正在播放的行 */
export function useCurrentTrackId(): string | null {
    return useSelect((s) => s.player.current?.id ?? null);
}
