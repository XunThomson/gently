import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSearchParams} from 'react-router';
import {Page} from '../../components/ui/page';
import {DataTable, type ColumnDef} from '../../components/ui/data-table';
import {EmptyState} from '../../components/ui/empty-state';
import {SearchBox} from '../../components/ui/search-box';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    sourceColumn,
    titleColumn,
} from '../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../hooks/useTrackActions';
import {catalogService} from '../../services';
import type {Track} from '../../types';
import styles from './search.module.css';

/**
 * 搜索结果：关键词来自 URL 的 ?q=，视图本身无状态可分享。
 * 提交搜索框只改写查询串，数据拉取与取消逻辑集中在下面的 effect。
 */
export default function SearchView() {
    const {t} = useTranslation();
    const [searchParams, setSearchParams] = useSearchParams();
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    const qa = searchParams.get('q') ?? '';
    const keyword = qa.trim();

    const [draft, setDraft] = useState(qa);
    const [tracks, setTracks] = useState<Track[]>([]);
    const [loading, setLoading] = useState(false);

    /* 关键词变化（含浏览器前进后退）时同步输入框 */
    useEffect(() => {
        setDraft(qa);
    }, [qa]);

    useEffect(() => {
        if (!keyword) {
            setTracks([]);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);

        catalogService
            .search(keyword)
            .then((result) => {
                if (!cancelled) setTracks(result);
            })
            .catch((err) => {
                console.error('[search] 搜索失败', err);
                if (!cancelled) setTracks([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [keyword]);

    const rows = tracks;

    const columns: ColumnDef<Track>[] = [
        indexColumn<Track>(),
        titleColumn<Track>(t),
        artistColumn<Track>(t),
        albumColumn<Track>(t),
        durationColumn<Track>(t),
        sourceColumn<Track>(t),
        actionsColumn<Track>(t, (track) => buildActions(track, {queue: rows, withDownload: true})),
    ];

    const submit = (next: string) => {
        setSearchParams({q: next});
    };

    return (
        <Page
            title={t('page.search.title')}
            subtitle={t('page.search.subtitle', {keyword, count: rows.length})}
            toolbar={
                <div className={styles.searchBox}>
                    <SearchBox
                        value={draft}
                        onChange={setDraft}
                        onSearch={submit}
                        historyKey={null}
                        placeholder={t('search.placeholder')}
                        submitText={t('search.submit')}
                    />
                </div>
            }
        >
            {!keyword ? (
                <EmptyState title={t('page.search.hint')}/>
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
