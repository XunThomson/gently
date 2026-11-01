import type {PetContext, PetPlaybackSnapshot} from '../../pet';
import {EMPTY_PET_PAYLOAD, payloadToSnapshot, type PetWindowPayload} from './types';

/**
 * 宠物窗口里的**只读播放快照**（模块级单例）。
 *
 * 为什么不放 React state：`core-pet` 的渲染器每 50ms 轮询一次快照，
 * 而窗口每收到一次主窗口推送就要更新它——中间隔着一层 React 只会多一轮渲染。
 * 这里就是一个「最新值 + 订阅者」，React 只负责把推送**写进来**。
 */
let snapshot: PetPlaybackSnapshot = payloadToSnapshot(EMPTY_PET_PAYLOAD);
const listeners = new Set<(value: PetPlaybackSnapshot) => void>();

/** 给渲染器用的上下文（形状与主窗口里的 `createPetContext()` 一致） */
export const petWindowContext: PetContext = {
    getPlayback: () => snapshot,
    subscribePlayback(listener) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

/** 写入一份新载荷；只有「宠物真正会读的字段」变化时才通知订阅者 */
export function publishPetWindowPayload(payload: PetWindowPayload): void {
    const next = payloadToSnapshot(payload);
    const changed =
        next.playing !== snapshot.playing ||
        next.track?.id !== snapshot.track?.id ||
        (next.lyric !== null) !== (snapshot.lyric !== null) ||
        next.theme !== snapshot.theme;
    snapshot = next;
    if (!changed) return;
    for (const listener of listeners) listener(next);
}
