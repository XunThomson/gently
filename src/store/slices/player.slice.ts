import type {NowPlaying, Track} from '../../types';
import type {PlayerActions, PlayerState, StoreCtx} from '../types';

let playSeq = 0;

/** 播放条切片：当前曲目、队列、播放进度 */
export function createPlayerSlice(ctx: StoreCtx) {
    const state: PlayerState = {
        current: null,
        playing: false,
        queue: [],
        index: -1,
        repeat: 'off',
        volume: 0.8,
        elapsed: 0,
        duration: 0,
    };

    const patch = (partial: Partial<PlayerState>) => {
        ctx.setState({player: {...ctx.getState().player, ...partial}});
    };

    const start = (track: Track, index: number, queue: Track[]) => {
        const current: NowPlaying = {...track, playId: ++playSeq};
        patch({
            current,
            queue,
            index,
            playing: true,
            elapsed: 0,
            duration: track.durationSec,
        });
        ctx.getActions().library.recordPlay(track);
    };

    /** 按偏移量切换队列曲目，返回是否成功 */
    const moveTo = (offset: number): boolean => {
        const {queue, index, repeat} = ctx.getState().player;
        if (queue.length === 0) return false;

        let next = index + offset;
        if (next < 0) {
            if (repeat !== 'all') return false;
            next = queue.length - 1;
        }
        if (next >= queue.length) {
            if (repeat !== 'all') return false;
            next = 0;
        }

        start(queue[next], next, queue);
        return true;
    };

    const actions: PlayerActions = {
        play(track, queue) {
            const list = queue ?? ctx.getState().player.queue;
            const index = list.findIndex((t) => t.id === track.id);
            start(track, index, list);
        },

        toggle() {
            const {playing, current} = ctx.getState().player;
            if (!current) return;
            patch({playing: !playing});
        },

        next() {
            const {repeat, current, index, queue} = ctx.getState().player;
            if (!current) return;
            if (repeat === 'one') {
                start(current, index, queue);
                return;
            }
            if (!moveTo(1)) patch({playing: false, elapsed: 0});
        },

        prev() {
            const {elapsed, current} = ctx.getState().player;
            if (!current) return;
            // 播放超过 3 秒时先回到开头
            if (elapsed > 3) {
                patch({elapsed: 0});
                return;
            }
            if (!moveTo(-1)) patch({elapsed: 0});
        },

        setRepeat(repeat) {
            patch({repeat});
        },

        setVolume(volume) {
            patch({volume: Math.min(1, Math.max(0, volume))});
        },

        tick() {
            const {elapsed, duration, playing} = ctx.getState().player;
            if (!playing || duration <= 0) return;
            if (elapsed + 1 >= duration) {
                actions.next();
                return;
            }
            patch({elapsed: elapsed + 1});
        },

        seek(seconds) {
            const {duration} = ctx.getState().player;
            patch({elapsed: Math.min(Math.max(0, seconds), duration)});
        },

        stop() {
            patch({current: null, playing: false, elapsed: 0, duration: 0, index: -1});
        },
    };

    return {key: 'player' as const, state, actions};
}
