import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {BadgeCell, DataTable, TextCell, type ColumnDef} from '../../../components/ui/data-table';
import {actionsColumn, indexColumn, mobileColumns} from '../../../config/table.config';
import {usePlayRow, useTrackActions} from '../../../hooks/useTrackActions';
import {useConfirm} from '../../../hooks/useConfirm';
import {fileService, revealInDirAvailable} from '../../../services';
import {useActions, useDownloadState} from '../../../store';
import type {DownloadTask} from '../../../types';
import {isMobilePlatform} from '../../../utils/platform';
import {ClearFinishedButton} from '../components/ClearFinishedButton';
import styles from '../download.module.css';

export default function DownloadedView() {
    const {t} = useTranslation();
    const {tasks, loaded} = useDownloadState();
    const {load, remove} = useActions().download;
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const confirm = useConfirm();

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(() => tasks.filter((task) => task.status === 'done'), [tasks]);
    const tracks = useMemo(() => rows.map((task) => task.track), [rows]);

    const actionsOf = (task: DownloadTask) =>
        buildActions(task.track, {
            queue: tracks,
            extra: [
                /* 已下载的文件是用户资产：给一条「在文件夹中显示」的路，
                   否则用户只能自己猜核心把文件放到了哪。
                   安卓上这条不成立（没有「文件管理器定位」这回事，私有目录外部也看不到），
                   所以按平台能力决定给不给（GOTCHAS §46）。 */
                ...(task.path && revealInDirAvailable(isMobilePlatform())
                    ? [
                        {
                            key: 'reveal',
                            label: t('page.download.reveal'),
                            onClick: () => void fileService.revealInDir(task.path as string),
                        },
                    ]
                    : []),
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
            ],
        });

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
        actionsColumn<DownloadTask>(t, actionsOf),
    ];

    /* 手机：两行式——第一行曲名、第二行「歌手 · 专辑 · 大小」，右侧时长 */
    const compactColumns: ColumnDef<DownloadTask>[] = mobileColumns<DownloadTask>({
        titleLabel: t('column.title'),
        primary: (task) => task.track.title,
        secondary: (task) =>
            [task.track.artist, task.track.album, task.sizeText]
                .filter((part) => !!(part && String(part).trim()))
                .join(' · '),
        trailing: (task) => task.track.duration,
        sheetTitle: (task) => task.track.title,
        actions: actionsOf,
    });

    return (
        <div className={styles.list}>
            <div className={styles.toolbar}>
                <ClearFinishedButton/>
            </div>

            <DataTable
                columns={columns}
                mobileColumns={compactColumns}
                dataSource={rows}
                rowKey="id"
                loading={!loaded}
                loadingText={t('common.loading')}
                emptyText={loaded ? t('page.download.empty') : t('common.loading')}
                onRowClick={(task) => playRow(task.track, tracks)}
            />
        </div>
    );
}
