import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {DataTable, TextCell, type ColumnDef} from '../../components/ui/data-table';
import {SearchBox} from '../../components/ui/search-box';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    titleColumn,
} from '../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../hooks/useTrackActions';
import {useConfirm} from '../../hooks/useConfirm';
import {useActions, useLibraryState} from '../../store';
import {fileService} from '../../services';
import type {LocalTrack} from '../../types';
import {matchesQuery} from '../../utils/helpers';
import {ScanPanel} from './components/ScanPanel';

export default function LocalView() {
    const {t} = useTranslation();
    const {local, query, loaded} = useLibraryState();
    const {load, setQuery, removeLocal} = useActions().library;
    const confirm = useConfirm();
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(
        () => local.filter((track) => matchesQuery(track.title, track.artist, track.album, query)),
        [local, query],
    );

    const columns: ColumnDef<LocalTrack>[] = [
        indexColumn<LocalTrack>(),
        titleColumn<LocalTrack>(t),
        artistColumn<LocalTrack>(t),
        albumColumn<LocalTrack>(t),
        durationColumn<LocalTrack>(t),
        {
            key: 'sizeText',
            title: t('column.size'),
            width: '96px',
            align: 'center',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        actionsColumn<LocalTrack>(t, (track) =>
            buildActions(track, {
                queue: rows,
                extra: [
                    {
                        key: 'reveal',
                        label: t('page.local.revealInDir'),
                        onClick: () => void fileService.revealInDir(track.path),
                    },
                    {
                        key: 'remove',
                        label: t('page.local.remove'),
                        tone: 'danger',
                        onClick: () =>
                            confirm({
                                titleKey: 'confirm.removeLocalTitle',
                                descKey: 'confirm.removeLocalDesc',
                                descParams: {name: track.title},
                                tone: 'danger',
                                onConfirm: () => removeLocal(track.id),
                            }),
                    },
                ],
            }),
        ),
    ];

    return (
        <Page
            title={t('page.local.title')}
            subtitle={t('page.local.subtitle', {count: local.length})}
            toolbar={
                <SearchBox
                    value={query}
                    onChange={setQuery}
                    onSearch={setQuery}
                    historyKey={null}
                    placeholder={t('search.placeholder')}
                    submitText={t('common.search')}
                />
            }
        >
            {/* 扫描面板常驻：这是**唯一**把音乐加进本地曲库的入口 */}
            <ScanPanel/>

            <DataTable
                columns={columns}
                dataSource={rows}
                rowKey="id"
                loading={!loaded}
                loadingText={t('common.loading')}
                emptyText={loaded ? t('page.local.empty') : t('common.loading')}
                onRowClick={(track) => playRow(track, rows)}
                activeRowKey={currentId ?? undefined}
            />
        </Page>
    );
}
