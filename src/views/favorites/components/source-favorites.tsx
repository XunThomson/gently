import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
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
    mobileTrackColumns,
    titleColumn,
} from '../../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../../hooks/useTrackActions';
import {errorText} from '../../../i18n/errors';
import {catalogService, corePlugin} from '../../../services';
import type {Track} from '../../../types';
import {CollectionPicker} from './collection-picker';
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
    const navigate = useNavigate();
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
    /**
     * 请求代号：**每次换源 / 刷新 / 换收藏夹都 +1**，回来的旧结果一律丢弃。
     *
     * 这就是「快速点 tab 时标签和内容对不上」的根因：以前没有任何代号或取消机制，
     * 点 A 源再点 B 源，A 的响应可能比 B 晚到，表格里就成了 A 的歌、标签却停在 B 上。
     * 请求在途时也清空列表（`setRows([])`）：宁可显示「加载中」，也不显示别的源的歌。
     */
    const requestRef = useRef(0);

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

    /**
     * 取一页收藏。`append` 为 false 时先清空当前行——**清空发生在等待之前**，
     * 这样「标签已经换了、内容还是上一个源的」这个中间态根本不会出现。
     */
    const load = useCallback(
        async (sourceId: string, nextPage: number, append: boolean, collectionId?: string) => {
            const ticket = ++requestRef.current;

            if (!sourceId) {
                setRows([]);
                setHasMore(false);
                setLoading(false);
                return;
            }
            if (!append) {
                setRows([]);
                setHasMore(false);
            }
            setLoading(true);
            setError(null);

            const result = await catalogService.fetchFavoritesFrom(sourceId, nextPage, collectionId);
            // 期间换了源 / 换了收藏夹 / 又刷新了一次：这份结果已经过期，丢弃
            if (ticket !== requestRef.current) return;

            setLoading(false);
            setLoadedOnce(true);
            if (!result) {
                setRows([]);
                setHasMore(false);
                setError({code: 'common.unsupported_platform', message: '这个源不在本机核心里'});
                return;
            }
            if (result.error) {
                // 失败**不清空已有行**（翻页失败不该让用户丢掉前一页）；但首次加载时行已清空
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

    /**
     * 换源：先取该源的可选收藏夹，再用第一份（或默认收藏）取第一页。
     *
     * 一个 effect 管完整条链（而不是「collections effect + load effect」两条互相触发）：
     * 两条 effect 会在换源瞬间用**上一个源**的收藏夹 id 发一次请求，结果又被下一次覆盖，
     * 正是标签/内容错位的高发处。
     */
    useEffect(() => {
        if (!selected) {
            requestRef.current += 1; // 让在途请求作废
            setRows([]);
            setHasMore(false);
            setCollections([]);
            setCollection('');
            setLoading(false);
            return;
        }

        let cancelled = false;
        // 立刻作废上一个源的在途请求，并清空它的内容
        requestRef.current += 1;
        setRows([]);
        setHasMore(false);
        setPage(1);
        setCollections([]);
        setCollection('');
        setError(null);
        setLoading(true);

        void (async () => {
            const items = await catalogService.fetchFavoriteCollections(selected);
            if (cancelled) return;
            setCollections(items);
            const firstCollection = items[0]?.id;
            setCollection(firstCollection ?? '');
            await load(selected, 1, false, firstCollection);
        })();

        return () => {
            cancelled = true;
        };
    }, [selected, load]);

    const actionsOf = useCallback(
        (track: Track) => buildActions(track, {queue: rows, withDownload: true}),
        [buildActions, rows],
    );

    const columns: ColumnDef<Track>[] = useMemo(
        () => [
            indexColumn<Track>(),
            titleColumn<Track>(t),
            artistColumn<Track>(t),
            albumColumn<Track>(t),
            durationColumn<Track>(t),
            actionsColumn<Track>(t, actionsOf),
        ],
        [t, actionsOf],
    );

    /* 手机：两行式 + ⋯ 面板 */
    const compactColumns: ColumnDef<Track>[] = useMemo(
        () => mobileTrackColumns<Track>(t, {actions: actionsOf}),
        [t, actionsOf],
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

            {/* 收藏夹/歌单选择器：只有该源真的有多份收藏时才出现（单份收藏的源不打扰用户）。
                用可搜索的抽屉而不是一排单选：收藏夹可能上千个，一次性铺开没法用。 */}
            {collections.length > 1 && (
                <div className={styles.sourceBar}>
                    <CollectionPicker
                        options={collections.map((entry) => ({
                            id: entry.id,
                            title: entry.title,
                            ...(entry.count === undefined ? {} : {count: entry.count}),
                        }))}
                        value={collection || collections[0].id}
                        onChange={(value) => {
                            setCollection(value);
                            // 换收藏夹 = 换一份内容：立刻清空并重新取第一页（同样受请求代号保护）
                            void load(selected, 1, false, value);
                        }}
                    />
                </div>
            )}

            {error ? (
                <div className={styles.errorRow}>
                    <TextCell tone="danger">{errorText(t, error)}</TextCell>
                    {/* 绝大多数「取不到收藏」都是这个源还没登录：给一条能走的路，
                        而不是让用户自己猜「凭据/凭据与配置」在哪 */}
                    {error.code.startsWith('plugin.') && (
                        <Button size="sm" variant="ghost" onClick={() => navigate('/plugin')}>
                            {t('page.favorites.configureCredentials')}
                        </Button>
                    )}
                </div>
            ) : null}

            {loading && rows.length === 0 ? (
                <TextCell tone="muted">{t('common.loading')}</TextCell>
            ) : rows.length === 0 && !error ? (
                <EmptyState icon={<IconHeart size={30}/>} title={t('page.favorites.sourceEmpty')}/>
            ) : (
                <DataTable
                    columns={columns}
                    mobileColumns={compactColumns}
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
