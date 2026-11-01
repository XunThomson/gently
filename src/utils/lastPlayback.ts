import type {Track} from '../types';

/**
 * 「上次在放什么 / 放到哪」的持久化（R113）。
 *
 * 为什么要它：手机上系统把 WebView 的渲染进程回收之后，页面会整页重载——
 * 内存里的 store 全没了，用户切回来看到的是一个空播放条（R111 的形态 3 实测）。
 * 桌面端不常见，但「关掉应用再打开还想接着放」是同一件事。
 *
 * 边界（刻意克制）：
 * - 只存**一首歌 + 位置**，不存队列（队列可能上千条、来自随时会变的源）；
 * - 恢复出来的是**暂停态**，不会自动出声（自动播放策略也不允许）；
 * - 位置每 10 秒才写一次，避免每秒一次 `localStorage` 写。
 */

const STORAGE_KEY = 'gently:last-playback';

/** 位置最多存到这么长：超过就当作「听完了」，不要下次一开就从快到结尾处开始 */
const MAX_RESTORE_SECONDS = 60 * 60;

/** 写位置的节流间隔（毫秒） */
export const LAST_PLAYBACK_WRITE_MS = 10_000;

export interface LastPlaybackSnapshot {
    track: Track;
    /** 上次停下时的播放位置（秒） */
    position: number;
    /** 写入时刻（毫秒时间戳）：只用于展示/排查 */
    at: number;
}

function storage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

/** 只保留恢复所需的字段：整份 Track 里有些字段很重（歌词缓存、候选列表） */
function slimTrack(track: Track): Track {
    return {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        durationSec: track.durationSec,
        source: track.source,
        gradient: track.gradient,
        tags: track.tags ?? [],
        ...(track.albumId ? {albumId: track.albumId} : {}),
        ...(track.artwork ? {artwork: track.artwork} : {}),
    };
}

/**
 * 解析持久化内容（纯函数，冒烟直接钉）。
 *
 * 坏数据一律当「没有」：少一个字段就整条作废，宁可从空播放条开始，
 * 也不要把半个曲目塞进播放条（那会让界面显示一首点不动的歌）。
 */
export function parseLastPlayback(raw: string | null): LastPlaybackSnapshot | null {
    if (!raw) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object') return null;

    const snapshot = value as Partial<LastPlaybackSnapshot>;
    const track = snapshot.track as Partial<Track> | undefined;
    if (!track || typeof track.id !== 'string' || !track.id) return null;
    if (typeof track.title !== 'string' || typeof track.artist !== 'string') return null;
    if (typeof snapshot.position !== 'number' || !Number.isFinite(snapshot.position)) return null;

    const position = Math.min(MAX_RESTORE_SECONDS, Math.max(0, snapshot.position));
    const durationSec =
        typeof track.durationSec === 'number' && Number.isFinite(track.durationSec)
            ? track.durationSec
            : 0;
    /* 位置不能超过时长（除非时长未知）：否则一恢复就停在结尾 */
    const clamped = durationSec > 0 ? Math.min(position, Math.max(0, durationSec - 1)) : position;

    return {
        track: {
            ...(track as Track),
            album: typeof track.album === 'string' ? track.album : '',
            duration: typeof track.duration === 'string' ? track.duration : '',
            source: typeof track.source === 'string' ? track.source : '',
            durationSec,
            tags: Array.isArray(track.tags) ? track.tags : [],
        },
        position: clamped,
        at: typeof snapshot.at === 'number' ? snapshot.at : 0,
    };
}

export function readLastPlayback(): LastPlaybackSnapshot | null {
    return parseLastPlayback(storage()?.getItem(STORAGE_KEY) ?? null);
}

export function writeLastPlayback(snapshot: Omit<LastPlaybackSnapshot, 'at'>): void {
    const target = storage();
    if (!target) return;
    try {
        target.setItem(
            STORAGE_KEY,
            JSON.stringify({
                track: slimTrack(snapshot.track),
                position: Math.max(0, Math.round(snapshot.position * 10) / 10),
                at: Date.now(),
            }),
        );
    } catch {
        /* 隐私模式 / 配额：静默放弃，别打扰播放 */
    }
}

export function clearLastPlayback(): void {
    try {
        storage()?.removeItem(STORAGE_KEY);
    } catch {
        /* 同上 */
    }
}
