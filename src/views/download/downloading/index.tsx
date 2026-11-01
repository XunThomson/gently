import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {BadgeCell, DataTable, TextCell, type ColumnDef} from '../../../components/ui/data-table';
import {
    actionsColumn,
    indexColumn,
    mobileColumns,
    progressColumn,
} from '../../../config/table.config';
import {useConfirm} from '../../../hooks/useConfirm';
import {errorKey} from '../../../i18n/errors';
import {useActions, useDownloadState} from '../../../store';
import type {DownloadStatus, DownloadTask} from '../../../types';
import styles from '../download.module.css';

const ACTIVE_STATUSES: DownloadStatus[] = ['pending', 'downloading', 'paused', 'error'];

const STATUS_TONE: Record<DownloadStatus, 'accent' | 'muted' | 'success' | 'danger'> = {
    pending: 'muted',
    downloading: 'accent',
    paused: 'muted',
    done: 'success',
    error: 'danger',
};

export default function DownloadingView() {
    const {t} = useTranslation();
    const {tasks, loaded} = useDownloadState();
    const {load, pause, resume, remove} = useActions().download;
    const confirm = useConfirm();

    /** 失败原因：优先按错误码取本地化文案，没有码时才用核心给的开发者说明 */
    const reasonOf = (task: DownloadTask): string | undefined => {
        if (task.errorCode) return t(errorKey(task.errorCode));
        return task.error;
    };

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(
        () => tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)),
        [tasks],
    );

    const actionsOf = (task: DownloadTask) => [
        task.status === 'downloading' || task.status === 'pending'
            ? {key: 'pause', label: t('page.download.pause'), onClick: () => pause(task.id)}
            : {
                key: 'resume',
                label: t('page.download.resume'),
                tone: 'primary' as const,
                onClick: () => resume(task.id),
            },
        {
            key: 'remove',
            label: t('common.delete'),
            tone: 'danger' as const,
            onClick: () =>
                confirm({
                    titleKey: 'confirm.removeDownloadTitle',
                    descKey: 'confirm.removeDownloadDesc',
                    descParams: {name: task.track.title},
                    tone: 'danger',
                    onConfirm: () => remove(task.id),
                }),
        },
    ];

    const columns: ColumnDef<DownloadTask>[] = [
        indexColumn<DownloadTask>(),
        {
            key: 'title',
            title: t('column.title'),
            width: 'minmax(220px, 1.6fr)',
            render: (_value, record) => (
                <>
                    <TextCell>{record.track.title}</TextCell>
                    {/* 失败原因按错误码本地化（`download:error` 事件带 code），比「失败」两个字有用 */}
                    {record.status === 'error' && reasonOf(record) && (
                        <span className={styles.reason}>{reasonOf(record)}</span>
                    )}
                </>
            ),
        },
        {
            key: 'artist',
            title: t('column.artist'),
            width: 'minmax(120px, 1fr)',
            render: (_value, record) => <TextCell tone="muted">{record.track.artist}</TextCell>,
        },
        progressColumn<DownloadTask>(t),
        {
            key: 'status',
            title: t('column.status'),
            width: '96px',
            align: 'center',
            render: (_value, record) => (
                <BadgeCell tone={STATUS_TONE[record.status]}>
                    {t(`page.download.status.${record.status}`)}
                </BadgeCell>
            ),
        },
        {
            key: 'source',
            title: t('column.source'),
            width: '112px',
            render: (_value, record) => <BadgeCell tone="accent">{record.track.source}</BadgeCell>,
        },
        actionsColumn<DownloadTask>(t, actionsOf),
    ];

    /* 手机：两行式——第一行曲名、第二行「歌手 · 状态 · 进度」，右侧百分比；
       失败原因同样挂在第二行（手机上比一个红色徽标更该说清为什么失败） */
    const compactColumns: ColumnDef<DownloadTask>[] = mobileColumns<DownloadTask>({
        titleLabel: t('column.title'),
        primary: (task) => task.track.title,
        secondary: (task) => {
            const parts = [
                task.track.artist,
                t(`page.download.status.${task.status}`),
                task.status === 'error' ? reasonOf(task) : task.sizeText,
            ];
            return parts.filter((part) => !!part).join(' · ');
        },
        trailing: (task) => `${Math.round(Math.min(1, Math.max(0, task.progress)) * 100)}%`,
        sheetTitle: (task) => task.track.title,
        actions: actionsOf,
    });

    return (
        <DataTable
            columns={columns}
            mobileColumns={compactColumns}
            dataSource={rows}
            rowKey="id"
            loading={!loaded}
            loadingText={t('common.loading')}
            emptyText={loaded ? t('page.download.empty') : t('common.loading')}
        />
    );
}
