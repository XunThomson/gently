import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate, useParams} from 'react-router';
import {Button} from '../../components/ui/button';
import {DataTable, type ColumnDef} from '../../components/ui/data-table';
import {EmptyState} from '../../components/ui/empty-state';
import {IconMusic, IconPlay} from '../../components/ui/icon';
import {Page} from '../../components/ui/page';
import {SectionHeader} from '../../components/ui/section-header';
import {
    actionsColumn,
    albumColumn,
    artistColumn,
    durationColumn,
    indexColumn,
    titleColumn,
} from '../../config/table.config';
import {useCurrentTrackId, usePlayRow, useTrackActions} from '../../hooks/useTrackActions';
import {errorText} from '../../i18n/errors';
import {catalogService, recommendService} from '../../services';
import type {CoreError} from '../../api';
import type {Album, CuratedPlaylist, RecommendedTrack, Track} from '../../types';
import {coverStyle} from '../../utils/cover';
import {SimilarList} from './components/SimilarList';
import styles from './collection.module.css';

/** 详情页支持的两类对象：源侧的专辑与精选歌单（形状同构，只有元数据字段不同） */
type CollectionKind = 'album' | 'curated';
type Collection = Album | CuratedPlaylist;

/** 相似推荐展示条数：它是「下一步去哪」的提示，不该盖过专辑本身 */
const SIMILAR_LIMIT = 6;

const isKind = (value: string | undefined): value is CollectionKind =>
    value === 'album' || value === 'curated';

const isPlaylist = (item: Collection): item is CuratedPlaylist => 'description' in item;

/**
 * 专辑 / 精选歌单详情（契约 `catalog.album` / `catalog.playlist`）。
 *
 * 一个页面覆盖两类对象：它们都是「一组曲目 + 一点元数据」，差别只在专辑有年份/歌手、
 * 歌单有描述/标签。分成两个几乎一样的页面只会让改动需要改两遍。
 *
 * 数据是**视图内的一次性请求**（按路由参数拉一次），不进 store——它不被其它视图消费，
 * 放进去只会多一份需要同步的缓存。
 */
export default function CollectionView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {kind, source = '', id = ''} = useParams();
    const buildActions = useTrackActions();
    const playRow = usePlayRow();
    const currentId = useCurrentTrackId();

    const [item, setItem] = useState<Collection | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<CoreError | null>(null);
    /** 相似推荐（只有核心能算；拿不到就是空数组，视图不渲染这一块） */
    const [similar, setSimilar] = useState<RecommendedTrack[]>([]);

    const valid = isKind(kind);

    useEffect(() => {
        if (!valid) {
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);

        const load = async () => {
            const result =
                kind === 'album'
                    ? await catalogService.fetchAlbum(source, id)
                    : await catalogService.fetchCuratedPlaylist(source, id);
            if (cancelled) return;
            setItem(result);
            setLoading(false);
        };

        void load().catch((err: unknown) => {
            if (cancelled) return;
            setError({
                code: 'common.internal',
                message: err instanceof Error ? err.message : String(err),
            });
            setLoading(false);
        });

        return () => {
            cancelled = true;
        };
    }, [kind, source, id, valid]);

    const rows = useMemo(() => item?.tracks ?? [], [item]);

    /**
     * 相似推荐：用**曲目种子**（而不是专辑 id）——专辑种子的特征匹配依赖快照里的
     * `albumId` 与源侧专辑 id 一致，而插件并不保证提供这个字段；曲目种子是稳的。
     * 拿不到就保持空数组（浏览器预览与「本机库还没有可比较的邻居」都会走这里）。
     */
    useEffect(() => {
        const seed = rows[0];
        if (!seed) {
            setSimilar([]);
            return;
        }

        let cancelled = false;
        void recommendService.similar(seed, SIMILAR_LIMIT).then((tracks) => {
            if (!cancelled) setSimilar(tracks);
        });

        return () => {
            cancelled = true;
        };
    }, [rows]);

    const columns: ColumnDef<Track>[] = [
        indexColumn<Track>(),
        titleColumn<Track>(t),
        artistColumn<Track>(t),
        albumColumn<Track>(t),
        durationColumn<Track>(t),
        actionsColumn<Track>(t, (track) => buildActions(track, {queue: rows, withDownload: true})),
    ];

    if (!valid) {
        return (
            <Page title={t('page.collection.title')}>
                <EmptyState icon={<IconMusic size={30}/>} title={t('page.collection.notFound')}/>
            </Page>
        );
    }

    const fallbackTitle = t(kind === 'album' ? 'page.collection.album' : 'page.collection.curated');

    if (!item) {
        return (
            <Page title={fallbackTitle}>
                <EmptyState
                    icon={<IconMusic size={30}/>}
                    title={loading ? t('common.loading') : t('page.collection.notFound')}
                    hint={error ? errorText(t, error) : undefined}
                />
            </Page>
        );
    }

    const subtitle = isPlaylist(item)
        ? item.description || t('page.collection.trackCount', {count: rows.length})
        : `${item.artist} · ${t('page.collection.trackCount', {count: rows.length})}`;

    return (
        <Page
            title={item.title}
            subtitle={subtitle}
            toolbar={
                <div className={styles.toolbar}>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(-1)}
                    >
                        {t('common.back')}
                    </Button>
                    <Button
                        size="sm"
                        variant="primary"
                        icon={<IconPlay size={14}/>}
                        disabled={rows.length === 0}
                        onClick={() => rows[0] && playRow(rows[0], rows)}
                    >
                        {t('page.collection.playAll')}
                    </Button>
                </div>
            }
        >
            <div className={styles.head}>
                <span
                    className={styles.cover}
                    style={coverStyle(item.cover, `${item.source}|${item.title}`)}
                >
                    <span className={styles.initial}>{item.title.slice(0, 1)}</span>
                </span>

                <div className={styles.meta}>
                    <span className={styles.kind}>
                        {t(kind === 'album' ? 'page.collection.album' : 'page.collection.curated')}
                    </span>
                    {item.tags.length > 0 && (
                        <div className={styles.tags}>
                            {item.tags.map((tag) => (
                                <span key={tag} className={styles.tag}>
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                    {!isPlaylist(item) && item.year > 0 && (
                        <span className={styles.year}>{item.year}</span>
                    )}
                </div>
            </div>

            {rows.length === 0 ? (
                <EmptyState icon={<IconMusic size={30}/>} title={t('page.collection.empty')}/>
            ) : (
                <DataTable
                    columns={columns}
                    dataSource={rows}
                    rowKey="id"
                    loading={loading}
                    loadingText={t('common.loading')}
                    emptyText={t('page.collection.empty')}
                    onRowClick={(track) => playRow(track, rows)}
                    activeRowKey={currentId ?? undefined}
                />
            )}

            {/* 相似推荐：核心按本机库找邻居；没有邻居（或没有核心）时整块不出现 */}
            {similar.length > 0 && (
                <section className={styles.similar}>
                    <SectionHeader
                        title={t('page.collection.similarTitle')}
                        subtitle={t('page.collection.similarSubtitle')}
                    />
                    <SimilarList
                        tracks={similar}
                        currentId={currentId}
                        onSelect={(track) => playRow(track, similar)}
                    />
                </section>
            )}
        </Page>
    );
}
