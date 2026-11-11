import {useEffect, useRef} from 'react';
import {useActions, useSelect} from '../store';

/**
 * 定时关闭引擎：挂载在 App 层，按 store 里的计时状态驱动播放暂停。
 *
 * 两种模式：
 * - `duration`：到点暂停（`sleepTimerUntil` 是目标时间戳）
 * - `endOfTrack`：当前歌曲播完时暂停（不计算固定时间，跟着 player.tick 走）
 *
 * 为什么用 hook 而不是 setInterval：
 * - `duration` 模式只需要一个 setTimeout，到点触发一次即可
 * - `endOfTrack` 模式依赖 player 的 elapsed/duration 变化，用 useEffect 订阅更准确
 */
export function useSleepTimer(): void {
    const sleepTimerUntil = useSelect((s) => s.ui.sleepTimerUntil);
    const sleepTimerMode = useSelect((s) => s.ui.sleepTimerMode);
    const playing = useSelect((s) => s.player.playing);
    const elapsed = useSelect((s) => s.player.elapsed);
    const duration = useSelect((s) => s.player.duration);
    const currentId = useSelect((s) => s.player.current?.id ?? null);
    const {toggle} = useActions().player;
    const {cancelSleepTimer} = useActions().ui;

    const toggleRef = useRef(toggle);
    toggleRef.current = toggle;
    const cancelRef = useRef(cancelSleepTimer);
    cancelRef.current = cancelSleepTimer;

    /* 固定时长模式：到点暂停 */
    useEffect(() => {
        if (sleepTimerMode !== 'duration' || !sleepTimerUntil) return;

        const remaining = sleepTimerUntil - Date.now();
        if (remaining <= 0) {
            if (playing) toggleRef.current();
            cancelRef.current();
            return;
        }

        const timeoutId = setTimeout(() => {
            if (playing) toggleRef.current();
            cancelRef.current();
        }, remaining);

        return () => clearTimeout(timeoutId);
    }, [sleepTimerMode, sleepTimerUntil, playing]);

    /* 播完当前歌曲模式：监测进度到尾部时暂停 */
    useEffect(() => {
        if (sleepTimerMode !== 'endOfTrack') return;
        if (!currentId || duration <= 0) return;

        /* 剩余 1 秒以内视为「播完了」：player.tick 的推进精度是 1 秒，
           在最后 1 秒内触发可以避免「差一点没停」的观感问题 */
        if (playing && elapsed >= duration - 1) {
            toggleRef.current();
            cancelRef.current();
        }
    }, [sleepTimerMode, currentId, duration, elapsed, playing]);

    /* 切歌时取消「播完当前」模式：用户设的定时器针对的是上一首，换歌 = 意图变了 */
    const prevTrackId = useRef(currentId);
    useEffect(() => {
        if (prevTrackId.current !== currentId) {
            prevTrackId.current = currentId;
            if (sleepTimerMode === 'endOfTrack' && currentId !== null) {
                cancelRef.current();
            }
        }
    }, [currentId, sleepTimerMode]);
}

/**
 * 计算定时关闭的剩余时间（供 UI 显示）。
 *
 * 返回 null 表示没有活跃的定时器；否则返回剩余秒数。
 * 组件用这个 hook 每秒刷新显示（配合 player.tick 的节奏）。
 */
export function useSleepTimerRemaining(): number | null {
    const sleepTimerUntil = useSelect((s) => s.ui.sleepTimerUntil);
    const sleepTimerMode = useSelect((s) => s.ui.sleepTimerMode);
    const elapsed = useSelect((s) => s.player.elapsed);
    const duration = useSelect((s) => s.player.duration);

    if (sleepTimerMode === 'duration' && sleepTimerUntil) {
        const remaining = Math.max(0, Math.ceil((sleepTimerUntil - Date.now()) / 1000));
        return remaining;
    }

    if (sleepTimerMode === 'endOfTrack' && duration > 0) {
        return Math.max(0, Math.ceil(duration - elapsed));
    }

    return null;
}
