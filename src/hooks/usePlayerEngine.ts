import {useEffect} from 'react';
import {appConfig} from '../config/app.config';
import {coreAvailable} from '../services';
import {useActions, useSelect} from '../store';

/**
 * 回退播放时钟。
 *
 * **只在「没有本机核心」时用**（浏览器预览 `pnpm dev`：没有真实音频，用时钟把界面演起来）。
 * 有核心时一律由音频引擎的 `timeupdate` 回写进度——这是 R71 的教训：
 * 以前 `playing && !playable` 就启动回退时钟，而「解析不到音源」正好是那个状态，
 * 于是界面照常走进度、却一点声音都没有，看起来像「player 在播放、实际没播放」。
 * 现在有核心时，解析失败会直接把播放停掉并给出原因（`playbackError`）。
 */
const hasCore = (): boolean => coreAvailable();

export function usePlayerEngine(): void {
    const playing = useSelect((s) => s.player.playing);
    const playable = useSelect((s) => s.player.playable);
    const tick = useActions().player.tick;

    useEffect(() => {
        if (!playing || playable || hasCore()) return;
        const id = window.setInterval(tick, appConfig.player.fallbackTickMs);
        return () => window.clearInterval(id);
    }, [playing, playable, tick]);
}
