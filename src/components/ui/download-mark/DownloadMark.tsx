import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useDownloadState} from '../../../store';
import {trackRefOf} from '../../../services';
import type {Track} from '../../../types';
import styles from './download-mark.module.css';

/** 下载状态里「最该被看到」的那一个：已完成优先，其次进行中，再其次暂停/失败。 */
const PRIORITY: Record<string, number> = {done: 0, downloading: 1, pending: 2, paused: 3, error: 4};

/**
 * 列表里的「下载标记」。
 *
 * 用户的原话是「已下载和未下载没有明显区分，只能在下载界面查看」——所以这里把状态带进
 * **业务列表本身**：标题旁一个小徽标，`已下载 / 下载中 / 已暂停 / 失败`，没有任务就什么也不显示
 * （不占位、不写「未下载」：那是噪声，用户默认就是没下载）。
 *
 * 匹配用**引用**（`source:rawId`）而不是标题：同名歌曲很多，用标题会张冠李戴。
 */
export function DownloadMark({track}: {track: Track}) {
    const {t} = useTranslation();
    const {tasks} = useDownloadState();

    const mark = useMemo(() => {
        const reference = trackRefOf(track).id;
        // 先按引用精确匹配；**再按「同源 + 同标题 + 同歌手」兜底**——
        // 同一个视频在不同列表里的 rawId 可能不同（有的带 `|cid`，有的只有 bvid），
        // 精确匹配会漏掉「明明下载过却显示未下载」。这里只是**提示性徽标**，宁可比播放解析宽松。
        const mine = tasks.filter((task) => {
            const other = task.track;
            if (!other) return false;
            if (other.id === reference) return true;
            return (
                other.source === track.source &&
                other.title === track.title &&
                other.artist === track.artist
            );
        });
        if (mine.length === 0) return null;
        // 同一首歌可能有多个任务（重下过）：取最「有信息量」的一个
        const best = mine.reduce((a, b) => (PRIORITY[a.status] <= PRIORITY[b.status] ? a : b));
        return {status: best.status, progress: best.progress};
    }, [tasks, track]);

    if (!mark) return null;

    const label =
        mark.status === 'done'
            ? t('column.downloadDone')
            : mark.status === 'error'
              ? t('column.downloadFailed')
              : mark.status === 'paused'
                ? t('column.downloadPaused')
                : mark.status === 'pending'
                  ? t('column.downloadQueued')
                  : t('column.downloading', {percent: Math.round(mark.progress * 100)});

    return (
        <span className={styles.mark} data-status={mark.status} title={label}>
            {label}
        </span>
    );
}

export default DownloadMark;
