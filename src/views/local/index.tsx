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
    mobileTrackColumns,
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

    /** 一行的操作只算一次：桌面放行内，手机放进 ⋯ 底部面板 */
    const actionsOf = (track: LocalTrack) =>
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
                    tone: 'danger' as const,
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
        });

    const columns: ColumnDef<LocalTrack>[] = [
        indexColumn<LocalTrack>(),
        titleColumn<LocalTrack>(t),
        artistColumn<LocalTrack>(t),
        albumColumn<LocalTrack>(t),
        durationColumn<LocalTrack>(t),
        {
            key: 'sizeText',
            title: t('column.size'),
            // 与 `table.config.tsx` 里的列宽下限同一套账：7 列合计必须放得进最小窗口的
            // 内容区（900 宽 → 约 615）。这里 80px 是「4.2 MB」这种文本 + 左右内边距的下限。
            width: '80px',
            align: 'center',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        actionsColumn<LocalTrack>(t, actionsOf),
    ];

    /** 手机：两行式 + ⋯ 面板（文件大小挂到第二行，桌面那 7 列在 360px 下放不下） */
    const compactColumns: ColumnDef<LocalTrack>[] = mobileTrackColumns<LocalTrack>(t, {
        actions: actionsOf,
        extra: (track) => track.sizeText,
    });

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
                mobileColumns={compactColumns}
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
