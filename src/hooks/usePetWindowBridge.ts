import {useEffect, useRef} from 'react';
import {activeLyricIndex} from '../utils/lyrics';
import {PET_WINDOW_EVENTS, isTauri} from '../services';
import {windowService} from '../services/window.service';
import {store, useActions, usePlayerState, useSelect} from '../store';
import type {PetWindowPayload} from '../widgets/pet-window/types';

let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null;
const events = () => (eventApi ??= import('@tauri-apps/api/event'));

/**
 * 主窗口 → 宠物窗口的桥，以及「开关 ↔ 窗口可见性」的对齐。
 *
 * 为什么需要桥：宠物已经不在主窗口里了（独立 `pet` 窗口），那个 WebView 没有 store，
 * 拿不到「在播什么、有没有歌词、是不是换歌了」。这些正是 `pet.tick` 的输入，
 * 所以主窗口把它们压成一份**只读快照**推过去（与桌面歌词同一条路子：
 * 事件是最小、单向、不需要新契约的同步方式）。
 *
 * 为什么只推这几位：宠物只消费 `playing / lyricActive / trackId`——
 * 每秒推一次完整快照没有意义，进度（`elapsed`）只是带上，供将来用。
 */
export function usePetWindowBridge(enabled: boolean, revision: number): void {
    const player = usePlayerState();
    const scheme = useSelect((state) => state.ui.scheme);
    const uiActions = useActions().ui;

    const currentId = player.current?.id ?? '';
    const playing = player.playing;
    const lyricActive =
        activeLyricIndex(player.lyrics, player.elapsed + player.lyricsOffset) >= 0;

    const payloadRef = useRef<PetWindowPayload>({
        active: enabled,
        playing,
        elapsed: 0,
        lyricActive,
        trackId: currentId,
        revision,
        theme: scheme,
    });
    payloadRef.current = {
        active: enabled,
        playing,
        elapsed: player.elapsed,
        lyricActive,
        trackId: currentId,
        revision,
        theme: scheme,
    };

    /* 开关 ↔ 窗口：打开就显示（幂等），关掉就隐藏。窗口自己关掉时主窗口把开关关掉。 */
    useEffect(() => {
        if (!isTauri()) return;
        void (async () => {
            if (enabled) await windowService.showPetWindow();
            else await windowService.hidePetWindow();
        })();
    }, [enabled]);

    /* 宠物被安装 / 切换 / 卸载：推一次，宠物窗口据此重挂渲染器 */
    useEffect(() => {
        if (!isTauri()) return;
        void events().then(({emit}) => {
            void emit(PET_WINDOW_EVENTS.update, payloadRef.current);
        });
    }, [revision]);

    /* 开关 / 播放态 / 曲目 / 歌词行 变化时立即推，不等心跳 */
    useEffect(() => {
        if (!isTauri()) return;
        void events().then(({emit}) => {
            void emit(PET_WINDOW_EVENTS.update, payloadRef.current);
        });
    }, [enabled, playing, currentId, lyricActive, scheme]);

    /* 心跳 + 握手：**事件不排队**——宠物窗口比主窗口晚起来，第一次推送会丢
       （丢了就永远 active=false，窗口是透明的，看起来像「宠物没出现」）。
       所以：宠物窗口起来时发一次 `ready`，主窗口立刻补发；另外 2s 心跳兜底。 */
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        const push = () => {
            void events().then(({emit}) => {
                if (!disposed) void emit(PET_WINDOW_EVENTS.update, payloadRef.current);
            });
        };
        const timer = window.setInterval(push, 2000);
        let unlisten: (() => void) | undefined;
        void events().then(async ({listen}) => {
            unlisten = await listen(PET_WINDOW_EVENTS.ready, push);
        });
        return () => {
            disposed = true;
            window.clearInterval(timer);
            unlisten?.();
        };
    }, []);

    /* 宠物窗口自己关掉（比如用户把它关了）→ 把开关也关掉，避免界面与真实状态不一致 */
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void events().then(async ({listen}) => {
            unlisten = await listen(PET_WINDOW_EVENTS.closed, () => {
                if (disposed) return;
                if (store.getState().ui.petEnabled) uiActions.setPetEnabled(false);
            });
        });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);
}

