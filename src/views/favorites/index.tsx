import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {DataTable, TextCell, type ColumnDef} from '../../components/ui/data-table';
import {EmptyState} from '../../components/ui/empty-state';
import {IconHeart} from '../../components/ui/icon';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
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
import {SourceFavorites} from './components/source-favorites';
import styles from './favorites.module.css';

type FavoritesTab = 'local' | 'source';

/**
 * 我的收藏：两个来源**分开**展示。
 *
 * 为什么不合并成一个列表：本机收藏是**本机库里的快照**（插件卸载了也还在），源收藏是
 * **你账号里、别人服务器上的东西**（需要登录、随时会变、断网就拿不到）。混在一起会让用户
 * 分不清「我收藏的」到底存在哪、为什么某首歌突然不见了。
 */
export default function FavoritesView() {
    const {t} = useTranslation();
    const {favorites, loaded} = useCollectionState();
    const {load} = useActions().collection;
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();
    const [tab, setTab] = useState<FavoritesTab>('local');

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
            subtitle={
                tab === 'local'
                    ? t('page.favorites.subtitle', {count: rows.length})
                    : t('page.favorites.sourceSubtitle')
            }
        >
            <div className={styles.tabs}>
                <UnderlineRadioGroup
                    name="favorites-tab"
                    value={tab}
                    onChange={(value) => setTab(value as FavoritesTab)}
                    options={[
                        {value: 'local', label: t('page.favorites.tabLocal')},
                        {value: 'source', label: t('page.favorites.tabSource')},
                    ]}
                />
            </div>

            {tab === 'source' ? (
                <SourceFavorites/>
            ) : loaded && rows.length === 0 ? (
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
