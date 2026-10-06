import {appConfig} from '../../config/app.config';
import {audioEngine, catalogService, libraryService} from '../../services';
import type {GroupedTrack, NowPlaying, Track, TrackCandidate} from '../../types';
import type {PlayerActions, PlayerState, StoreCtx} from '../types';

let playSeq = 0;

/** 音源候选：聚合结果自带 candidates，普通曲目退化为单候选 */
function candidatesOf(track: Track): TrackCandidate[] {
    const grouped = track as Partial<GroupedTrack>;
    if (Array.isArray(grouped.candidates) && grouped.candidates.length > 0) {
        return grouped.candidates;
    }
    return [
        {
            source: track.source,
            track,
            qualities: [...catalogService.sourceQualities(track.source)],
        },
    ];
}

/** 播放条切片：当前曲目、队列、进度、歌词、音源与音质 */
export function createPlayerSlice(ctx: StoreCtx) {
    const state: PlayerState = {
        current: null,
        playing: false,
        queue: [],
        index: -1,
        repeat: 'off',
        volume: appConfig.player.defaultVolume,
        elapsed: 0,
        duration: 0,
        lyrics: [],
        audioUrl: null,
        playable: false,
        candidates: [],
        activeSource: null,
        quality: null,
        failedSources: [],
        resolving: false,
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

    /**
     * 按候选顺序解析音源：首个能播的就用它，失败的记为不可用并继续下一个。
     * 这样「某个音源的某首歌播不了」不会卡住播放，用户仍能听到其它源的同一首歌。
     */
    const resolveWithFallback = async (
        candidates: TrackCandidate[],
        playId: number,
        keepElapsed = false,
    ) => {
        const {preferredQuality, preferredSource} = ctx.getState().ui;
        const ordered = preferredSource
            ? [...candidates].sort((a, b) => {
                const ai = a.source === preferredSource ? -1 : 0;
                const bi = b.source === preferredSource ? -1 : 0;
                return ai - bi;
            })
            : candidates;

        patch({resolving: true, failedSources: [], candidates: ordered});

        const failed: string[] = [];
        const resumeAt = keepElapsed ? ctx.getState().player.elapsed : 0;

        for (const candidate of ordered) {
            const resolved = await catalogService.resolveUrl(
                candidate.track,
                preferredQuality,
                candidate.source,
            );

            // 解析期间切歌则整体放弃
            if (ctx.getState().player.current?.playId !== playId) return;

            if (resolved) {
                patch({
                    audioUrl: resolved.url,
                    playable: true,
                    activeSource: resolved.source,
                    quality: resolved.quality,
                    failedSources: failed,
                    resolving: false,
                });
                if (resumeAt > 0) actions.seek(resumeAt);
                return;
            }

            failed.push(candidate.source);
            patch({failedSources: [...failed]});
        }

        // 全部候选都不可播：退回模拟时钟，界面照常推进
        patch({
            audioUrl: null,
            playable: false,
            activeSource: null,
            quality: null,
            resolving: false,
        });
    };

    const start = (track: Track, index: number, queue: Track[]) => {
        const current: NowPlaying = {...track, playId: ++playSeq};
        const candidates = candidatesOf(track);

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
            candidates,
            activeSource: null,
            quality: null,
            failedSources: [],
            resolving: true,
        });

        void loadLyrics(track, current.playId);
        void resolveWithFallback(candidates, current.playId);
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
            // 播放超过阈值时先回到开头
            if (elapsed > appConfig.player.restartThresholdSec) {
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
            const patchDuration =
                duration > 0 && Math.abs(duration - ctx.getState().player.duration) > 0.5;
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
                candidates: [],
                activeSource: null,
                quality: null,
                failedSources: [],
                resolving: false,
            });
        },

        switchSource(sourceId) {
            const {current, candidates} = ctx.getState().player;
            if (!current) return;

            const only = candidates.filter((candidate) => candidate.source === sourceId);
            if (only.length === 0) return;

            // 手动切换：只试指定的源，失败则保留当前播放状态并标记不可用
            void resolveWithFallback(only, current.playId, true).then(() => {
                if (ctx.getState().player.activeSource === null) {
                    patch({failedSources: [sourceId], resolving: false});
                }
            });
        },

        reloadSource() {
            const {current, candidates} = ctx.getState().player;
            if (!current || candidates.length === 0) return;
            void resolveWithFallback(candidates, current.playId, true);
        },

        removeFromQueue(trackId) {
            const {queue, index, current} = ctx.getState().player;
            if (current?.id === trackId) return; // 当前曲目不可移除

            const at = queue.findIndex((track) => track.id === trackId);
            if (at < 0) return;

            patch({
                queue: queue.filter((_, i) => i !== at),
                index: at < index ? index - 1 : index,
            });
        },

        moveInQueue(trackId, offset) {
            const {queue, index} = ctx.getState().player;
            const at = queue.findIndex((track) => track.id === trackId);
            const to = at + offset;
            if (at < 0 || to < 0 || to >= queue.length) return;

            const next = [...queue];
            [next[at], next[to]] = [next[to], next[at]];

            let nextIndex = index;
            if (index === at) nextIndex = to;
            else if (index === to) nextIndex = at;

            patch({queue: next, index: nextIndex});
        },

        clearQueue() {
            const {queue, index} = ctx.getState().player;
            if (index < 0 || !queue[index]) {
                patch({queue: []});
                return;
            }
            patch({queue: [queue[index]], index: 0});
        },
    };

    return {key: 'player' as const, state, actions};
}
