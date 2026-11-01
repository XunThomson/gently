import type {ReactNode} from 'react';
import type {TFunction} from 'i18next';
import type {ColumnDef, RowAction} from '../components/ui/data-table';
import {ActionsCell, BadgeCell, ProgressCell, TextCell} from '../components/ui/data-table';
import {DownloadMark} from '../components/ui/download-mark';
import type {Track} from '../types';
import {Cover} from '../components/ui/cover';
import {MobileRowActions} from '../components/ui/row-actions';
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
            <Cover
                className={styles.cover}
                artwork={record.artwork}
                gradient={record.gradient}
                title={record.title}
                artist={record.artist}
            />
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

/* ============================== 手机列（P1-5） ============================== */

/**
 * 手机列表 = **两行式**，不是把桌面 7 列压窄。
 *
 * 真机竖屏只有约 360 CSS px（`r108-android-search.png` 实测：7 列表在右侧被裁掉），
 * 塞进去的做法只有「每列 50px」这一种，结果是标题和歌手全变省略号。
 * 所以手机上换一份列定义：
 * - 第一列：封面 + 两行（标题 / 歌手·专辑）+ 右侧从属信息（时长）；
 * - 第二列：行尾 ⋯ → 底部操作面板（见 `components/ui/row-actions`），
 *   行内那排小按钮在触屏上一个都不渲染。
 *
 * 视图不写 `@media`：`DataTable` 按 `useShellMode()` 决定用这一份还是桌面那一份。
 */
export interface MobileColumnsOptions<T> {
    /** 主列表头（手机上表头基本看不见，但语义上仍要有） */
    titleLabel: string;
    /** 第一行：主信息（标题） */
    primary: (record: T) => ReactNode;
    /** 第二行：从属信息（歌手 / 版本 / 失败原因…） */
    secondary?: (record: T) => ReactNode;
    /** 左侧封面 */
    cover?: (record: T) => ReactNode;
    /** 第一行行尾的标记（下载状态等） */
    marks?: (record: T) => ReactNode;
    /** 右侧从属列（时长 / 大小 / 状态），宽度取 `--mobile-list-trailing-width` */
    trailing?: (record: T) => ReactNode;
    /** 底部面板的标题（说明「这是谁」） */
    sheetTitle: (record: T) => string;
    /** 行操作：与桌面同一批动作，只换承载方式 */
    actions: (record: T) => RowAction[];
}

export function mobileColumns<T>(options: MobileColumnsOptions<T>): ColumnDef<T>[] {
    const columns: ColumnDef<T>[] = [
        {
            key: 'title',
            title: options.titleLabel,
            width: 'minmax(0, 1fr)',
            render: (_value, record) => (
                <span className={styles.mobileRow}>
                    {options.cover?.(record)}
                    <span className={styles.mobileLines}>
                        <span className={styles.mobilePrimary}>{options.primary(record)}</span>
                        {options.secondary && (
                            <span className={styles.mobileSecondary}>{options.secondary(record)}</span>
                        )}
                    </span>
                    {options.marks?.(record)}
                </span>
            ),
        },
    ];

    if (options.trailing) {
        columns.push({
            key: 'trailing',
            title: '',
            width: 'var(--mobile-list-trailing-width)',
            align: 'right',
            render: (_value, record) => (
                <TextCell tone="muted">{options.trailing?.(record)}</TextCell>
            ),
        });
    }

    columns.push({
        key: 'actions',
        title: '',
        /**
         * 宽度 = ⋯ 的触控尺寸 + 单元格左右留白（`--space-2`×2）。
         * 只写触控尺寸的话，单元格的内边距会把 44px 的按钮裁掉一截（真机上是「只剩两个点」）。
         */
        width: 'calc(var(--mobile-row-action-size) + var(--space-4))',
        align: 'right',
        render: (_value, record) => (
            <MobileRowActions
                title={options.sheetTitle(record)}
                actions={options.actions(record)}
            />
        ),
    });

    return columns;
}

export interface MobileTrackColumnsOptions<T extends Track> {
    actions: (record: T) => RowAction[];
    /** 第二行除歌手外还想带的（如「3 天前」）；返回空串就不占位 */
    extra?: (record: T) => string | undefined;
}

/** 手机上的**曲目**列表（搜索 / 本地 / 最近 / 收藏 / 歌单 / 专辑详情共用） */
export function mobileTrackColumns<T extends Track>(
    t: TFunction,
    options: MobileTrackColumnsOptions<T>,
): ColumnDef<T>[] {
    return mobileColumns<T>({
        titleLabel: t('column.title'),
        cover: (record) => (
            <Cover
                className={styles.mobileCover}
                artwork={record.artwork}
                gradient={record.gradient}
                title={record.title}
                artist={record.artist}
            />
        ),
        primary: (record) => record.title,
        /* 歌手是「点这一行会听到谁」，比专辑重要；专辑只能二选一时跟着歌手后面用间隔号带上 */
        secondary: (record) =>
            [record.artist, options.extra?.(record), record.album]
                .filter((part) => !!part && String(part).trim().length > 0)
                .join(' · '),
        marks: (record) => <DownloadMark track={record}/>,
        trailing: (record) => record.duration,
        sheetTitle: (record) => record.title,
        actions: options.actions,
    });
}

