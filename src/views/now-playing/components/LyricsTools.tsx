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
    LYRICS_OFFSET_LIMIT_SEC,
    LYRICS_OFFSET_STEP_SEC,
    clampLyricsOffset,
    lyricsOffsetForKey,
} from '../../../utils/lyricsOffset';
import {readLyricsSync, rawTrackIdOf, saveLyricsQuery} from '../../../utils/lyricsSyncCache';
import {readCachedLyricSearch, saveCachedLyricSearch} from '../../../utils/lyricsSearchCache';
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

/**
 * 打开工具格时这一格该有的状态（纯函数，冒烟直接钉住）。
 *
 * 两样都要恢复：**关键词**（持久化在 `lyricsSyncCache`）与**上次的搜索结果**
 * （会话级 `lyricsSearchCache`）——用户抱怨的正是「切走再回来还得重新搜一遍」。
 */
export function initialSearchState(track: Track): {query: string; result: LyricSearchResult | null} {
    return {query: querySeedFor(track), result: readCachedLyricSearch(track.id)};
}

/**
 * 「歌词」工具格（R143，原 `LyricsToolsDrawer` 的正交化重构）。
 *
 * 三段：时间轴校正 / 歌词来源 / 搜索歌词。旧版把三段塞进抽屉里的分格 tabs，
 * 结果「搜索」永远在第二层；现在 tool tabs 直接管三格之一，段内竖排一屏放得下，
 * 不再需要「抽屉里再分格」。
 *
 * `active` 只控制方向键微调：这一格没显示时不能抢走全页的方向键。
 */
export function LyricsTools({active}: {active: boolean}) {
    const {t} = useTranslation();
    const {current, lyricsSource, lyricsOffset} = usePlayerState();
    const {applyLyrics, nudgeLyricsOffset, setLyricsOffset, restoreAutoLyrics} = useActions().player;

    const trackId = current?.id ?? '';
    /* 首次挂载就带上这一首的关键词与上次的搜索结果：切走再回来不该重新搜一遍 */
    const seed = current ? initialSearchState(current) : {query: '', result: null};
    const [query, setQuery] = useState(seed.query);
    const [searching, setSearching] = useState(false);
    const [result, setResult] = useState<LyricSearchResult | null>(seed.result);
    const [searchError, setSearchError] = useState<CoreError | null>(null);
    const [noCore, setNoCore] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    /** 数字输入框的草稿：直接受控于 number 会让「-」这种中间态立刻被抹掉 */
    const [offsetDraft, setOffsetDraft] = useState(() => lyricsOffset.toFixed(1));

    useEffect(() => {
        setOffsetDraft(lyricsOffset.toFixed(1));
    }, [lyricsOffset]);

    const commitOffsetDraft = () => {
        const parsed = Number(offsetDraft.replace(',', '.'));
        if (!Number.isFinite(parsed)) {
            setOffsetDraft(lyricsOffset.toFixed(1));
            return;
        }
        const next = clampLyricsOffset(parsed);
        setLyricsOffset(next);
        setOffsetDraft(next.toFixed(1));
    };

    /* 应用成功的提示自己消失 */
    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    /* 换曲目：预填这首的关键词，并恢复**这一首**上次的搜索结果
       （上一首的结果不能留在这一首上，但这一首自己的要还回来） */
    useEffect(() => {
        const track = current;
        if (!track) return;
        const next = initialSearchState(track);
        setQuery(next.query);
        setResult(next.result);
        setSearchError(null);
        setNoCore(false);
    }, [trackId]); // eslint-disable-line react-hooks/exhaustive-deps

    /* 方向键微调：只在这一格显示时接管，输入框里打字不受影响 */
    useEffect(() => {
        if (!active) return;
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
    }, [active, nudgeLyricsOffset]);

    if (!current) return null;

    const onSearch = async (event: FormEvent) => {
        event.preventDefault();
        const keyword = query.trim();
        if (!keyword || searching) return;

        saveLyricsQuery(current.id, keyword);
        setSearching(true);
        setSearchError(null);
        setNoCore(false);
        setResult(null);
        try {
            const outcome = await catalogService.searchLyrics(keyword);
            if (outcome.error) setSearchError(outcome.error);
            else if (!outcome.data) setNoCore(true);
            else {
                setResult(outcome.data);
                /* 记住这首曲目的搜索结果：切走再回来（或收起再打开）不用重新搜 */
                saveCachedLyricSearch(current.id, outcome.data);
            }
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
        <div className={styles.lyricsTools}>
            {notice && <p className={styles.notice}>{notice}</p>}

            <section className={styles.block}>
                <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>{t('page.nowPlaying.syncTitle')}</h3>
                    <span className={styles.blockHint}>{t('page.nowPlaying.syncRemembered')}</span>
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

                {/* 大跨度校正：极端偏移时不必连点几十次；滑杆 + 数字框到任意合法值 */}
                <div className={styles.offsetRow}>
                    <input
                        className={styles.offsetSlider}
                        type="range"
                        min={-LYRICS_OFFSET_LIMIT_SEC}
                        max={LYRICS_OFFSET_LIMIT_SEC}
                        step={LYRICS_OFFSET_FINE_STEP_SEC}
                        value={lyricsOffset}
                        aria-label={t('page.nowPlaying.lyricsOffsetSlider')}
                        onChange={(event) => setLyricsOffset(Number(event.target.value))}
                    />
                    <input
                        className={styles.offsetInput}
                        type="number"
                        inputMode="decimal"
                        min={-LYRICS_OFFSET_LIMIT_SEC}
                        max={LYRICS_OFFSET_LIMIT_SEC}
                        step={LYRICS_OFFSET_FINE_STEP_SEC}
                        value={offsetDraft}
                        aria-label={t('page.nowPlaying.lyricsOffsetInput')}
                        onChange={(event) => setOffsetDraft(event.target.value)}
                        onBlur={commitOffsetDraft}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') commitOffsetDraft();
                        }}
                    />
                    <span className={styles.offsetUnit}>{t('page.nowPlaying.lyricsOffsetUnit')}</span>
                </div>

                <div className={styles.syncLegend}>
                    <span>{t('page.nowPlaying.syncEarlier')}</span>
                    <span className={styles.syncKeys}>{t('page.nowPlaying.syncKeys')}</span>
                    <span>{t('page.nowPlaying.syncLater')}</span>
                </div>
                <p className={styles.syncHint}>{t('page.nowPlaying.lyricsOffsetHint')}</p>
            </section>

            <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('page.nowPlaying.sourceTitle')}</h3>
                <p className={styles.sourceLine}>{sourceText}</p>
                {manual ? (
                    <div className={styles.manualRow}>
                        <span className={styles.manualHint}>{t('page.nowPlaying.sourceManual')}</span>
                        <Button size="sm" variant="ghost" onClick={restoreAutoLyrics}>
                            {t('page.nowPlaying.restoreAuto')}
                        </Button>
                    </div>
                ) : (
                    <span className={styles.blockHint}>{t('page.nowPlaying.sourceAutoHint')}</span>
                )}
            </section>

            <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('page.nowPlaying.searchLyrics')}</h3>

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

                {searching && <p className={styles.status}>{t('page.nowPlaying.searchLyricsLoading')}</p>}
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
        </div>
    );
}

export default LyricsTools;
