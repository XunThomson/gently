import {useEffect} from 'react';
import {useActions, useSelect} from '../store';

/**
 * 回退播放时钟：只有在「没有真实音源」时才用它推进进度，
 * 有音源时进度由音频引擎的 timeupdate 回写。
 * 应用内只需挂载一次（App 中调用）。
 */
export function usePlayerEngine(): void {
    const playing = useSelect((s) => s.player.playing);
    const playable = useSelect((s) => s.player.playable);
    const tick = useActions().player.tick;

    useEffect(() => {
        if (!playing || playable) return;
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [playing, playable, tick]);
}
