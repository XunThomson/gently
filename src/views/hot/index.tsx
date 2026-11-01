import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate, useSearchParams} from 'react-router';
import {AlbumGrid} from '../../components/ui/album-grid';
import {EmptyState} from '../../components/ui/empty-state';
import {Page} from '../../components/ui/page';
import {PlaylistGrid} from '../../components/ui/playlist-grid';
import {SectionHeader} from '../../components/ui/section-header';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
import {useActions, usePluginState, useRecommendState, useSelect} from '../../store';
import type {Album, CuratedPlaylist, RecommendedTrack} from '../../types';
import {topTags} from '../../utils/taste';
import {DiscoverPanel} from './components/DiscoverPanel';
import {TrackGrid} from './components/TrackGrid';
import styles from './hot.module.css';

type HotTab = 'recommend' | 'discover';

/** 详情页路径：源与 id 都要编码（源的 id 与 id 里可能带 `:` 等字符） */
const collectionPath = (kind: 'album' | 'curated', item: Album | CuratedPlaylist): string =>
    `/collection/${kind}/${encodeURIComponent(item.source)}/${encodeURIComponent(item.id)}`;

/**
 * 热门推荐页 — 两个 tab：
 *
 * - **热门推荐**：个性化推荐的聚合页（单曲 / 专辑 / 歌单 + 源侧推荐），本轮之前的内容；
 * - **发现**（R87 新增）：把歌曲当成实体出版物摆上架——包装按 id 稳定映射成
 *   黑胶 / 磁带 / 光盘，竖插在书架上只露侧脊，聚焦即试听高潮片段，右侧是快速列表。
 *
 * 两个 tab 共用同一份推荐数据：发现页展示的正是「推荐给你的歌」，
 * 不另造一份数据源（否则「推荐」和「发现」会给出两套互相矛盾的歌）。
 */
export default function HotView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {bundle, loading, loaded, sourceTracks, sourceId, sourceLoading} = useRecommendState();
    const {load, loadSource, dislike} = useActions().recommend;
    const {playOrToggle} = useActions().player;
    const currentId = useSelect((s) => s.player.current?.id ?? null);
    const playing = useSelect((s) => s.player.playing);
    const pluginList = usePluginState().list;
    /**
     * 当前 tab 由 **URL 决定**（`?tab=discover`），与下载管理页同一套做法：
     * 刷新/前进后退不丢、可分享，而且脚本与自动化也能直接驱动到指定子视图
     * （本地 state 版本在打包版里点不动时，脚本没有任何别的入口）。
     */
    const [searchParams, setSearchParams] = useSearchParams();
    const tab: HotTab = searchParams.get('tab') === 'discover' ? 'discover' : 'recommend';
    const setTab = (next: HotTab) => {
        const params = new URLSearchParams(searchParams);
        if (next === 'recommend') params.delete('tab');
        else params.set('tab', next);
        setSearchParams(params, {replace: true});
    };

    useEffect(() => {
        // 首次进入时先确保本地库（画像输入）就绪，再生成推荐；源侧推荐与它并行
        void load();
        void loadSource();
    }, [load, loadSource]);

    /* 发现页的书架数据：个性化推荐 + 源侧推荐（去重在面板内做） */
    const discoverTracks = useMemo(
        () => [...(bundle?.tracks ?? []), ...sourceTracks],
        [bundle?.tracks, sourceTracks],
    );

    const sourceName = pluginList.find((plugin) => plugin.id === sourceId)?.name ?? sourceId ?? '';

    if (!bundle) {
        return (
            <Page title={t('page.hot.title')} subtitle={t('page.hot.recommendSub')}>
                <EmptyState title={loading || !loaded ? t('common.loading') : t('recommend.profileEmpty')}/>
            </Page>
        );
    }

    const {profile, tracks, albums, playlists} = bundle;
    const tags = topTags(profile, 3);
    const profileText = tags.length > 0 ? tags.join(' · ') : t('recommend.profileEmpty');

    return (
        <Page
            title={t('page.hot.title')}
            subtitle={t('page.hot.recommendSub')}
            toolbar={
                <>
                    <UnderlineRadioGroup
                        name="hot-tab"
                        value={tab}
                        onChange={(value) => setTab(value as HotTab)}
                        options={[
                            {value: 'recommend', label: t('page.hot.tabRecommend')},
                            {value: 'discover', label: t('page.hot.tabDiscover')},
                        ]}
                    />
                    <span className={styles.profile} title={t('recommend.profile')}>
                        <span className={styles.profileLabel}>{t('recommend.profile')}</span>
                        <span className={styles.profileValue}>{profileText}</span>
                    </span>
                </>
            }
        >
            {tab === 'discover' ? (
                <section className={styles.section}>
                    <SectionHeader
                        title={t('page.hot.discoverTitle')}
                        subtitle={t('page.hot.discoverSubtitle')}
                    />
                    <DiscoverPanel tracks={discoverTracks}/>
                </section>
            ) : (
                <>
                    <section className={styles.section}>
                        <SectionHeader
                            title={t('recommend.tracksTitle')}
                            subtitle={t('recommend.tracksSubtitle')}
                        />
                        {/* 空态文案是**推荐专用**的：搜索页那套「没有找到匹配的歌曲 / 试试其他关键词」
                                放在这里会让人以为「推荐等于搜索」，也不知道该做什么 */}
                        <TrackGrid
                            tracks={tracks}
                            loading={loading}
                            currentId={currentId}
                            playing={playing}
                            reasonOf={(track) => (track as RecommendedTrack).reason}
                            onDislike={dislike}
                            onSelect={(track) => playOrToggle(track, tracks)}
                            emptyTitleKey="page.hot.emptyTitle"
                            emptyHintKey="page.hot.emptyHint"
                        />
                    </section>

                    {/* 源侧推荐：源可能没有实现 getRecommend（能力探测）或跑挂 → 直接不显示这一栏 */}
                    {(sourceLoading || sourceTracks.length > 0) && (
                        <section className={styles.section}>
                            <SectionHeader
                                title={t('recommend.sourceTitle')}
                                subtitle={t('recommend.sourceSubtitle', {source: sourceName})}
                            />
                            <TrackGrid
                                tracks={sourceTracks}
                                loading={sourceLoading}
                                currentId={currentId}
                                playing={playing}
                                onDislike={dislike}
                                onSelect={(track) => playOrToggle(track, sourceTracks)}
                            />
                        </section>
                    )}

                    <section className={styles.section}>
                        <SectionHeader
                            title={t('recommend.albumsTitle')}
                            subtitle={t('recommend.albumsSubtitle')}
                        />
                        <AlbumGrid
                            albums={albums}
                            /* 点卡片 → 看详情（完整曲目在详情页）；封面上的播放按钮直接播 */
                            onSelect={(album) => navigate(collectionPath('album', album))}
                            onPlay={(album) => album.tracks[0] && playOrToggle(album.tracks[0], album.tracks)}
                        />
                    </section>

                    <section className={styles.section}>
                        <SectionHeader
                            title={t('recommend.playlistsTitle')}
                            subtitle={t('recommend.playlistsSubtitle')}
                        />
                        <PlaylistGrid
                            playlists={playlists}
                            onSelect={(playlist) => navigate(collectionPath('curated', playlist))}
                            onPlay={(playlist) => playOrToggle(playlist.tracks[0], playlist.tracks)}
                        />
                    </section>
                </>
            )}
        </Page>
    );
}
