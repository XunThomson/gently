import type {TFunction} from 'i18next';
import type {ColumnDef, RowAction} from '../components/ui/data-table';
import {ActionsCell, BadgeCell, ProgressCell, TextCell} from '../components/ui/data-table';
import {DownloadMark} from '../components/ui/download-mark';
import type {Track} from '../types';
import {trackCoverStyle} from '../utils/cover';
import styles from './table.config.module.css';

/**
 * 数据表格列定义（配置驱动）。
 *
 * 所有列表视图共享同一份列规格，避免每个视图重复写标题 / 宽度 / 渲染逻辑；
 * 文案通过传入的 `t` 解析，保证国际化。
 *
 * **列宽下限的总和必须放得进「最小窗口」的内容区**（R53 实测的 UI 异常）：
 * 窗口最小 900 宽、侧边栏 232、页面左右各 28 的 padding → 内容区约 612。
 * 原来的下限合计 832（52+220+120+120+84+96+140），于是**默认窗口（916）下
 * 「大小 / 操作」两列直接跑到窗口外**，只剩一条横向滚动条与半截表头——
 * 用户看到的就是「表格坏了」。现在合计 598，最小窗口也能整列显示；
 * 窗口变宽时标题 / 歌手 / 专辑按 `fr` 分掉多余空间（文字过长一律省略号）。
 */

export const indexColumn = <T,>(): ColumnDef<T> => ({
    key: 'index',
    title: '#',
    width: '36px',
    align: 'center',
    render: (_value, _record, index) => <TextCell tone="muted">{index + 1}</TextCell>,
});

export const titleColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'title',
    title: t('column.title'),
    width: 'minmax(124px, 1.6fr)',
    // 标题左边带封面缩略图：本地曲目的内嵌封面（核心给回环地址）、插件给的封面、没有就退回渐变。
    // 取值优先级与播放条 / 榜单 / 歌词页完全一致（`utils/cover.ts`），列表里不会出现「另一种封面」。
    render: (value, record) => (
        <span className={styles.title}>
            <span aria-hidden="true" className={styles.cover} style={trackCoverStyle(record)} />
            {/* 文本包一层：`TextCell` 本身是 flex 项，不设 min-width 时会顶开下载标记 */}
            <span className={styles.titleText}>
                <TextCell>
                    <span className={styles.text}>{String(value)}</span>
                </TextCell>
            </span>
            {/* 下载状态带进列表本身：用户不必再去下载页确认「这首下过没有」 */}
            <DownloadMark track={record}/>
        </span>
    ),
});

export const artistColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'artist',
    title: t('column.artist'),
    width: 'minmax(80px, 1fr)',
    render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
});

export const albumColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'album',
    title: t('column.album'),
    width: 'minmax(80px, 1fr)',
    render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
});

export const durationColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'duration',
    title: t('column.duration'),
    width: '72px',
    align: 'center',
    render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
});

export const sourceColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'source',
    title: t('column.source'),
    width: '104px',
    render: (value) => <BadgeCell tone="accent">{String(value)}</BadgeCell>,
});

/**
 * 音源聚合列：聚合展示时同一首歌有多个音源候选，
 * 这里显示候选数量，播放时按顺序自动尝试。
 */
export const sourceCountColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'sourceCount',
    title: t('column.source'),
    width: '116px',
    render: (value) => <BadgeCell tone="accent">{t('source.count', {count: Number(value ?? 1)})}</BadgeCell>,
});

export const progressColumn = <T,>(t: TFunction): ColumnDef<T> => ({
    key: 'sizeText',
    title: t('column.progress'),
    width: 'minmax(120px, 1.2fr)',
    render: (value, record) => (
        <ProgressCell
            value={(record as {progress?: number}).progress ?? 0}
            label={String(value ?? '')}
        />
    ),
});

export const actionsColumn = <T,>(
    t: TFunction,
    build: (record: T) => RowAction[],
): ColumnDef<T> => ({
    key: 'actions',
    title: t('column.actions'),
    /**
     * **列宽必须跟着内容走**（`max-content`）。
     *
     * 单元格是 `display:flex; justify-content:flex-end` + `overflow:hidden`：内容一旦比列宽，
     * 溢出的部分被裁在**左侧**——也就是排在最前面的按钮（`播放` / `收藏`）会消失得无影无踪。
     * 固定 140px 时，本地曲库与歌单这两处（4 个操作）就点不到「播放」（R41 在打包版里量到：
     * 只剩「在文件夹中显示 / 移除」）。`minmax(126px, max-content)` 让 2 个操作时保持紧凑、
     * 4 个操作时自动变宽（窗口足够宽时整张表也不会溢出，见文件头的下限合计说明）。
     */
    width: 'minmax(138px, max-content)',
    align: 'right',
    render: (_value, record) => <ActionsCell actions={build(record)}/>,
});
