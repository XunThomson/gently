import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {DataTable, TextCell, type ColumnDef} from '../../components/ui/data-table';
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
import type {RecentTrack} from '../../types';
import {formatRelative} from '../../utils/date';

export default function RecentView() {
    const {t} = useTranslation();
    const {recent, loaded} = useLibraryState();
    const {load, clearRecent} = useActions().library;
    const confirm = useConfirm();
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(() => [...recent].sort((a, b) => b.playedAt - a.playedAt), [recent]);

    const playedAtText = (ts: number): string => {
        const {unit, count} = formatRelative(ts);
        if (unit === 'justNow') return t('page.recent.justNow');
        if (unit === 'minutes') return t('page.recent.minutesAgo', {count});
        if (unit === 'hours') return t('page.recent.hoursAgo', {count});
        return t('page.recent.daysAgo', {count});
    };

    const actionsOf = (track: RecentTrack) => buildActions(track, {queue: rows, withDownload: true});

    const columns: ColumnDef<RecentTrack>[] = [
        indexColumn<RecentTrack>(),
        titleColumn<RecentTrack>(t),
        artistColumn<RecentTrack>(t),
        albumColumn<RecentTrack>(t),
        durationColumn<RecentTrack>(t),
        {
            key: 'playedAt',
            title: t('column.playedAt'),
            width: '116px',
            render: (value) => <TextCell tone="muted">{playedAtText(Number(value))}</TextCell>,
        },
        {
            key: 'playCount',
            title: t('column.playCount'),
            width: '72px',
            align: 'center',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        actionsColumn<RecentTrack>(t, actionsOf),
    ];

    /* 手机：两行式 + ⋯ 面板；「什么时候听的」比播放次数重要，只带前者 */
    const compactColumns: ColumnDef<RecentTrack>[] = mobileTrackColumns<RecentTrack>(t, {
        actions: actionsOf,
        extra: (track) => playedAtText(track.playedAt),
    });

    return (
        <Page
            title={t('page.recent.title')}
            subtitle={t('page.recent.subtitle', {count: recent.length})}
            toolbar={
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={recent.length === 0}
                    onClick={() =>
                        confirm({
                            titleKey: 'confirm.clearRecentTitle',
                            descKey: 'confirm.clearRecentDesc',
                            tone: 'danger',
                            onConfirm: clearRecent,
                        })
                    }
                >
                    {t('page.recent.clear')}
                </Button>
            }
        >
            <DataTable
                columns={columns}
                mobileColumns={compactColumns}
                dataSource={rows}
                rowKey="id"
                loading={!loaded}
                loadingText={t('common.loading')}
                emptyText={loaded ? t('page.recent.empty') : t('common.loading')}
                onRowClick={(track) => playRow(track, rows)}
                activeRowKey={currentId ?? undefined}
            />
        </Page>
    );
}
