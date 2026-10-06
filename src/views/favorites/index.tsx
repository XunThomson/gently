import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {DataTable, TextCell, type ColumnDef} from '../../components/ui/data-table';
import {EmptyState} from '../../components/ui/empty-state';
import {IconHeart} from '../../components/ui/icon';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    titleColumn,
} from '../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../hooks/useTrackActions';
import {useActions, useCollectionState} from '../../store';
import type {Track} from '../../types';

/** 我的收藏：与歌单共用列定义与行操作 */
export default function FavoritesView() {
    const {t} = useTranslation();
    const {favorites, loaded} = useCollectionState();
    const {load} = useActions().collection;
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(() => favorites, [favorites]);

    const columns: ColumnDef<Track>[] = [
        indexColumn<Track>(),
        titleColumn<Track>(t),
        artistColumn<Track>(t),
        albumColumn<Track>(t),
        durationColumn<Track>(t),
        {
            key: 'source',
            title: t('column.source'),
            width: '112px',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        actionsColumn<Track>(t, (track) => buildActions(track, {queue: rows, withDownload: true})),
    ];

    return (
        <Page
            title={t('page.favorites.title')}
            subtitle={t('page.favorites.subtitle', {count: rows.length})}
        >
            {loaded && rows.length === 0 ? (
                <EmptyState icon={<IconHeart size={30}/>} title={t('page.favorites.empty')}/>
            ) : (
                <DataTable
                    columns={columns}
                    dataSource={rows}
                    rowKey="id"
                    loading={!loaded}
                    loadingText={t('common.loading')}
                    emptyText={t('page.favorites.empty')}
                    onRowClick={(track) => playRow(track, rows)}
                    activeRowKey={currentId ?? undefined}
                />
            )}
        </Page>
    );
}
