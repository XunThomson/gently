import {useEffect, useState, type FormEvent} from 'react';
import {useTranslation} from 'react-i18next';
import type {CoreError, LyricSearchItem, LyricSearchResult} from '../../../api';
import {Button} from '../../../components/ui/button';
import {errorText} from '../../../i18n/errors';
import {catalogService} from '../../../services';
import {useActions, usePlayerState} from '../../../store';
import type {Track} from '../../../types';
import {toLyricLines} from '../../../utils/lyrics';
import {
    LYRICS_OFFSET_FINE_STEP_SEC,
    LYRICS_OFFSET_STEP_SEC,
    lyricsOffsetForKey,
} from '../../../utils/lyricsOffset';
import {rawTrackIdOf, readLyricsSync, saveLyricsQuery} from '../../../utils/lyricsSyncCache';
import styles from '../now-playing.module.css';

/** 结果里第一行歌词，用来让用户一眼看出「这份词对不对」 */
function firstLineOf(item: LyricSearchItem): string {
    return toLyricLines(item.lyrics)[0]?.text ?? item.lyrics.content.slice(0, 60);
}

/** 搜索框的默认关键词：上次搜过的词优先，其次是「标题 + 歌手」 */
function querySeedFor(track: Track): string {
    const remembered = readLyricsSync(track.id).query;
    return remembered ?? `${track.title} ${track.artist}`.trim();
}

const TABS = ['sync', 'source', 'search'] as const;
type Tab = (typeof TABS)[number];

/**
 * 歌词页的**工具抽屉**（默认收起，首次展开才挂载）。
 *
 * 为什么要抽屉：歌曲信息与功能性操作都属于播放条（AGENTS #9），歌词页只该有「封面 + 歌词」。
 * 但「歌词搜不搜得到、对不对得齐」是歌词页自己的事，于是收进一个按需展开的抽屉：
 * - **时间轴校正**：0.1 秒细调 / 0.5 秒粗调 / 方向键微调，逐曲目记住；
 * - **歌词来源**：当前这份词来自哪个源；手动挑过的会记住，也能一键改回源歌词；
 * - **搜索歌词**：跨源按关键词找词。
 *
 * 两层惰性：抽屉第一次点开才挂载；抽屉里的三格也各自**第一次被选中**才挂载
 * （默认只挂「时间轴校正」）。收起不卸载——刚搜到的东西不该因为收起就没了。
 *
 * 为什么分格而不是竖排三段：歌词卡片高度固定，三段竖排会把「搜索」挤到需要滚动才能看见的地方，
 * 用户根本发现不了；分格后每格都能一屏放下。
 */
export function LyricsToolsDrawer({open}: {open: boolean}) {
    const {t} = useTranslation();
    const {current, lyricsSource, lyricsOffset} = usePlayerState();
    const {applyLyrics, nudgeLyricsOffset, setLyricsOffset, restoreAutoLyrics} = useActions().player;

    const trackId = current?.id ?? '';
    const [tab, setTab] = useState<Tab>('sync');
    const [visited, setVisited] = useState<Tab[]>(['sync']);
    const [query, setQuery] = useState(() => (current ? querySeedFor(current) : ''));
    const [searching, setSearching] = useState(false);
    const [result, setResult] = useState<LyricSearchResult | null>(null);
    const [searchError, setSearchError] = useState<CoreError | null>(null);
    const [noCore, setNoCore] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    /* 应用成功的提示自己消失 */
    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    /* 换曲目：预填这首的关键词，上一首的结果不能留在这一首上 */
    useEffect(() => {
        const track = current;
        if (!track) return;
        setQuery(querySeedFor(track));
        setResult(null);
        setSearchError(null);
        setNoCore(false);
    }, [trackId]); // eslint-disable-line react-hooks/exhaustive-deps

    /* 方向键微调：只在这个抽屉开着时接管，输入框里打字不受影响 */
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const delta = lyricsOffsetForKey(event.key, event.shiftKey);
            if (delta === null) return;
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName ?? '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (target?.closest('[role="slider"]')) return;
            event.preventDefault();
            nudgeLyricsOffset(delta);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [open, nudgeLyricsOffset]);

    const currentTrack = current;
    if (!currentTrack) return null;

    const selectTab = (next: Tab) => {
        setTab(next);
        setVisited((prev) => (prev.includes(next) ? prev : [...prev, next]));
    };

    const tabLabel = (id: Tab) => {
        if (id === 'sync') return t('page.nowPlaying.syncTitle');
        if (id === 'source') return t('page.nowPlaying.sourceTitle');
        return t('page.nowPlaying.searchLyrics');
    };

    const onSearch = async (event: FormEvent) => {
        event.preventDefault();
        const keyword = query.trim();
        if (!keyword || searching) return;

        saveLyricsQuery(currentTrack.id, keyword);
        setSearching(true);
        setSearchError(null);
        setNoCore(false);
        setResult(null);
        try {
            const outcome = await catalogService.searchLyrics(keyword);
            if (outcome.error) setSearchError(outcome.error);
            else if (!outcome.data) setNoCore(true);
            else setResult(outcome.data);
        } finally {
            setSearching(false);
        }
    };

    const useResult = (item: LyricSearchItem) => {
        applyLyrics(toLyricLines(item.lyrics), {
            source: item.source,
            sourceName: item.sourceName,
            title: item.track.title,
            artist: item.track.artist,
            /* 记住来路要的是**插件内的 rawId**（`item.track.id` 已是 `source:rawId` 的完整引用） */
            trackId: rawTrackIdOf(item.source, item.track.id),
        });
        setNotice(t('page.nowPlaying.lyricsApplied', {title: item.track.title}));
    };

    const offsetValue = `${lyricsOffset > 0 ? '+' : ''}${lyricsOffset.toFixed(1)}`;
    const manual = Boolean(lyricsSource?.trackId);
    const sourceText = lyricsSource
        ? t('page.nowPlaying.lyricsSourceTrack', {
            source: lyricsSource.sourceName,
            title: lyricsSource.title,
        })
        : t('page.nowPlaying.lyricsSourceAuto');

    return (
        <div className={styles.drawer} hidden={!open}>
            {notice && <p className={styles.notice}>{notice}</p>}

            <div className={styles.tabs} role="tablist">
                {TABS.map((id) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        className={styles.tab}
                        data-active={tab === id}
                        onClick={() => selectTab(id)}
                    >
                        {tabLabel(id)}
                    </button>
                ))}
            </div>

            {visited.includes('sync') && (
                <section className={styles.block} role="tabpanel" hidden={tab !== 'sync'}>
                    <div className={styles.blockHead}>
                        <span className={styles.blockHint}>
                            {t('page.nowPlaying.syncRemembered')}
                        </span>
                    </div>

                    <div className={styles.syncRow}>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`-${LYRICS_OFFSET_STEP_SEC}`}
                            onClick={() => nudgeLyricsOffset(-LYRICS_OFFSET_STEP_SEC)}
                        >
                            −{LYRICS_OFFSET_STEP_SEC}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`-${LYRICS_OFFSET_FINE_STEP_SEC}`}
                            onClick={() => nudgeLyricsOffset(-LYRICS_OFFSET_FINE_STEP_SEC)}
                        >
                            −{LYRICS_OFFSET_FINE_STEP_SEC}
                        </Button>
                        <span
                            className={styles.offsetValue}
                            data-zero={lyricsOffset === 0}
                            aria-live="polite"
                        >
                            {t('page.nowPlaying.lyricsOffsetValue', {value: offsetValue})}
                        </span>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`+${LYRICS_OFFSET_FINE_STEP_SEC}`}
                            onClick={() => nudgeLyricsOffset(LYRICS_OFFSET_FINE_STEP_SEC)}
                        >
                            +{LYRICS_OFFSET_FINE_STEP_SEC}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`+${LYRICS_OFFSET_STEP_SEC}`}
                            onClick={() => nudgeLyricsOffset(LYRICS_OFFSET_STEP_SEC)}
                        >
                            +{LYRICS_OFFSET_STEP_SEC}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={lyricsOffset === 0}
                            onClick={() => setLyricsOffset(0)}
                        >
                            {t('page.nowPlaying.lyricsOffsetReset')}
                        </Button>
                    </div>

                    <div className={styles.syncLegend}>
                        <span>{t('page.nowPlaying.syncEarlier')}</span>
                        <span className={styles.syncKeys}>{t('page.nowPlaying.syncKeys')}</span>
                        <span>{t('page.nowPlaying.syncLater')}</span>
                    </div>
                    <p className={styles.syncHint}>{t('page.nowPlaying.lyricsOffsetHint')}</p>
                </section>
            )}

            {visited.includes('source') && (
                <section className={styles.block} role="tabpanel" hidden={tab !== 'source'}>
                    <p className={styles.sourceLine}>{sourceText}</p>
                    {manual ? (
                        <div className={styles.manualRow}>
                            <span className={styles.manualHint}>
                                {t('page.nowPlaying.sourceManual')}
                            </span>
                            <Button size="sm" variant="ghost" onClick={restoreAutoLyrics}>
                                {t('page.nowPlaying.restoreAuto')}
                            </Button>
                        </div>
                    ) : (
                        <span className={styles.blockHint}>
                            {t('page.nowPlaying.sourceAutoHint')}
                        </span>
                    )}
                </section>
            )}

            {visited.includes('search') && (
                <section className={styles.block} role="tabpanel" hidden={tab !== 'search'}>
                    <form className={styles.searchForm} onSubmit={onSearch}>
                        <input
                            className={styles.searchInput}
                            type="text"
                            value={query}
                            placeholder={t('page.nowPlaying.searchLyricsPlaceholder')}
                            aria-label={t('page.nowPlaying.searchLyrics')}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        <Button type="submit" size="sm" disabled={searching || !query.trim()}>
                            {t('search.submit')}
                        </Button>
                    </form>
                    <p className={styles.searchHint}>{t('page.nowPlaying.searchLyricsHint')}</p>

                    {searching && (
                        <p className={styles.status}>{t('page.nowPlaying.searchLyricsLoading')}</p>
                    )}
                    {noCore && <p className={styles.status}>{t('page.nowPlaying.searchLyricsNoCore')}</p>}
                    {searchError && <p className={styles.status}>{errorText(t, searchError)}</p>}

                    {result && (
                        <>
                            <p className={styles.status}>
                                {t('page.nowPlaying.searchLyricsStats', {
                                    sources: result.searchedSources.length,
                                    count: result.items.length,
                                })}
                                {result.skippedSources.length > 0 &&
                                    ` · ${t('page.nowPlaying.searchLyricsSkipped', {
                                        count: result.skippedSources.length,
                                    })}`}
                                {result.timedOutSources.length > 0 &&
                                    ` · ${t('page.nowPlaying.searchLyricsTimedOut', {
                                        count: result.timedOutSources.length,
                                    })}`}
                            </p>

                            {result.items.length === 0 ? (
                                <p className={styles.status}>{t('page.nowPlaying.searchLyricsEmpty')}</p>
                            ) : (
                                <ul className={styles.results}>
                                    {result.items.map((item) => (
                                        <li
                                            key={`${item.source}:${item.track.id}`}
                                            className={styles.result}
                                        >
                                            <div className={styles.resultMeta}>
                                                <span className={styles.resultTitle}>
                                                    <span className={styles.sourceBadge}>
                                                        {item.sourceName}
                                                    </span>
                                                    {item.track.title}
                                                </span>
                                                <span className={styles.resultSub}>
                                                    {item.track.artist} · {firstLineOf(item)}
                                                </span>
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="default"
                                                onClick={() => useResult(item)}
                                            >
                                                {t('page.nowPlaying.useLyrics')}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}
                </section>
            )}
        </div>
    );
}
