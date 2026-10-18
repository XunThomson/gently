import {useEffect, useRef} from 'react';
import {activeLyricIndex} from '../utils/lyrics';
import {DESKTOP_LYRICS_EVENTS, isTauri} from '../services';
import {useActions, usePlayerState, useSelect} from '../store';
import type {PlayerState} from '../store/types';
import type {ThemeMode} from '../theme';
import type {DesktopLyricsPayload} from '../widgets/desktop-lyrics/types';
import {
    DEFAULT_LYRICS_WINDOW_SETTINGS,
    readLyricsWindowSettings,
    subscribeLyricsWindowSettings,
    type LyricsWindowSettings,
} from '../utils/lyricsWindowSettings';

let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null;
const events = () => (eventApi ??= import('@tauri-apps/api/event'));

/** 没有「下一行」时，当前行按 4 秒唱完算（逐字展开的兜底长度） */
const LAST_LINE_SECONDS = 4;

/** 由播放器状态算出桌面歌词窗口要显示的内容（纯函数，便于推理与测试） */
export function desktopLyricsPayload(
    player: PlayerState,
    themeMode: ThemeMode = 'light',
    settings: LyricsWindowSettings = DEFAULT_LYRICS_WINDOW_SETTINGS,
): DesktopLyricsPayload {
    const elapsed = player.elapsed + player.lyricsOffset;
    const active = activeLyricIndex(player.lyrics, elapsed);
    const line = active >= 0 ? player.lyrics[active] : undefined;
    const next = player.lyrics[active + 1];
    const lineStart = line?.time ?? 0;
    const lineEnd = next?.time ?? lineStart + LAST_LINE_SECONDS;

    return {
        title: player.current?.title ?? '',
        artist: player.current?.artist ?? '',
        line: line?.text ?? '',
        ...(line?.translation ? {translation: line.translation} : {}),
        next: next?.text ?? '',
        playing: player.playing,
        empty: player.lyrics.length === 0,
        source: player.lyricsSource?.sourceName ?? '',
        themeMode,
        elapsed,
        lineStart,
        lineEnd,
        background: settings.background,
        sweep: settings.sweep,
    };
}

/**
 * 主窗口 → 桌面歌词窗口的桥。
 *
 * 为什么是事件而不是共享 store：两个窗口是**独立的 WebView 上下文**（各自一份 JS 堆），
 * store 不共享；事件是最小、单向、无需新契约的同步方式。数据只在「行变化 / 播放态变化」
 * 时立即推送，另有 1s 心跳兜底（暂停后依然能刷新、窗口重开也能拿到当前状态）。
 */
export function useDesktopLyricsBridge(): void {
    const player = usePlayerState();
    const {setDesktopLyricsOpen} = useActions().ui;
    const themeMode = useSelect((state) => state.ui.themeMode);

    const settings = readLyricsWindowSettings();
    const payloadRef = useRef<DesktopLyricsPayload>(desktopLyricsPayload(player, themeMode, settings));
    payloadRef.current = desktopLyricsPayload(player, themeMode, settings);

    const currentId = player.current?.id ?? '';
    const active = activeLyricIndex(player.lyrics, player.elapsed + player.lyricsOffset);
    const source = player.lyricsSource?.sourceName ?? '';

    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;

        const push = () => {
            void events().then(({emit}) => {
                if (!disposed) void emit(DESKTOP_LYRICS_EVENTS.update, payloadRef.current);
            });
        };

        push();
        const timer = window.setInterval(push, 1000);

        let unlisten: (() => void) | undefined;
        void events().then(async ({listen}) => {
            unlisten = await listen(DESKTOP_LYRICS_EVENTS.closed, () => {
                setDesktopLyricsOpen(false);
            });
        });

        /* 显示设置（背景 / 逐字展开）在设置页改完要**立刻**生效，不等 1s 心跳：
           同步更新进载荷，再推一次 */
        const unsubscribe = subscribeLyricsWindowSettings((next) => {
            payloadRef.current = {...payloadRef.current, background: next.background, sweep: next.sweep};
            push();
        });

        return () => {
            disposed = true;
            window.clearInterval(timer);
            unsubscribe();
            unlisten?.();
        };
    }, [setDesktopLyricsOpen]);

    /* 行 / 曲目 / 播放态变化时立即推一次，不等到下一次心跳。
       偏移也算：暂停时调偏移，`active` 可能不变，但桌上那行必须马上跟着挪（否则要等 1s 心跳，
       用户会以为「校正没生效」）。 */
    useEffect(() => {
        if (!isTauri()) return;
        void events().then(({emit}) => {
            void emit(DESKTOP_LYRICS_EVENTS.update, payloadRef.current);
        });
    }, [
        currentId,
        active,
        player.playing,
        player.lyrics.length,
        player.lyricsOffset,
        source,
        themeMode,
    ]);
}
