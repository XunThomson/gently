import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../components/ui/empty-state';
import {IconMusic} from '../../components/ui/icon';
import {Button} from '../../components/ui/button';
import {Page} from '../../components/ui/page';
import {SourceFilter} from '../../components/ui/source-filter';
import {errorText} from '../../i18n/errors';
import {useActions, useRankingState, useSelect} from '../../store';
import {ChartList} from './components/ChartList';
import {TopListNav} from './components/TopListNav';
import styles from './ranking.module.css';

/**
 * 排行榜视图：**按源给的分类树**渲染。
 *
 * 真实源提供的是任意分类（契约 §2 把 v0.1 的固定 hot/new/rise 枚举换成了
 * `catalog.topLists` / `catalog.topList`），因此这里不再有「日/周/月」时间轴：
 * 树长什么样由源决定，视图只负责展示与翻页。
 */
export default function RankingView() {
    const {t} = useTranslation();
    const {groups, selectedId, rows, hasMore, loading, loaded, error} = useRankingState();
    /* 只订阅「正在播放哪一首」，避免每秒进度更新触发整页重渲染 */
    const currentKey = useSelect((s) =>
        s.player.current ? `${s.player.current.title}|${s.player.current.artist}` : null,
    );
    /* 音源筛选变化后重新拉分类树（换了源就换了树） */
    const sourceFilter = useSelect((s) => s.ui.sourceFilter);
    const {load, selectItem, loadMore} = useActions().ranking;
    const {playOrToggle} = useActions().player;

    useEffect(() => {
        void load();
    }, [load, sourceFilter]);

    const selectedItem = useMemo(
        () => groups.flatMap((group) => group.items).find((item) => item.id === selectedId) ?? null,
        [groups, selectedId],
    );

    const handleSelect = (track: (typeof rows)[number]) => playOrToggle(track, rows);

    return (
        <Page
            title={t('page.ranking.title')}
            subtitle={selectedItem?.title ?? t('page.ranking.subtitle')}
            toolbar={<SourceFilter/>}
        >
            {loaded && groups.length === 0 ? (
                /* 源报错与「源没有榜单」是两件事：前者必须把原因说出来，
                   否则用户会以为「这个源本来就没榜单」而放弃排查 */
                error ? (
                    <EmptyState
                        icon={<IconMusic size={30}/>}
                        title={t('page.ranking.sourceErrorTitle')}
                        hint={errorText(t, error)}
                    />
                ) : (
                    <EmptyState
                        icon={<IconMusic size={30}/>}
                        title={t('page.ranking.noGroupsTitle')}
                        hint={t('page.ranking.noGroupsHint')}
                    />
                )
            ) : (
                <>
                    {groups.length > 0 && (
                        <TopListNav groups={groups} selectedId={selectedId} onSelect={(id) => void selectItem(id)}/>
                    )}

                    <ChartList
                        rows={rows}
                        loading={loading}
                        currentTitle={currentKey}
                        onSelect={handleSelect}
                    />

                    {/* 分类树拿到了、但这一页取不回来（上游失败）：同样把原因说出来 */}
                    {error && rows.length === 0 && (
                        <p className={styles.errorHint}>{errorText(t, error)}</p>
                    )}

                    {/* 分页由源决定：只有源说「还有下一页」时才给出入口 */}
                    {hasMore && (
                        <div>
                            <Button variant="ghost" disabled={loading} onClick={() => void loadMore()}>
                                {loading ? t('common.loading') : t('page.ranking.loadMore')}
                            </Button>
                        </div>
                    )}
                </>
            )}
        </Page>
    );
}
