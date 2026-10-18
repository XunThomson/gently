import {useEffect, useState, type CSSProperties} from 'react';
import {useTranslation} from 'react-i18next';
import {IconClose} from '../../components/ui/icon';
import {DESKTOP_LYRICS_EVENTS, isTauri, windowService} from '../../services';
import {useTheme} from '../../theme';
import type {DesktopLyricsPayload} from './types';
import styles from './desktop-lyrics.module.css';

const SCALE_KEY = 'gently:lyrics-window-scale';
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.8;
const SCALE_STEP = 0.1;

function readScale(): number {
    if (typeof window === 'undefined') return 1;
    const raw = Number(window.localStorage.getItem(SCALE_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
}

/** 字号缩放仍以主题 token 为基准（不把像素值写进组件） */
function scaleStyle(token: string, scale: number): CSSProperties {
    return {fontSize: `calc(var(${token}) * ${scale})`};
}

/**
 * 桌面歌词窗口。
 *
 * 这是一个**独立的 Tauri 窗口**（`desktop-lyrics`），不是主窗口里的一块浮层：
 * 置顶、无边框、可拖动、可缩放。播放状态由主窗口通过窗口间事件同步过来
 * （见 `useDesktopLyricsBridge`），因此它自己不需要重复一份播放器状态。
 */
export function DesktopLyricsApp() {
    const {t} = useTranslation();
    const {mode, setMode} = useTheme();
    const [payload, setPayload] = useState<DesktopLyricsPayload | null>(null);
    const [scale, setScale] = useState(readScale);

    /* 独立 WebView 不会自动跟随主窗口的主题：跟着同步过来的 mode 切换 */
    useEffect(() => {
        if (payload?.themeMode && payload.themeMode !== mode) setMode(payload.themeMode);
    }, [payload?.themeMode, mode, setMode]);

    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;

        void (async () => {
            const {listen} = await import('@tauri-apps/api/event');
            unlisten = await listen<DesktopLyricsPayload>(
                DESKTOP_LYRICS_EVENTS.update,
                (event) => {
                    if (!disposed) setPayload(event.payload);
                },
            );
        })();

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const adjustScale = (delta: number) => {
        setScale((current) => {
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + delta) * 10) / 10));
            if (typeof window !== 'undefined') {
                window.localStorage.setItem(SCALE_KEY, String(next));
            }
            return next;
        });
    };

    const close = async () => {
        await windowService.hideDesktopLyrics();
        if (!isTauri()) return;
        const {emit} = await import('@tauri-apps/api/event');
        await emit(DESKTOP_LYRICS_EVENTS.closed);
    };

    const empty = !payload || payload.empty;
    const line = payload?.line ?? '';
    const nextLine = payload?.next ?? '';

    return (
        <div className={styles.window} data-tauri-drag-region="deep">
            <div className={styles.controls}>
                <button
                    type="button"
                    className={styles.control}
                    title={t('desktopLyrics.fontSmaller')}
                    aria-label={t('desktopLyrics.fontSmaller')}
                    onClick={() => adjustScale(-SCALE_STEP)}
                >
                    A−
                </button>
                <button
                    type="button"
                    className={styles.control}
                    title={t('desktopLyrics.fontLarger')}
                    aria-label={t('desktopLyrics.fontLarger')}
                    onClick={() => adjustScale(SCALE_STEP)}
                >
                    A+
                </button>
                <button
                    type="button"
                    className={styles.control}
                    title={t('desktopLyrics.close')}
                    aria-label={t('desktopLyrics.close')}
                    onClick={() => void close()}
                >
                    <IconClose size={14}/>
                </button>
            </div>

            <div className={styles.body}>
                {!payload || (!payload.playing && !payload.title) ? (
                    <p className={styles.hint} style={scaleStyle('--font-size-base', scale)}>
                        {t('desktopLyrics.notPlaying')}
                    </p>
                ) : empty ? (
                    <p className={styles.hint} style={scaleStyle('--font-size-base', scale)}>
                        {t('desktopLyrics.noLyrics')}
                    </p>
                ) : (
                    <>
                        <p className={styles.line} style={scaleStyle('--font-size-3xl', scale)}>
                            {line}
                            {payload?.translation && (
                                <span
                                    className={styles.translation}
                                    style={scaleStyle('--font-size-base', scale)}
                                >
                                    {payload.translation}
                                </span>
                            )}
                        </p>
                        {nextLine && (
                            <p className={styles.next} style={scaleStyle('--font-size-sm', scale)}>
                                {nextLine}
                            </p>
                        )}
                    </>
                )}
            </div>

            <div className={styles.meta}>
                {payload?.title ? (
                    <span className={styles.track}>
                        {payload.title}
                        {payload.artist ? ` · ${payload.artist}` : ''}
                    </span>
                ) : (
                    <span/>
                )}
                {payload?.source && (
                    <span className={styles.source}>
                        {t('desktopLyrics.source', {source: payload.source})}
                    </span>
                )}
            </div>
        </div>
    );
}

export default DesktopLyricsApp;
