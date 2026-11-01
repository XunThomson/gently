import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {DownloadMark} from '../../../components/ui/download-mark';
import {IconMusic, IconPause, IconPlay} from '../../../components/ui/icon';
import {catalogService} from '../../../services';
import {useActions, useSelect} from '../../../store';
import type {Track} from '../../../types';
import {canPreview, mediaKindOf, previewWindow} from '../../../utils/discoverMedia';
import {pickQuality} from '../../../utils/quality';
import styles from './DiscoverPanel.module.css';

/**
 * 「发现」子视图（R87）。
 *
 * 布局刻意做成「书架 + 详情 + 列表」三段：
 * - **左上是书架**：每首歌是一张**竖着插在架上**的包装盒（只能看到侧边书名），
 *   包装按 id 稳定映射到黑胶 / 磁带 / 光盘三种媒介，侧脊用曲目自己的配色；
 * - **左下是正在聚焦的那张包装**：翻出来正面展示，并按媒介播放对应动效
 *   （黑胶转、磁带卷盘转、光盘反光），这是「同一种东西」的视觉表达，不做成装饰贴图；
 * - **右侧是列表**：键盘/鼠标都能快速扫，点一下 = 聚焦该曲目（触发试听）。
 *
 * 试听：聚焦时从**高潮处**（估计值，见 `utils/discoverMedia`）放 20 秒，
 * 音量压低、独立于主播放器（不劫持用户正在听的歌）。没有时长数据就不试听。
 * 默认开启，可在设置页关掉（`ui.discoverAutoPreview`）。
 */
export interface DiscoverPanelProps {
    tracks: Track[];
}

export function DiscoverPanel({tracks}: DiscoverPanelProps) {
    const {t} = useTranslation();
    const autoPreview = useSelect((s) => s.ui.discoverAutoPreview);
    const {playOrToggle} = useActions().player;
    const currentId = useSelect((s) => s.player.current?.id ?? null);
    const playing = useSelect((s) => s.player.playing);

    const [focusedId, setFocusedId] = useState<string | null>(null);
    const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing' | 'unavailable'>('idle');
    /**
     * 试听只由**用户动作**触发。
     *
     * 进页面时会把第一张包装设为聚焦（否则左侧是一块空面板，看不到任何东西），
     * 但那**不该自动出声**——打开页面就放声会被当成 bug，浏览器/WebView 的自动播放策略
     * 也常常直接拒绝。用户点过/划过之后才允许试听。
     */
    const [previewArmed, setPreviewArmed] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    /** 去重（推荐与源侧推荐可能给出同一首）+ 最多 24 张：书架再多就成了堆放 */
    const shelf = useMemo(() => {
        const seen = new Set<string>();
        const out: Track[] = [];
        for (const track of tracks) {
            if (seen.has(track.id)) continue;
            seen.add(track.id);
            out.push(track);
            if (out.length >= 24) break;
        }
        return out;
    }, [tracks]);

    const focused = useMemo(
        () => shelf.find((track) => track.id === focusedId) ?? null,
        [shelf, focusedId],
    );

    /* 内容变化（换源推荐 / 重进页面）后，聚焦项若已不在架上就清掉 */
    useEffect(() => {
        if (focusedId && !shelf.some((track) => track.id === focusedId)) setFocusedId(null);
    }, [focusedId, shelf]);

    /* 首次拿到数据时自动聚焦第一张：左侧的详情区不该是空的（但不因此自动出声） */
    useEffect(() => {
        if (focusedId === null && shelf.length > 0) setFocusedId(shelf[0].id);
    }, [focusedId, shelf]);

    /** 用户动作选中：既聚焦，也把「允许试听」打开 */
    const focusFromUser = (trackId: string) => {
        setPreviewArmed(true);
        setFocusedId(trackId);
    };

    const stopPreview = useCallback(() => {
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        }
        setPreviewState('idle');
    }, []);

    /**
     * 聚焦 → 试听该曲目的高潮片段。
     *
     * 顺序：先解析可播地址（核心回环代理），再 `seek` 到估计的高潮位置播放。
     * 解析失败 / 没有时长：**不播放**（用户的原话是「没有获取相关数据则不播放」），
     * 界面显示「暂无试听」而不是静默。
     */
    useEffect(() => {
        if (!focused || !autoPreview || !previewArmed) {
            stopPreview();
            return;
        }
        const window_ = previewWindow(focused.durationSec);
        if (!window_) {
            setPreviewState('unavailable');
            return;
        }

        let cancelled = false;
        setPreviewState('loading');

        void (async () => {
            const quality = pickQuality(catalogService.sourceQualities(focused.source), 'standard') ?? 'standard';
            const resolved = await catalogService.resolveUrl(focused, quality, focused.source);
            if (cancelled) return;
            if (!resolved) {
                setPreviewState('unavailable');
                return;
            }

            const audio = (audioRef.current ??= new Audio());
            audio.src = resolved.url;
            audio.volume = 0.45;
            audio.currentTime = window_.start;
            try {
                await audio.play();
                if (!cancelled) setPreviewState('playing');
            } catch {
                if (!cancelled) setPreviewState('unavailable');
            }

            /* 放到片段末尾就停（片段只有 20 秒，不必等整首） */
            const stopAt = () => {
                if (audioRef.current) audioRef.current.pause();
                setPreviewState('idle');
            };
            audio.ontimeupdate = () => {
                if (audio.currentTime >= window_.end) {
                    audio.ontimeupdate = null;
                    stopAt();
                }
            };
        })();

        return () => {
            cancelled = true;
            stopPreview();
        };
    }, [focused, autoPreview, previewArmed, stopPreview]);

    /* 组件卸载：别把声音留在后台 */
    useEffect(() => stopPreview, [stopPreview]);

    if (shelf.length === 0) {
        return (
            <p className={styles.empty}>
                <IconMusic size={28}/>
                <span>{t('page.hot.discoverEmpty')}</span>
            </p>
        );
    }

    const medium = focused ? mediaKindOf(focused.id) : 'vinyl';

    return (
        <div className={styles.root}>
            <div className={styles.stage}>
                {/* 正在聚焦的那张包装：正面 + 媒介动效 */}
                <div className={styles.detail} data-medium={medium} data-preview={previewState}>
                    <div className={styles.package}>
                        <div
                            className={styles.cover}
                            style={{background: focused?.gradient ?? 'var(--bg-surface-alt)'}}
                        >
                            {focused?.artwork ? (
                                <img className={styles.coverImage} src={focused.artwork} alt="" loading="lazy" referrerPolicy="no-referrer"/>
                            ) : (
                                <span className={styles.coverGlyph}>{focused?.title.slice(0, 1) ?? '♪'}</span>
                            )}
                        </div>

                        {/* 媒介动效：黑胶转盘 / 磁带卷盘 / 光盘 */}
                        <div className={styles.medium} aria-hidden="true">
                            <div className={styles.disc}>
                                <i className={styles.discLabel}/>
                            </div>
                            <div className={styles.reels}>
                                <i/>
                                <i/>
                            </div>
                        </div>
                    </div>

                    <div className={styles.meta}>
                        {focused ? (
                            <>
                                <span className={styles.title}>
                                    {focused.title}
                                    <DownloadMark track={focused}/>
                                </span>
                                <span className={styles.artist}>
                                    {focused.artist}
                                    {focused.album ? ` · ${focused.album}` : ''}
                                </span>
                                <span className={styles.previewHint} data-state={previewState}>
                                    {previewState === 'unavailable'
                                        ? t('page.hot.discoverPreviewUnavailable')
                                        : previewState === 'playing'
                                          ? t('page.hot.discoverPreviewPlaying')
                                          : previewState === 'loading'
                                            ? t('common.loading')
                                            : autoPreview
                                              ? t('page.hot.discoverPreviewIdle')
                                              : t('page.hot.discoverPreviewOff')}
                                </span>
                                <div className={styles.actions}>
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        icon={
                                            currentId === focused.id && playing ? (
                                                <IconPause size={13}/>
                                            ) : (
                                                <IconPlay size={13}/>
                                            )
                                        }
                                        onClick={() => playOrToggle(focused, shelf)}
                                    >
                                        {currentId === focused.id && playing
                                            ? t('common.pause')
                                            : t('common.play')}
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={stopPreview}>
                                        {t('page.hot.discoverStopPreview')}
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <span className={styles.artist}>{t('page.hot.discoverPickHint')}</span>
                        )}
                    </div>
                </div>

                {/* 书架：包装竖着插在架上，只能看到侧脊 */}
                <div className={styles.shelf} role="listbox" aria-label={t('page.hot.discoverShelf')}>
                    {shelf.map((track) => {
                        const active = track.id === focusedId;
                        const trackMedium = mediaKindOf(track.id);
                        return (
                            <button
                                key={track.id}
                                type="button"
                                role="option"
                                aria-selected={active}
                                data-medium={trackMedium}
                                title={`${track.title} · ${track.artist}`}
                                className={`${styles.spine}${active ? ` ${styles.spineActive}` : ''}`}
                                style={{background: track.gradient}}
                                onClick={() => focusFromUser(track.id)}
                                onMouseEnter={() => focusFromUser(track.id)}
                                onFocus={() => focusFromUser(track.id)}
                            >
                                <span className={styles.spineText}>{track.title}</span>
                                <span className={styles.spineArtist}>{track.artist}</span>
                            </button>
                        );
                    })}
                    <div className={styles.shelfBase} aria-hidden="true"/>
                </div>
            </div>

            {/* 右侧列表：扫得快，点一下 = 聚焦（并试听） */}
            <ul className={styles.list}>
                {shelf.map((track) => {
                    const active = track.id === focusedId;
                    return (
                        <li key={track.id}>
                            <button
                                type="button"
                                className={`${styles.row}${active ? ` ${styles.rowActive}` : ''}`}
                                onClick={() => focusFromUser(track.id)}
                            >
                                <span className={styles.rowIndex} data-medium={mediaKindOf(track.id)}>
                                    {currentId === track.id && playing ? '♪' : '·'}
                                </span>
                                <span className={styles.rowTitle}>{track.title}</span>
                                <span className={styles.rowArtist}>{track.artist}</span>
                                <span className={styles.rowDuration}>
                                    {canPreview(track) ? track.duration : '—'}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export default DiscoverPanel;
