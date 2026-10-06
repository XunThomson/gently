import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSearchParams} from 'react-router';
import {Page} from '../../components/ui/page';
import {DataTable, type ColumnDef} from '../../components/ui/data-table';
import {EmptyState} from '../../components/ui/empty-state';
import {SourceFilter} from '../../components/ui/source-filter';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    sourceColumn,
    sourceCountColumn,
    titleColumn,
} from '../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../hooks/useTrackActions';
import {catalogService} from '../../services';
import {useSelect} from '../../store';
import type {GroupedTrack, Track} from '../../types';
import {filterGroupsBySource} from '../../utils/track';
import styles from './search.module.css';

/**
 * 搜索结果：关键词来自 URL 的 `?q=`，URL 即状态（可分享 / 刷新 / 前进后退）。
 *
 * 音源：默认聚合展示 —— 同一首歌在多个音源下只出现一条，
 * 多个音源作为候选在播放时依次尝试；也可切到「分源」只看某个音源。
 */
export default function SearchView() {
    const {t} = useTranslation();
    const [searchParams] = useSearchParams();
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    const display = useSelect((s) => s.ui.sourceDisplay);
    const sourceFilter = useSelect((s) => s.ui.sourceFilter);

    const keyword = (searchParams.get('q') ?? '').trim();

    const [groups, setGroups] = useState<GroupedTrack[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!keyword) {
            setGroups([]);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);

        const request =
            display === 'aggregate'
                ? catalogService.searchAll(keyword)
                : catalogService
                      .searchIn(keyword, sourceFilter === 'all' ? undefined : sourceFilter)
                      .then((tracks) => tracks as GroupedTrack[]);

        request
            .then((result) => {
                if (!cancelled) setGroups(result);
            })
            .catch((err) => {
                console.error('[search] 搜索失败', err);
                if (!cancelled) setGroups([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [keyword, display, sourceFilter]);

    /* 聚合模式下按音源筛选：收敛候选，或在没有该源时隐藏该条 */
    const rows = useMemo(
        () => (display === 'aggregate' ? filterGroupsBySource(groups, sourceFilter) : groups),
        [groups, display, sourceFilter],
    );

    const columns: ColumnDef<Track>[] = [
        indexColumn<Track>(),
        titleColumn<Track>(t),
        artistColumn<Track>(t),
        albumColumn<Track>(t),
        durationColumn<Track>(t),
        display === 'aggregate' ? sourceCountColumn<Track>(t) : sourceColumn<Track>(t),
        actionsColumn<Track>(t, (track) => buildActions(track, {queue: rows, withDownload: true})),
    ];

    return (
        <Page
            title={t('page.search.title')}
            subtitle={t('page.search.subtitle', {keyword, count: rows.length})}
            toolbar={<SourceFilter className={styles.filter}/>}
        >
            {!keyword ? (
                <EmptyState title={t('page.search.hint')} hint={t('search.placeholder')}/>
            ) : !loading && rows.length === 0 ? (
                <EmptyState title={t('page.search.empty')}/>
            ) : (
                <DataTable
                    columns={columns}
                    dataSource={rows}
                    rowKey="id"
                    loading={loading}
                    loadingText={t('common.loading')}
                    emptyText={t('page.search.empty')}
                    onRowClick={(track) => playRow(track, rows)}
                    activeRowKey={currentId ?? undefined}
                />
            )}
        </Page>
    );
}
