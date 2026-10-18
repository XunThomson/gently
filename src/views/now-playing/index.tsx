import {useEffect, useState, type FormEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import type {CoreError, LyricSearchItem, LyricSearchResult} from '../../api';
import {Button} from '../../components/ui/button';
import {EmptyState} from '../../components/ui/empty-state';
import {IconChevronLeft, IconMusic, IconPause, IconPlay, IconSearch} from '../../components/ui/icon';
import {Lyrics} from '../../components/ui/lyrics';
import {errorText} from '../../i18n/errors';
import {catalogService} from '../../services';
import {useActions, usePlayerState} from '../../store';
import {trackCoverStyle} from '../../utils/cover';
import {toLyricLines} from '../../utils/lyrics';
import {LYRICS_OFFSET_STEP_SEC} from '../../utils/lyricsOffset';
import styles from './now-playing.module.css';

/** 结果里第一行歌词，用来让用户一眼看出「这份词对不对」 */
function firstLineOf(item: LyricSearchItem): string {
    return toLyricLines(item.lyrics)[0]?.text ?? item.lyrics.content.slice(0, 60);
}

/**
 * 歌词页。
 *
 * 歌曲信息（歌手 / 专辑 / 时长 / 来源）与功能性操作（收藏 / 下载 / 加入歌单）
 * 都在播放条与功能抽屉里，本页负责「封面 + 歌词」，外加两件与歌词直接相关的事：
 * - **搜索歌词**：源不给词 / 各源歌名不一致时，用户自己跨源挑一份（带来源信息）；
 * - **时间轴校正**：歌词与音频对不上时，±0.5 秒手动校正（按曲目记住）。
 */
export default function NowPlayingView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {current, detail, playing, elapsed, lyrics, lyricsSource, lyricsOffset} = usePlayerState();
    const {seek, toggle, applyLyrics, setLyricsOffset} = useActions().player;

    /* 搜索面板是**视图内**的临时状态（只有这一页消费，不进全局 store） */
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [result, setResult] = useState<LyricSearchResult | null>(null);
    const [searchError, setSearchError] = useState<CoreError | null>(null);
    const [noCore, setNoCore] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    /* 应用成功的提示自己消失；卸载时清掉定时器 */
    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    if (!current) {
        return (
            <div className={styles.page}>
                <EmptyState
                    icon={<IconMusic size={32}/>}
                    title={t('player.notPlaying')}
                    hint={t('player.pickSong')}
                />
            </div>
        );
    }

    /* 返回：有应用内历史就退一步；直接打开本页（刷新 / 深链）时退回首页，
       不把用户丢出应用（`navigate(-1)` 在栈底等于关闭窗口）。 */
    const goBack = () => {
        const idx =
            typeof window !== 'undefined'
                ? Number((window.history.state as {idx?: unknown} | null)?.idx ?? 0)
                : 0;
        if (idx > 0) navigate(-1);
        else navigate('/', {replace: true});
    };

    const toggleSearch = () => {
        setSearchOpen((open) => {
            if (!open) setQuery(`${current.title} ${current.artist}`.trim());
            return !open;
        });
    };

    const onSearch = async (event: FormEvent) => {
        event.preventDefault();
        const keyword = query.trim();
        if (!keyword || searching) return;

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
        });
        setSearchOpen(false);
        setNotice(t('page.nowPlaying.lyricsApplied', {title: item.track.title}));
    };

    const nudgeOffset = (delta: number) => setLyricsOffset(lyricsOffset + delta);

    const offsetValue = `${lyricsOffset > 0 ? '+' : ''}${lyricsOffset.toFixed(1)}`;
    const sourceText = lyricsSource
        ? t('page.nowPlaying.lyricsSourceTrack', {
            source: lyricsSource.sourceName,
            title: lyricsSource.title,
        })
        : t('page.nowPlaying.lyricsSourceAuto');

    /* 封面优先用源侧详情（`catalog.track`）：列表快照常常只有标题歌手 */
    const artwork = detail ?? current;

    return (
        <div className={styles.page}>
            <button type="button" className={styles.back} onClick={goBack}>
                <IconChevronLeft size={16}/>
                {t('common.back')}
            </button>

            <div className={styles.layout}>
                <section className={styles.artwork}>
                    <div
                        className={styles.cover}
                        style={trackCoverStyle(artwork)}
                    >
                        <span className={styles.initial}>{artwork.title.slice(0, 1)}</span>
                        <button
                            type="button"
                            className={styles.coverPlay}
                            aria-label={playing ? t('common.pause') : t('common.play')}
                            onClick={toggle}
                        >
                            {playing ? <IconPause size={16}/> : <IconPlay size={16}/>}
                        </button>
                    </div>
                    <p className={styles.caption}>{current.title}</p>
                </section>

                <section className={styles.lyricsPanel}>
                    <div className={styles.lyricsHeader}>
                        <h2 className={styles.lyricsTitle}>{t('page.nowPlaying.lyrics')}</h2>
                        <div className={styles.headerActions}>
                            <span className={styles.sourceChip} title={sourceText}>
                                {sourceText}
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-expanded={searchOpen}
                                onClick={toggleSearch}
                                icon={<IconSearch size={14}/>}
                            >
                                {t('page.nowPlaying.searchLyrics')}
                            </Button>
                        </div>
                    </div>

                    {searchOpen && (
                        <div className={styles.searchPanel}>
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
                            {noCore && (
                                <p className={styles.status}>{t('page.nowPlaying.searchLyricsNoCore')}</p>
                            )}
                            {searchError && (
                                <p className={styles.status}>{errorText(t, searchError)}</p>
                            )}

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
                                        <p className={styles.status}>
                                            {t('page.nowPlaying.searchLyricsEmpty')}
                                        </p>
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
                        </div>
                    )}

                    <div className={styles.syncRow}>
                        <span className={styles.syncLabel}>{t('page.nowPlaying.lyricsOffset')}</span>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`-${LYRICS_OFFSET_STEP_SEC}`}
                            onClick={() => nudgeOffset(-LYRICS_OFFSET_STEP_SEC)}
                        >
                            −{LYRICS_OFFSET_STEP_SEC}s
                        </Button>
                        <span className={styles.offsetValue}>
                            {t('page.nowPlaying.lyricsOffsetValue', {value: offsetValue})}
                        </span>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`+${LYRICS_OFFSET_STEP_SEC}`}
                            onClick={() => nudgeOffset(LYRICS_OFFSET_STEP_SEC)}
                        >
                            +{LYRICS_OFFSET_STEP_SEC}s
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={lyricsOffset === 0}
                            onClick={() => setLyricsOffset(0)}
                        >
                            {t('page.nowPlaying.lyricsOffsetReset')}
                        </Button>
                        <span className={styles.syncHint}>
                            {t('page.nowPlaying.lyricsOffsetHint')}
                        </span>
                    </div>

                    {notice && <p className={styles.notice}>{notice}</p>}

                    <div className={styles.lyricsBody}>
                        <Lyrics
                            lines={lyrics}
                            elapsed={elapsed + lyricsOffset}
                            onSeek={(time) => seek(Math.max(0, time - lyricsOffset))}
                        />
                    </div>
                </section>
            </div>
        </div>
    );
}
