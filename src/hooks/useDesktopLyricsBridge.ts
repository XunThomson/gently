import {useEffect, useRef} from 'react';
import {activeLyricIndex} from '../utils/lyrics';
import {DESKTOP_LYRICS_EVENTS, isTauri} from '../services';
import {useActions, usePlayerState, useSelect} from '../store';
import type {PlayerState} from '../store/types';
import type {ThemeMode} from '../theme';
import type {DesktopLyricsPayload} from '../widgets/desktop-lyrics/types';

let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null;
const events = () => (eventApi ??= import('@tauri-apps/api/event'));

/** 由播放器状态算出桌面歌词窗口要显示的内容（纯函数，便于推理与测试） */
export function desktopLyricsPayload(
    player: PlayerState,
    themeMode: ThemeMode = 'light',
): DesktopLyricsPayload {
    const active = activeLyricIndex(player.lyrics, player.elapsed + player.lyricsOffset);
    const line = active >= 0 ? player.lyrics[active] : undefined;
    const next = player.lyrics[active + 1];

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

    const payloadRef = useRef<DesktopLyricsPayload>(desktopLyricsPayload(player, themeMode));
    payloadRef.current = desktopLyricsPayload(player, themeMode);

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

        return () => {
            disposed = true;
            window.clearInterval(timer);
            unlisten?.();
        };
    }, [setDesktopLyricsOpen]);

    /* 行 / 曲目 / 播放态变化时立即推一次，不等到下一次心跳 */
    useEffect(() => {
        if (!isTauri()) return;
        void events().then(({emit}) => {
            void emit(DESKTOP_LYRICS_EVENTS.update, payloadRef.current);
        });
    }, [currentId, active, player.playing, player.lyrics.length, source, themeMode]);
}
