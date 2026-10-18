import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {IconClose} from '../../components/ui/icon';
import {DESKTOP_LYRICS_EVENTS, isTauri, windowService} from '../../services';
import {useTheme} from '../../theme';
import {lyricLineProgress} from '../../utils/lyrics';
import type {DesktopLyricsPayload} from './types';
import {LyricsLineView, scaleStyle} from './LyricsLineView';
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


/**
 * 桌面歌词窗口。
 *
 * 这是一个**独立的 Tauri 窗口**（`desktop-lyrics`），不是主窗口里的一块浮层：
 * 置顶、无边框、可拖动、可缩放。播放状态由主窗口通过窗口间事件同步过来
 * （见 `useDesktopLyricsBridge`），因此它自己不需要重复一份播放器状态。
 *
 * 逐字展开（卡拉 OK 式高亮）**自己插值**，不让主窗口 30Hz 推事件：
 * 载荷里带 `elapsed / lineStart / lineEnd`，窗口内用 `requestAnimationFrame`
 * 按墙钟往前推；每分钟 60 次 IPC 换来平滑的字幕是不划算的，而 1s 心跳同步
 * 足够把插值误差压回几十毫秒。
 */
export function DesktopLyricsApp() {
    const {t} = useTranslation();
    const {mode, setMode} = useTheme();
    const [payload, setPayload] = useState<DesktopLyricsPayload | null>(null);
    const [scale, setScale] = useState(readScale);
    /** 当前行唱到的比例（0~1），只在开启逐字展开时用 */
    const [progress, setProgress] = useState(0);
    /** 收到载荷的本地时刻：用来按墙钟插值（不依赖主窗口再推） */
    const baseRef = useRef<{elapsed: number; at: number}>({elapsed: 0, at: 0});

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
                    if (disposed) return;
                    setPayload(event.payload);
                    baseRef.current = {elapsed: event.payload.elapsed, at: performance.now()};
                },
            );
        })();

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    /* 逐字展开：根据「收到载荷时的位置 + 墙钟流逝」算进度 */
    useEffect(() => {
        if (!payload?.sweep) {
            setProgress(0);
            return;
        }
        let frame = 0;
        let last = -1;
        const tick = () => {
            const {elapsed, at} = baseRef.current;
            const now = payload.playing ? elapsed + (performance.now() - at) / 1000 : elapsed;
            const next = lyricLineProgress(payload.lineStart, payload.lineEnd, now);
            // 只在变化超过 0.5% 时 setState：60fps 重渲染没必要，肉眼看不出差别
            if (Math.abs(next - last) >= 0.005) {
                last = next;
                setProgress(next);
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [payload?.sweep, payload?.playing, payload?.lineStart, payload?.lineEnd, payload?.elapsed]);

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
    const sweep = payload?.sweep ?? false;

    return (
        <div
            className={styles.window}
            data-bg={payload?.background ?? 'solid'}
            data-tauri-drag-region="deep"
        >
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
                        <LyricsLineView
                            line={line}
                            translation={payload?.translation}
                            progress={progress}
                            sweep={sweep}
                            scale={scale}
                        />
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
