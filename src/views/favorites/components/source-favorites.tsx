import {useCallback, useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {CoreError, PluginSummary} from '../../../api';
import type {CoreFavoriteCollection} from '../../../services/core.catalog';
import {Button} from '../../../components/ui/button';
import {DataTable, TextCell, type ColumnDef} from '../../../components/ui/data-table';
import {EmptyState} from '../../../components/ui/empty-state';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {IconHeart} from '../../../components/ui/icon';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    titleColumn,
} from '../../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../../hooks/useTrackActions';
import {errorText} from '../../../i18n/errors';
import {catalogService, corePlugin} from '../../../services';
import type {Track} from '../../../types';
import styles from '../favorites.module.css';

/**
 * 源侧收藏夹（`catalog.favorites`）。
 *
 * 三条来自契约的事实，界面必须照样表现出来：
 * 1. **只有实现了 `getFavorites` 的源才有**：能力缺失是常态（社区插件能力参差），
 *    所以「源收藏」是一个**按源切换**的面板，而不是一个不带来源的列表；
 * 2. **需要登录**：登录走插件自己的 `@oauth` / cookie（ADR-0008），核心不掺和；
 *    拿不到时按错误码说清是「未授权」还是「这个源没有收藏夹」；
 * 3. **不缓存**：这是用户自己的状态，随时可能在别处改动，所以每次进页面都重新取。
 */
export function SourceFavorites() {
    const {t} = useTranslation();
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    const [sources, setSources] = useState<PluginSummary[]>([]);
    const [selected, setSelected] = useState<string>('');
    const [rows, setRows] = useState<Track[]>([]);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<CoreError | null>(null);
    const [loadedOnce, setLoadedOnce] = useState(false);
    /** 该源的可选收藏夹/歌单：空 = 只有一份默认收藏（不显示选择器） */
    const [collections, setCollections] = useState<CoreFavoriteCollection[]>([]);
    const [collection, setCollection] = useState<string>('');

    /** 只列出「已启用且实现了 getFavorites」的源：其余源根本没有这个入口 */
    useEffect(() => {
        let cancelled = false;
        /* 用核心的插件摘要（带运行时探测的能力）：浏览器预览里没有核心 → 空列表，
           「源收藏」就不能凭空出现，也不会拿演示数据冒充 */
        void corePlugin.list().then((result) => {
            if (cancelled) return;
            const plugins = result.ok && result.data ? result.data : [];
            const capable = plugins.filter(
                (plugin) =>
                    plugin.enabled &&
                    (plugin.manifest?.capabilities ?? []).includes('getFavorites'),
            );
            setSources(capable);
            setSelected((current) => current || capable[0]?.id || '');
            setLoading(capable.length === 0 ? false : true);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    /** 切源：重新问一次「这个源有哪些收藏夹」，并把选中项重置到第一个 */
    useEffect(() => {
        if (!selected) {
            setCollections([]);
            setCollection('');
            return;
        }
        let cancelled = false;
        void catalogService.fetchFavoriteCollections(selected).then((items) => {
            if (cancelled) return;
            setCollections(items);
            setCollection(items[0]?.id ?? '');
        });
        return () => {
            cancelled = true;
        };
    }, [selected]);

    const load = useCallback(
        async (sourceId: string, nextPage: number, append: boolean, collectionId?: string) => {
            if (!sourceId) {
                setRows([]);
                setHasMore(false);
                setLoading(false);
                return;
            }
            setLoading(true);
            setError(null);
            const result = await catalogService.fetchFavoritesFrom(sourceId, nextPage, collectionId);
            setLoading(false);
            setLoadedOnce(true);
            if (!result) {
                setRows([]);
                setHasMore(false);
                setError({code: 'common.unsupported_platform', message: '这个源不在本机核心里'});
                return;
            }
            if (result.error) {
                // 失败**不清空已有行**：翻页失败不该让用户丢掉前一页
                setError(result.error);
                if (!append) setRows([]);
                setHasMore(false);
                return;
            }
            setRows((current) => (append ? [...current, ...result.items] : result.items));
            setPage(nextPage);
            setHasMore(result.hasMore);
        },
        [],
    );

    useEffect(() => {
        if (!selected) return;
        void load(selected, 1, false, collection || undefined);
    }, [selected, collection, load]);

    const columns: ColumnDef<Track>[] = useMemo(
        () => [
            indexColumn<Track>(),
            titleColumn<Track>(t),
            artistColumn<Track>(t),
            albumColumn<Track>(t),
            durationColumn<Track>(t),
            actionsColumn<Track>(t, (track) => buildActions(track, {queue: rows, withDownload: true})),
        ],
        [t, buildActions, rows],
    );

    if (sources.length === 0) {
        return (
            <p className={styles.hint}>
                {loadedOnce || !loading ? t('page.favorites.noSourceFavorites') : t('common.loading')}
            </p>
        );
    }

    return (
        <div>
            <div className={styles.sourceBar}>
                <UnderlineRadioGroup
                    name="favorites-source"
                    value={selected}
                    onChange={(value) => setSelected(value)}
                    options={sources.map((source) => ({value: source.id, label: source.name}))}
                />
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={loading}
                    onClick={() => void load(selected, 1, false, collection || undefined)}
                >
                    {t('common.refresh')}
                </Button>
            </div>

            {/* 收藏夹/歌单选择器：只有该源真的有多份收藏时才出现（单份收藏的源不打扰用户） */}
            {collections.length > 1 && (
                <div className={styles.sourceBar}>
                    <UnderlineRadioGroup
                        name="favorites-collection"
                        value={collection}
                        onChange={(value) => setCollection(value)}
                        options={collections.map((entry) => ({
                            value: entry.id,
                            label:
                                entry.count === undefined
                                    ? entry.title
                                    : `${entry.title}（${entry.count}）`,
                        }))}
                    />
                </div>
            )}

            {error ? (
                <TextCell tone="danger">{errorText(t, error)}</TextCell>
            ) : null}

            {loading && rows.length === 0 ? (
                <TextCell tone="muted">{t('common.loading')}</TextCell>
            ) : rows.length === 0 && !error ? (
                <EmptyState icon={<IconHeart size={30}/>} title={t('page.favorites.sourceEmpty')}/>
            ) : (
                <DataTable
                    columns={columns}
                    dataSource={rows}
                    rowKey="id"
                    loading={loading && rows.length === 0}
                    loadingText={t('common.loading')}
                    emptyText={t('page.favorites.sourceEmpty')}
                    onRowClick={(track) => playRow(track, rows)}
                    activeRowKey={currentId ?? undefined}
                />
            )}

            {hasMore && (
                <div className={styles.more}>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={loading}
                        onClick={() => void load(selected, page + 1, true, collection || undefined)}
                    >
                        {t('page.favorites.loadMore')}
                    </Button>
                </div>
            )}

            <p className={styles.hint}>{t('page.favorites.sourceHint')}</p>
        </div>
    );
}

export default SourceFavorites;
