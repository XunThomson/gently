import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {BadgeCell, DataTable, TextCell, type ColumnDef} from '../../../components/ui/data-table';
import {actionsColumn, indexColumn, progressColumn} from '../../../config/table.config';
import {useConfirm} from '../../../hooks/useConfirm';
import {useActions, useDownloadState} from '../../../store';
import type {DownloadStatus, DownloadTask} from '../../../types';

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

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(
        () => tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)),
        [tasks],
    );

    const columns: ColumnDef<DownloadTask>[] = [
        indexColumn<DownloadTask>(),
        {
            key: 'title',
            title: t('column.title'),
            width: 'minmax(220px, 1.6fr)',
            render: (_value, record) => <TextCell>{record.track.title}</TextCell>,
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
        actionsColumn<DownloadTask>(t, (task) => [
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
                tone: 'danger',
                onClick: () =>
                    confirm({
                        titleKey: 'confirm.removeDownloadTitle',
                        descKey: 'confirm.removeDownloadDesc',
                        descParams: {name: task.track.title},
                        tone: 'danger',
                        onConfirm: () => remove(task.id),
                    }),
            },
        ]),
    ];

    return (
        <DataTable
            columns={columns}
            dataSource={rows}
            rowKey="id"
            loading={!loaded}
            loadingText={t('common.loading')}
            emptyText={loaded ? t('page.download.empty') : t('common.loading')}
        />
    );
}
