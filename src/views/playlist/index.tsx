import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useParams} from 'react-router';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {DataTable, type ColumnDef} from '../../components/ui/data-table';
import {EmptyState} from '../../components/ui/empty-state';
import {IconMusic, IconTrash} from '../../components/ui/icon';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    mobileTrackColumns,
    titleColumn,
} from '../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../hooks/useTrackActions';
import {useConfirm} from '../../hooks/useConfirm';
import {useActions, useSelect} from '../../store';
import type {Track} from '../../types';
import styles from './playlist.module.css';

/** 歌单详情：重命名 / 删除 / 播放 / 移出歌单 */
export default function PlaylistView() {
    const {t} = useTranslation();
    const {id = ''} = useParams();
    const {load} = useActions().collection;
    const {renamePlaylist, removePlaylist, removeFromPlaylist} = useActions().collection;
    const playlist = useSelect((s) => s.collection.playlists.find((item) => item.id === id) ?? null);
    const loaded = useSelect((s) => s.collection.loaded);
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState(playlist?.name ?? '');
    const confirm = useConfirm();

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(() => playlist?.tracks ?? [], [playlist]);

    const actionsOf = (track: Track) =>
        buildActions(track, {
            queue: rows,
            withDownload: true,
            extra: [
                {
                    key: 'remove',
                    label: t('page.playlist.removeFromPlaylist'),
                    tone: 'danger' as const,
                    onClick: () => removeFromPlaylist(id, track.id),
                },
            ],
        });

    const columns: ColumnDef<Track>[] = [
        indexColumn<Track>(),
        titleColumn<Track>(t),
        artistColumn<Track>(t),
        albumColumn<Track>(t),
        durationColumn<Track>(t),
        actionsColumn<Track>(t, actionsOf),
    ];

    /* 手机：两行式 + ⋯ 面板（「移出歌单」在面板最后一项） */
    const compactColumns: ColumnDef<Track>[] = mobileTrackColumns<Track>(t, {actions: actionsOf});

    if (!playlist && loaded) {
        return (
            <Page title={t('page.playlist.title')}>
                <EmptyState icon={<IconMusic size={30}/>} title={t('page.playlist.notFound')}/>
            </Page>
        );
    }

    const commitRename = () => {
        if (playlist) renamePlaylist(playlist.id, draft);
        setRenaming(false);
    };

    return (
        <Page
            title={playlist?.name ?? t('page.playlist.title')}
            subtitle={t('page.playlist.subtitle', {count: rows.length})}
            toolbar={
                <div className={styles.toolbar}>
                    {renaming ? (
                        <>
                            <input
                                className={styles.input}
                                autoFocus
                                value={draft}
                                placeholder={t('page.playlist.namePlaceholder')}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitRename();
                                    if (e.key === 'Escape') setRenaming(false);
                                }}
                            />
                            <Button size="sm" variant="primary" onClick={commitRename}>
                                {t('common.save')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                                {t('common.cancel')}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setDraft(playlist?.name ?? '');
                                    setRenaming(true);
                                }}
                            >
                                {t('page.playlist.rename')}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                icon={<IconTrash size={14}/>}
                                onClick={() =>
                                    playlist &&
                                    confirm({
                                        titleKey: 'confirm.deletePlaylistTitle',
                                        descKey: 'confirm.deletePlaylistDesc',
                                        descParams: {name: playlist.name},
                                        tone: 'danger',
                                        onConfirm: () => removePlaylist(playlist.id),
                                    })
                                }
                            >
                                {t('page.playlist.delete')}
                            </Button>
                        </>
                    )}
                </div>
            }
        >
            {rows.length === 0 ? (
                <EmptyState icon={<IconMusic size={30}/>} title={t('page.playlist.empty')}/>
            ) : (
                <DataTable
                    columns={columns}
                    mobileColumns={compactColumns}
                    dataSource={rows}
                    rowKey="id"
                    loading={!loaded}
                    loadingText={t('common.loading')}
                    emptyText={t('page.playlist.empty')}
                    onRowClick={(track) => playRow(track, rows)}
                    activeRowKey={currentId ?? undefined}
                />
            )}
        </Page>
    );
}
