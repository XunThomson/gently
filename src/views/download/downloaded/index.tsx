import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {BadgeCell, DataTable, TextCell, type ColumnDef} from '../../../components/ui/data-table';
import {actionsColumn, indexColumn} from '../../../config/table.config';
import {useActions, useDownloadState} from '../../../store';
import type {DownloadTask} from '../../../types';
import {ClearFinishedButton} from '../components/ClearFinishedButton';
import styles from '../download.module.css';

export default function DownloadedView() {
    const {t} = useTranslation();
    const {tasks, loaded} = useDownloadState();
    const {load, remove} = useActions().download;
    const {play} = useActions().player;

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(() => tasks.filter((task) => task.status === 'done'), [tasks]);
    const tracks = useMemo(() => rows.map((task) => task.track), [rows]);

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
        {
            key: 'album',
            title: t('column.album'),
            width: 'minmax(120px, 1fr)',
            render: (_value, record) => <TextCell tone="muted">{record.track.album}</TextCell>,
        },
        {
            key: 'duration',
            title: t('column.duration'),
            width: '84px',
            align: 'center',
            render: (_value, record) => <TextCell tone="muted">{record.track.duration}</TextCell>,
        },
        {
            key: 'sizeText',
            title: t('column.size'),
            width: '96px',
            align: 'center',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        {
            key: 'source',
            title: t('column.source'),
            width: '112px',
            render: (_value, record) => <BadgeCell tone="accent">{record.track.source}</BadgeCell>,
        },
        actionsColumn<DownloadTask>(t, (task) => [
            {key: 'remove', label: t('common.delete'), tone: 'danger', onClick: () => remove(task.id)},
        ]),
    ];

    return (
        <div className={styles.list}>
            <div className={styles.toolbar}>
                <ClearFinishedButton/>
            </div>

            <DataTable
                columns={columns}
                dataSource={rows}
                rowKey="id"
                loading={!loaded}
                loadingText={t('common.loading')}
                emptyText={loaded ? t('page.download.empty') : t('common.loading')}
                onRowClick={(task) => play(task.track, tracks)}
            />
        </div>
    );
}
