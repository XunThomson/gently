import {appConfig} from '../../config/app.config';
import {audioEngine, catalogService, coreAvailable, libraryService} from '../../services';
import type {GroupedTrack, NowPlaying, Track, TrackCandidate} from '../../types';
import {pickQuality} from '../../utils/quality';
import {clampLyricsOffset, readLyricsOffset, writeLyricsOffset} from '../../utils/lyricsOffset';
import {
    appliedLyricsRef,
    clearLyricsChoice,
    readLyricsSync,
    saveLyricsChoice,
    type AppliedLyricsChoice,
} from '../../utils/lyricsSyncCache';
import type {
    LyricSourceInfo,
    PlaybackFailure,
    PlayerActions,
    PlayerState,
    StoreCtx,
} from '../types';
import {
    clearLastPlayback,
    LAST_PLAYBACK_WRITE_MS,
    writeLastPlayback,
    type LastPlaybackSnapshot,
} from '../../utils/lastPlayback';

let playSeq = 0;

/**
 * 「位置跳变」的阈值（秒）。
 *
 * 媒体元素正常回写是 250ms～1s 一小步；一次跨过 2 秒说明不是「在往前播」，
 * 而是加载/恢复/跳位——这时才值得让通知栏 / 锁屏重新对齐进度（R117）。
 */
const PROGRESS_JUMP_SEC = 2;

/** 已经上报过播放历史的 `playId`（同一首歌只报一次） */
let reportedPlayId = 0;

/** 已经上报过**推荐反馈**的 `playId`（与历史上的去重分开：暂停会先消费掉历史那一次） */
let feedbackPlayId = 0;

/**
 * 用户手动挑过歌词的 `playId`。
 *
 * 自动歌词是异步到的：用户点了「使用」之后它才回来的话，会把用户选的那份覆盖掉。
 * 用 playId 记住「这次播放已经手动选过」，自动加载因此不再覆盖。
 */
let manualLyricsPlayId: number | null = null;

/**
 * 「媒体报错后已经自动重新解析过一次」的 `playId`。
 *
 * 给**每次播放**一次自动恢复的机会（电脑休眠回来 / 流地址过期是最常见的两种：
 * 回环代理 token 只有 30 分钟，上游直链常常更短）。用 playId 记而不是布尔量：
 * 换歌自然重置，也不会因为上一首的恢复额度把下一首判死。
 */
let mediaRetryPlayId: number | null = null;

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

/** 跨源换源时判断“同一首歌”：忽略大小写、空白与全半角差异之外的装饰。 */
function sameTrackText(left: string, right: string): boolean {
    const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');
    return normalize(left) === normalize(right);
}

/** 播放条切片：当前曲目、队列、进度、歌词、音源与音质 */
export function createPlayerSlice(
    ctx: StoreCtx,
    /** 上次退出时正在放的曲目（手机页面被系统重载 / 关掉应用再打开时用） */
    restored: LastPlaybackSnapshot | null = null,
) {
    const state: PlayerState = {
        current: restored ? {...restored.track, playId: ++playSeq} : null,        detail: null,
        /* 恢复出来的是**暂停态**：自动出声既违反自动播放策略，也不是用户要的 */
        playing: false,
        queue: [],
        index: -1,
        repeat: 'off',
        volume: appConfig.player.defaultVolume,
        elapsed: restored?.position ?? 0,
        duration: restored?.track.durationSec ?? 0,
        seekSeq: 0,
        lyrics: [],
        lyricsSource: null,
        lyricsOffset: 0,
        audioUrl: null,
        playable: false,
        /* 恢复出来的曲目也要有**候选**：点播放时 `recoverPlayback` 靠它去解析地址，
           否则「恢复了一首歌却点不动」（R113 真机发现：候选列表没跟着恢复） */
        candidates: restored ? candidatesOf(restored.track) : [],
        activeSource: null,
        quality: null,
        failedSources: [],
        resolving: false,
        playbackError: null,
    };

    const patch = (partial: Partial<PlayerState>) => {
        ctx.setState({player: {...ctx.getState().player, ...partial}});
    };

    /**
     * 记下「上次在放什么 / 放到哪」（R113）。
     *
     * 只在两处写：换歌（`start`）与位置（`setProgress`，10 秒节流），
     * 再加暂停/恢复（`toggle`）。写太勤会把 `localStorage` 变成每秒一次写盘。
     */
    let lastWrittenAt = 0;
    const rememberPlayback = (force = false) => {
        const {current, elapsed} = ctx.getState().player;
        if (!current) {
            clearLastPlayback();
            return;
        }
        const now = Date.now();
        if (!force && now - lastWrittenAt < LAST_PLAYBACK_WRITE_MS) return;
        lastWrittenAt = now;
        writeLastPlayback({track: current, position: elapsed});
    };

    /** 音源 id → 显示名（插件列表来自核心/注册表；拿不到就退回 id） */
    const sourceNameOf = (sourceId: string): string =>
        ctx.getState().plugin.list.find((plugin) => plugin.id === sourceId)?.name ?? sourceId;

    /** 自动歌词的来路：当前曲目自身的源 */
    const autoLyricSource = (track: Track): LyricSourceInfo => ({
        source: track.source,
        sourceName: sourceNameOf(track.source),
        title: track.title,
        artist: track.artist,
    });

    /** 缓存里的来路 → 播放状态里的来路 */
    const rememberedSource = (choice: AppliedLyricsChoice): LyricSourceInfo => ({
        source: choice.source,
        sourceName: choice.sourceName,
        title: choice.title,
        artist: choice.artist,
        trackId: choice.trackId,
    });

    /**
     * 异步加载歌词；切歌后丢弃过期结果，手动选过的歌词不被覆盖。
     *
     * 顺序：**手动挑过的来路优先**（`utils/lyricsSyncCache.ts`）——用户校准过的偏移是对着那份词量的，
     * 回来播放同一首却换成源给的词，等于把上次的校正作废。来路取不到（插件卸载 / 源不再给词）
     * 才退回源自动给的词，并**不清掉**缓存：插件装回来时仍然生效。
     */
    const loadLyrics = async (track: Track, playId: number) => {
        const stillWanted = () =>
            ctx.getState().player.current?.playId === playId && manualLyricsPlayId !== playId;

        const remembered = readLyricsSync(track.id).applied;
        if (remembered) {
            try {
                const cached = await libraryService.loadLyricsFrom(appliedLyricsRef(remembered));
                if (!stillWanted()) return;
                if (cached) {
                    patch({lyrics: cached, lyricsSource: rememberedSource(remembered)});
                    return;
                }
            } catch (err) {
                console.warn('[player] 记住的歌词来路取词失败，退回源歌词', err);
                if (!stillWanted()) return;
            }
        }

        try {
            const lyrics = await libraryService.loadLyrics(track);
            if (!stillWanted()) return;
            patch({
                lyrics,
                lyricsSource: lyrics.length > 0 ? autoLyricSource(track) : null,
            });
        } catch (err) {
            console.warn('[player] 歌词加载失败', err);
            if (!stillWanted()) return;
            patch({lyrics: [], lyricsSource: null});
        }
    };

    /**
     * 异步补当前曲目的**源侧详情**（`catalog.track`）。
     *
     * 列表快照常常没有封面（搜索结果只带标题歌手），问一次源就能拿到真实封面：
     * 播放条与歌词页据此渲染，而不是退到哈希渐变。失败/没有详情都只是「继续用快照」，
     * 不打扰用户（`detail()` 里已经把「源没实现」当正常情况）。
     */
    const loadDetail = async (track: Track, playId: number) => {
        try {
            const detail = await catalogService.fetchTrackDetail(track);
            if (ctx.getState().player.current?.playId === playId) patch({detail});
        } catch (err) {
            console.warn('[player] 曲目详情加载失败', err);
            if (ctx.getState().player.current?.playId === playId) patch({detail: null});
        }
    };

    /**
     * 按候选顺序解析音源：首个能播的就用它，失败的记为不可用并继续下一个。
     * 这样「某个音源的某首歌播不了」不会卡住播放，用户仍能听到其它源的同一首歌。
     *
     * 选项：
     * - `keepElapsed`：保留当前进度（切音源 / 换音质时用）；
     * - `alreadyFailed`：已经确认播不了的源（媒体元素报错时由 `markUnplayable` 传进来），
     *   这一轮直接跳过它们，不重复撞同一堵墙；
     * - `failure`：全都没成功时用哪种失败说明（媒体报错要保留「媒体」这个原因，而不是笼统的「没有源」）。
     */
    const resolveWithFallback = async (
        candidates: TrackCandidate[],
        playId: number,
        options: {
            keepElapsed?: boolean;
            alreadyFailed?: string[];
            failure?: Omit<PlaybackFailure, 'failedSources'>;
        } = {},
    ) => {
        const {keepElapsed = false, alreadyFailed = [], failure = {kind: 'noSource'}} = options;
        const {preferredQuality, preferredSource} = ctx.getState().ui;
        const ordered = preferredSource
            ? [...candidates].sort((a, b) => {
                const ai = a.source === preferredSource ? -1 : 0;
                const bi = b.source === preferredSource ? -1 : 0;
                return ai - bi;
            })
            : candidates;

        const failed = [...alreadyFailed];
        patch({
            resolving: true,
            failedSources: [...failed],
            candidates: ordered,
            playbackError: null,
        });

        const resumeAt = keepElapsed ? ctx.getState().player.elapsed : 0;

        for (const candidate of ordered) {
            if (failed.includes(candidate.source)) continue;

            /*
             * 按**该源声明的音质**挑档，而不是把全局首选档位原样丢给每个源。
             * 以前这里永远传 preferredQuality（默认 high）：只实现 standard 的插件
             * 会把 high 当成不支持，返回 null → 整首歌被判“无法播放”。
             * 空 qualities 表示来源没声明，保留首选档位交给插件自己处理。
             */
            const quality = pickQuality(candidate.qualities, preferredQuality) ?? preferredQuality;
            const resolved = await catalogService.resolveUrl(
                candidate.track,
                quality,
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
                    playbackError: null,
                });
                if (resumeAt > 0) actions.seek(resumeAt);
                return;
            }

            failed.push(candidate.source);
            patch({failedSources: [...failed]});
        }

        /**
         * 全部候选都解析不到地址：**停表并给出原因**，不再假装在播。
         *
         * 以前这里是「退回模拟时钟，界面照常推进」——那正是「界面在放、实际没声音」的根源：
         * 没有音源却显示播放中，用户只能靠「怎么没声音」自己猜。
         *
         * 例外：**没有本机核心**（浏览器预览 `pnpm dev`）时保留旧行为——那里本来就没有音频，
         * 时钟是唯一的「播放」，停掉只会让预览变成一个不能动的界面。
         */
        const stillCurrent = ctx.getState().player.current?.playId === playId;
        const strict = coreAvailable();
        patch({
            audioUrl: null,
            playable: false,
            activeSource: null,
            quality: null,
            resolving: false,
            ...(stillCurrent && strict
                ? {
                    playing: false,
                    playbackError: {...failure, failedSources: [...failed]},
                }
                : {}),
        });
    };

    /**
     * 把这**一次**播放上报给本机核心（`playback.report`）：写的是播放历史，
     * 与「最近播放」和推荐画像共用一份数据。带上实际播成的音源与真实秒数——
     * 这正是它比 `library.history.push` 多出来的信息（候选回退后来源可能变了）。
     *
     * 时机：放完、被切走、暂停、停止、切源重来时各报一次；同一个 `playId` 只报一次。
     */
    const reportPlayback = (options: {final?: boolean} = {}) => {
        const {current, elapsed, duration, activeSource, quality} = ctx.getState().player;
        if (!current || current.playId === reportedPlayId) return;
        reportedPlayId = current.playId;

        const playedSec = Math.max(0, Math.round(elapsed));
        const completed = duration > 0 && playedSec >= Math.round(duration) - 1;
        void libraryService.reportPlay(current, {
            source: activeSource ?? undefined,
            quality: quality ?? undefined,
            playedSec,
            // 允许 1 秒误差：真实播放到尾部时进度条可能还差一点
            completed,
        });

        if (options.final) reportFeedback(current, elapsed, duration, completed);
    };

    /**
     * 上报推荐反馈（`recommend.feedback`）：**弱信号**，只报两种有明确倾向的结局。
     *
     * 为什么必须由界面报：「听了一半就切走」核心自己看不到——画像只消费播放次数与时间
     * （`build_taste` 不看 `playedSec`），不报的话它在画像里与「完整听完」没有区别。
     *
     * **只在「这次播放真的结束了」时报**（切歌 / 停止 / 播完），暂停不算：
     * 暂停可能是去接个电话，把它当负信号会平白压低用户喜欢的歌。
     * 单独用 `feedbackPlayId` 去重（历史那边的 `reportedPlayId` 可能已被暂停路径消费）。
     */
    const reportFeedback = (track: NowPlaying, elapsed: number, duration: number, completed: boolean) => {
        if (duration <= 0 || track.playId === feedbackPlayId) return;
        feedbackPlayId = track.playId;

        if (completed) {
            void libraryService.recommendFeedback(track, 'complete', 1);
            return;
        }
        const progress = Math.min(1, Math.max(0, elapsed / duration));
        // 核心只把 `progress < 0.5` 的跳过当负信号；听到一半以上没听完算中立，不报
        if (progress < appConfig.player.feedbackSkipRatio) {
            void libraryService.recommendFeedback(track, 'skip', progress);
        }
    };

    const start = (track: Track, index: number, queue: Track[]) => {
        // 先结算上一首，再开新的一首（切歌 = 上一首的一次播放真的结束了）
        reportPlayback({final: true});

        const current: NowPlaying = {...track, playId: ++playSeq};
        const candidates = candidatesOf(track);
        // 新的一次播放：上一次手动挑的歌词不再相关
        manualLyricsPlayId = null;

        patch({
            current,
            detail: null, // 上一首的详情不能留在这一首上
            queue,
            index,
            playing: true,
            elapsed: 0,
            duration: track.durationSec,
            lyrics: [],
            lyricsSource: null,
            // 这首曲子上次校正过的偏移还记得（逐曲目持久化）
            lyricsOffset: readLyricsOffset(track.id),
            audioUrl: null,
            playable: false,
            candidates,
            activeSource: null,
            quality: null,
            failedSources: [],
            resolving: true,
            // 新的一首：上一次的播放失败提示不能留在这儿
            playbackError: null,
        });

        void loadLyrics(track, current.playId);
        void loadDetail(track, current.playId);
        void resolveWithFallback(candidates, current.playId);
        ctx.getActions().library.recordPlay(track);
        // 换歌立刻落盘：下一次冷启动/页面重载要能显示这一首
        rememberPlayback(true);
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
            const {playing, current, audioUrl} = ctx.getState().player;
            if (!current) return;
            /* 还没有音频地址（刚恢复上次的曲目 / 上一次被判播不了）：点播放要**先解析地址**，
               否则界面翻成「在播」却一点声音都没有。`recoverPlayback` 会保留当前进度。 */
            if (!playing && !audioUrl) {
                actions.recoverPlayback();
                return;
            }
            // 暂停即一次播放结束（恢复播放算新的一次）：历史里记到的是真实听过的秒数
            if (playing) reportPlayback();
            patch({playing: !playing});
            // 暂停/恢复都是一次「用户离开前的状态」，立刻落盘
            rememberPlayback(true);
        },

        next() {
            const {repeat, current, index, queue} = ctx.getState().player;
            if (!current) return;
            if (repeat === 'one') {
                start(current, index, queue);
                return;
            }
            if (!moveTo(1)) {
                /**
                 * 队列到头：这一首**真的播完了**，必须结算（历史 + 推荐反馈）。
                 *
                 * 不结算的话，最后这首歌的「完整听完」信号就丢了：既没有 `playback.report`
                 * （历史 / 画像看不到），也没有 `recommend.feedback complete`——
                 * 而它恰恰是最强的正反馈（真实应用里点开一首 3 秒的本地曲目播完，日志里一条都没有，
                 * 才发现这条路径一直漏着）。
                 */
                reportPlayback({final: true});
                patch({playing: false, elapsed: 0});
            }
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
            const {duration: known, elapsed: previous, seekSeq} = ctx.getState().player;
            const patchDuration =
                duration > 0 && Math.abs(duration - known) > 0.5;
            /* 位置**跳变**（不是正常往前走）也记一笔：通知栏 / 锁屏的进度条据此重新对齐。
               为什么必须记：恢复上次的曲目时，媒体元素会先报一次 0、再跳到续播点；
               只认「用户拖了进度」的话，原生侧会一直停在 0（R117 真机踩到的）。 */
            const jumped = Math.abs(elapsed - previous) > PROGRESS_JUMP_SEC;
            patch(
                jumped
                    ? {elapsed, seekSeq: seekSeq + 1, ...(patchDuration ? {duration} : {})}
                    : patchDuration
                      ? {elapsed, duration}
                      : {elapsed},
            );
            // 位置每 10 秒落一次盘：「上次放到哪」只值这个精度（见 `rememberPlayback`）
            rememberPlayback();
        },

        markUnplayable(message) {
            const {current, candidates, failedSources, activeSource} = ctx.getState().player;
            if (!current) return;

            /* 把「正在用的这个源」记为失败，然后拿剩下的候选再解析一次：
               多源的意义就在这里——A 源给的地址 403 了，B 源通常还能放。 */
            const failed =
                activeSource && !failedSources.includes(activeSource)
                    ? [...failedSources, activeSource]
                    : [...failedSources];
            const remaining = candidates.filter((candidate) => !failed.includes(candidate.source));

            patch({audioUrl: null, playable: false, failedSources: failed});

            if (remaining.length > 0) {
                void resolveWithFallback(candidates, current.playId, {keepElapsed: true, alreadyFailed: failed, failure: {kind: 'media', ...(message ? {detail: message} : {})}});
                return;
            }

            /**
             * 没有别的候选了：**先给同一批源一次重新解析的机会**，再判死。
             *
             * 典型场景是电脑休眠回来：媒体元素已经断了，但界面还以为在播。此时
             * 回环代理的 token（30 分钟 TTL）或上游直链很可能已经过期——重新问核心一次
             * 就能拿回一个新地址继续放。以前这里直接 `playing:false`，用户看到的是
             * 「继续播放没反应，得手动重新点这首歌」（R87 的 bug）。
             *
             * 每次播放只给一次机会：解析回来还是坏的话就如实停播说明原因，不做无限重试。
             */
            if (mediaRetryPlayId !== current.playId) {
                mediaRetryPlayId = current.playId;
                patch({
                    playing: true,
                    failedSources: [],
                    playbackError: null,
                    audioUrl: null,
                    playable: false,
                });
                // 原因照样带过去：这次重解析也失败时，界面要说的仍是「媒体」而不是「没有源」
                void resolveWithFallback(candidates, current.playId, {
                    keepElapsed: true,
                    failure: {kind: 'media', ...(message ? {detail: message} : {})},
                });
                return;
            }

            // 真的没救了：停表，把原因交给界面
            patch({
                playing: false,
                playbackError: {kind: 'media', failedSources: failed, ...(message ? {detail: message} : {})},
            });
        },

        markInterrupted() {
            const {current, playing} = ctx.getState().player;
            if (!current || !playing) return;
            /* 只改「在播却没在播」这一种状态：已经停了就不该覆盖别的原因。
               `audioUrl` / `candidates` 都留着——用户点「重试」时走 `retryPlayback`。 */
            patch({
                playing: false,
                playbackError: {kind: 'interrupted', failedSources: []},
            });
        },

        retryPlayback() {
            const {current, candidates} = ctx.getState().player;
            if (!current) return;
            // 用户显式重试：媒体重试额度也重置一次（不然第二次点击会直接判死）
            mediaRetryPlayId = null;
            patch({
                playing: true,
                playbackError: null,
                failedSources: [],
                audioUrl: null,
                playable: false,
            });
            void resolveWithFallback(candidates, current.playId);
        },

        recoverPlayback() {
            const {current, candidates, elapsed} = ctx.getState().player;
            if (!current) return;
            // 与「点重试」不同：这里是用户没做任何操作时的自动恢复，必须**接着原进度**播
            mediaRetryPlayId = null;
            patch({
                playing: true,
                playbackError: null,
                failedSources: [],
                audioUrl: null,
                playable: false,
            });
            void resolveWithFallback(candidates, current.playId, {keepElapsed: elapsed > 0});
        },

        async findAlternatives() {
            const {current, candidates, failedSources} = ctx.getState().player;
            if (!current) return;

            /*
             * 只从**用户点「换源」**开始跨源搜索：播放失败时自动去搜所有源，
             * 会把一次失败放大成一轮网络请求；这里把动作交给用户，也便于解释。
             *
             * 榜单/收藏/历史里的曲目通常只有一个候选（它们不是聚合搜索的结果），
             * 这正是网易云会员/版权曲目失败后 MusicFree 能“换个源”而我们卡住的原因。
             */
            patch({resolving: true});
            const keyword = `${current.title} ${current.artist}`.trim();
            let groups: Awaited<ReturnType<typeof catalogService.searchAll>> = [];
            try {
                groups = await catalogService.searchAll(keyword);
            } catch (err) {
                console.warn('[player] 换源搜索失败', err);
            }

            // 搜索期间切歌/停止：丢弃结果
            if (ctx.getState().player.current?.playId !== current.playId) return;

            const match =
                groups.find(
                    (group) =>
                        sameTrackText(group.title, current.title) &&
                        sameTrackText(group.artist, current.artist),
                ) ?? groups.find((group) => sameTrackText(group.title, current.title));

            const extras = (match?.candidates ?? []).filter(
                (candidate) =>
                    !candidates.some(
                        (existing) =>
                            existing.source === candidate.source &&
                            existing.track.id === candidate.track.id,
                    ),
            );

            if (extras.length === 0) {
                patch({
                    resolving: false,
                    playbackError: {
                        kind: 'noSource',
                        failedSources: failedSources.length > 0 ? failedSources : candidates.map((item) => item.source),
                    },
                });
                return;
            }

            const merged = [...candidates, ...extras];
            patch({
                candidates: merged,
                failedSources: [],
                playbackError: null,
                resolving: false,
                playing: true,
            });
            void resolveWithFallback(merged, current.playId, {keepElapsed: true});
        },

        seek(seconds) {
            const {duration, seekSeq} = ctx.getState().player;
            const next = Math.min(Math.max(0, seconds), duration || Number.MAX_SAFE_INTEGER);
            /* `seekSeq` 是给「不该订阅 elapsed 的订阅方」的信号（通知栏/锁屏的进度条，R117）：
                播放中的位置由系统自己按速度推算，只有被手动改过才需要重推一次 */
            patch({elapsed: next, seekSeq: seekSeq + 1});
            // 命令同时下发给音频引擎，保持 UI 与声音一致
            audioEngine.seek(next);
        },

        stop() {
            reportPlayback({final: true});
            manualLyricsPlayId = null;
            patch({
                current: null,
                detail: null,
                playing: false,
                elapsed: 0,
                duration: 0,
                index: -1,
                lyrics: [],
                lyricsSource: null,
                lyricsOffset: 0,
                audioUrl: null,
                playable: false,
                candidates: [],
                activeSource: null,
                quality: null,
                failedSources: [],
                resolving: false,
                playbackError: null,
            });
            // 用户主动清空播放：下次启动不该「接着放」一首他已经关掉的歌
            clearLastPlayback();
        },

        applyLyrics(lines, source) {
            const {current} = ctx.getState().player;
            if (!current) return;
            manualLyricsPlayId = current.playId;
            patch({lyrics: lines, lyricsSource: source});
            /* 记住「这首曲目的词是从哪挑来的」：下次播放同一首先按这条来路取词，
               否则用户校准好的偏移会跟着源给的词一起失效 */
            if (source.trackId) {
                saveLyricsChoice(current.id, {
                    source: source.source,
                    trackId: source.trackId,
                    sourceName: source.sourceName,
                    title: source.title,
                    artist: source.artist,
                });
            }
        },

        restoreAutoLyrics() {
            const {current} = ctx.getState().player;
            if (!current) return;
            clearLyricsChoice(current.id);
            manualLyricsPlayId = null;
            patch({lyrics: [], lyricsSource: null});
            void loadLyrics(current, current.playId);
        },

        setLyricsOffset(seconds) {
            const {current} = ctx.getState().player;
            const value = clampLyricsOffset(seconds);
            patch({lyricsOffset: value});
            if (current) writeLyricsOffset(current.id, value);
        },

        nudgeLyricsOffset(delta) {
            const {current, lyricsOffset} = ctx.getState().player;
            const value = clampLyricsOffset(lyricsOffset + delta);
            if (value === lyricsOffset) return;
            patch({lyricsOffset: value});
            if (current) writeLyricsOffset(current.id, value);
        },

        switchSource(sourceId) {
            const {current, candidates, activeSource} = ctx.getState().player;
            if (!current) return;

            const only = candidates.filter((candidate) => candidate.source === sourceId);
            if (only.length === 0) return;

            const previous = activeSource;
            // 手动切换：先只试指定的源
            void resolveWithFallback(only, current.playId, {keepElapsed: true}).then(() => {
                const state = ctx.getState().player;
                if (state.activeSource !== null) return;

                /* 指定源放不了：把之前能放的源找回来。
                   以前这里只是「保留 current 并标记不可用」——而 `playing` 还是 true、进度照走，
                   用户看到的是「切了个源之后还在播但没声音」（R71 报的那类现象）。
                   能退回去就退回；退不回去就停在失败态并说明原因。 */
                const back = previous && previous !== sourceId
                    ? candidates.filter((candidate) => candidate.source === previous)
                    : [];
                if (back.length > 0) {
                    void resolveWithFallback(back, current.playId, {keepElapsed: true, alreadyFailed: [sourceId]});
                    return;
                }
                patch({
                    failedSources: state.failedSources.includes(sourceId)
                        ? state.failedSources
                        : [...state.failedSources, sourceId],
                    resolving: false,
                });
            });
        },

        reloadSource() {
            const {current, candidates} = ctx.getState().player;
            if (!current || candidates.length === 0) return;
            void resolveWithFallback(candidates, current.playId, {keepElapsed: true});
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
