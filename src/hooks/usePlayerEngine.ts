import {useEffect} from 'react';
import {useActions, useSelect} from '../store';

/**
 * 播放引擎：把「时间推进」这一副作用从 UI 与 state 中隔离出来。
 * 应用内只需挂载一次（App 中调用）。
 */
export function usePlayerEngine(): void {
    const playing = useSelect((s) => s.player.playing);
    const tick = useActions().player.tick;

    useEffect(() => {
        if (!playing) return;
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [playing, tick]);
}
