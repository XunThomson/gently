import type {TFunction} from 'i18next';
import type {ColumnDef, RowAction} from '../components/ui/data-table';
import {ActionsCell, BadgeCell, ProgressCell, TextCell} from '../components/ui/data-table';
import type {Track} from '../types';

/**
 * 数据表格列定义（配置驱动）。
 *
 * 所有列表视图共享同一份列规格，避免每个视图重复写标题 / 宽度 / 渲染逻辑；
 * 文案通过传入的 `t` 解析，保证国际化。
 */

export const indexColumn = <T,>(): ColumnDef<T> => ({
    key: 'index',
    title: '#',
    width: '52px',
    align: 'center',
    render: (_value, _record, index) => <TextCell tone="muted">{index + 1}</TextCell>,
});

export const titleColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'title',
    title: t('column.title'),
    width: 'minmax(220px, 1.6fr)',
    render: (value) => <TextCell>{String(value)}</TextCell>,
});

export const artistColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'artist',
    title: t('column.artist'),
    width: 'minmax(120px, 1fr)',
    render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
});

export const albumColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'album',
    title: t('column.album'),
    width: 'minmax(120px, 1fr)',
    render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
});

export const durationColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'duration',
    title: t('column.duration'),
    width: '84px',
    align: 'center',
    render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
});

export const sourceColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'source',
    title: t('column.source'),
    width: '112px',
    render: (value) => <BadgeCell tone="accent">{String(value)}</BadgeCell>,
});

/**
 * 音源聚合列：聚合展示时同一首歌有多个音源候选，
 * 这里显示候选数量，播放时按顺序自动尝试。
 */
export const sourceCountColumn = <T extends Track>(t: TFunction): ColumnDef<T> => ({
    key: 'sourceCount',
    title: t('column.source'),
    width: '128px',
    render: (value) => <BadgeCell tone="accent">{t('source.count', {count: Number(value ?? 1)})}</BadgeCell>,
});

export const progressColumn = <T,>(t: TFunction): ColumnDef<T> => ({
    key: 'sizeText',
    title: t('column.progress'),
    width: 'minmax(150px, 1.2fr)',
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
    width: '140px',
    align: 'right',
    render: (_value, record) => <ActionsCell actions={build(record)}/>,
});
