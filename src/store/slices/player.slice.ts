import {audioEngine, catalogService, libraryService} from '../../services';
import type {NowPlaying, Track} from '../../types';
import type {PlayerActions, PlayerState, StoreCtx} from '../types';

let playSeq = 0;

/** 播放条切片：当前曲目、队列、播放进度、歌词、音源 */
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
        lyrics: [],
        audioUrl: null,
        playable: false,
    };

    const patch = (partial: Partial<PlayerState>) => {
        ctx.setState({player: {...ctx.getState().player, ...partial}});
    };

    /** 异步加载歌词；切歌后丢弃过期结果 */
    const loadLyrics = async (track: Track, playId: number) => {
        try {
            const lyrics = await libraryService.loadLyrics(track);
            if (ctx.getState().player.current?.playId === playId) patch({lyrics});
        } catch (err) {
            console.warn('[player] 歌词加载失败', err);
            if (ctx.getState().player.current?.playId === playId) patch({lyrics: []});
        }
    };

    /** 向数据源解析播放地址；失败或无地址时退回模拟时钟 */
    const resolveSource = async (track: Track, playId: number) => {
        try {
            const url = await catalogService.resolveUrl(track);
            if (ctx.getState().player.current?.playId !== playId) return;
            patch({audioUrl: url, playable: Boolean(url)});
        } catch (err) {
            console.warn('[player] 音源解析失败', err);
            if (ctx.getState().player.current?.playId === playId) {
                patch({audioUrl: null, playable: false});
            }
        }
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
            lyrics: [],
            audioUrl: null,
            playable: false,
        });
        void loadLyrics(track, current.playId);
        void resolveSource(track, current.playId);
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

        /** 列表点击：当前曲目 → 播放/暂停；其他曲目 → 切歌 */
        playOrToggle(track, queue) {
            const {current, playing} = ctx.getState().player;
            if (current && current.id === track.id) {
                patch({playing: !playing});
                return;
            }
            actions.play(track, queue);
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
                actions.seek(0);
                return;
            }
            if (!moveTo(-1)) actions.seek(0);
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

        setProgress(elapsed, duration) {
            const patchDuration = duration > 0 && Math.abs(duration - ctx.getState().player.duration) > 0.5;
            patch(patchDuration ? {elapsed, duration} : {elapsed});
        },

        markUnplayable() {
            patch({audioUrl: null, playable: false});
        },

        seek(seconds) {
            const {duration} = ctx.getState().player;
            const next = Math.min(Math.max(0, seconds), duration || Number.MAX_SAFE_INTEGER);
            patch({elapsed: next});
            // 命令同时下发给音频引擎，保持 UI 与声音一致
            audioEngine.seek(next);
        },

        stop() {
            patch({
                current: null,
                playing: false,
                elapsed: 0,
                duration: 0,
                index: -1,
                lyrics: [],
                audioUrl: null,
                playable: false,
            });
        },
    };

    return {key: 'player' as const, state, actions};
}
