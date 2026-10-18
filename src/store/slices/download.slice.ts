import {appConfig} from '../../config/app.config';
import {coreDownloadsAvailable, libraryService} from '../../services';
import type {Track, TrackCandidate, TrackQuality} from '../../types';
import {formatSizeMb} from '../../utils/helpers';
import {pickQualityWithFallback} from '../../utils/quality';
import type {DownloadActions, DownloadState, StoreCtx} from '../types';

/** 曲目时长 → 文件大小（MB）的粗略估算（**仅 mock 用**：核心会给真实总量） */
const sizeOf = (durationSec: number) =>
    Math.max(1, Math.round((durationSec / appConfig.download.secondsPerMb) * 10) / 10);

/** 字节 → MB（核心事件带的是字节数） */
const mb = (bytes: number) => bytes / 1024 / 1024;

/**
 * 前端本地任务 id 的前缀（`dl:<track.id>`）。
 *
 * 核心给的任务 id 是 `dl-<毫秒>-<序号>`（连字符），因此「谁持有这个任务」一眼可分：
 * 本地项可能是「排队等待的占位」「浏览器模拟」或「核心拒绝建任务后留下的错误项」，
 * 核心命令（pause/resume/remove）对它们没有意义（见 `resume`）。
 */
const LOCAL_TASK_PREFIX = 'dl:';

/**
 * 下载任务切片。
 *
 * **两条路径**：
 * - 桌面端：任务由**本机核心**持有（`download.*` 命令 + `download:progress|done|error` 事件），
 *   切片只把事件映射进 store；
 * - 浏览器预览：没有核心，用 `tick()` 定时器模拟进度（视觉与桌面端一致）。
 *
 * 用 `coreDriven` 区分两者：核心在管的时候**必须停掉模拟推进**，
 * 否则假进度会覆盖真进度（这比「看起来在下载」糟糕得多）。
 */
export function createDownloadSlice(ctx: StoreCtx) {
    const state: DownloadState = {tasks: [], loaded: false};

    /** 任务是否由本机核心持有（模块级：一个会话只订阅一次核心事件） */
    let coreDriven = false;
    let subscribed = false;

    /**
     * 排队等待并发槽位的任务（只在本会话内：占位任务让用户看得见「在等」）。
     *
     * 下载并发数是设置页的可调项（`ui.downloadMaxConcurrent`）：**所有**新任务都先入队，
     * 由 `pump()` 按槽位交给核心。这样「快速连点下载」不会一口气建十个任务。
     *
     * `resume` 是「继续一个已存在的核心任务」：核心的 resume 会立刻起线程，
     * 所以先排队、轮到它时再发命令，否则用户点几下「继续」就绕过了上限。
     */
    type QueuedItem =
        | {kind: 'create'; localId: string; track: Track}
        | {kind: 'resume'; localId: string; track: Track};
    const queued: QueuedItem[] = [];
    /**
     * 本会话里**真的已经开始**（占用并发槽）的任务 id。
     *
     * 不能靠「状态是不是 pending」判断：核心建任务后先落 pending、worker 起来才推进度，
     * 库里也可能留着上次退出时的 pending 任务——把它们都算成「在下载」会让队列永远等不到槽位。
     * 这里只记我们自己发出去的命令，done/error/paused/移除时释放。
     */
    const running = new Set<string>();
    let pumping = false;
    /** 正在 await 建任务的数量：也算占用槽位，否则一笔 await 期间会超发 */
    let starting = 0;

    const patch = (partial: Partial<DownloadState>) => {
        ctx.setState({download: {...ctx.getState().download, ...partial}});
    };

    const updateTask = (
        id: string,
        updater: (task: DownloadState['tasks'][number]) => DownloadState['tasks'][number],
    ) => {
        patch({tasks: ctx.getState().download.tasks.map((t) => (t.id === id ? updater(t) : t))});
    };

    const localIdOf = (track: Track) => `${LOCAL_TASK_PREFIX}${track.id}`;
    const isLocalTask = (id: string) => id.startsWith(LOCAL_TASK_PREFIX);

    const maxConcurrent = () => Math.max(1, ctx.getState().ui.downloadMaxConcurrent);

    /** 占着并发槽的任务数：本会话已开始 + 正在 await 建任务 */
    const activeCount = () => starting + running.size;

    const dropQueued = (localId: string) => {
        const at = queued.findIndex((item) => item.localId === localId);
        if (at >= 0) queued.splice(at, 1);
    };

    /** 释放已经结束/被移除任务的并发槽（状态是事实来源，running 只是本会话的记账） */
    const pruneRunning = () => {
        for (const id of [...running]) {
            const task = ctx.getState().download.tasks.find((item) => item.id === id);
            if (!task || task.status === 'done' || task.status === 'error' || task.status === 'paused') {
                running.delete(id);
            }
        }
    };

    /**
     * 按曲目自带的候选信息 + 用户设置挑下载音质。
     * 列表快照（收藏 / 最近）里没有候选信息时返回用户选的档位，不瞎猜。
     */
    const qualityFor = (track: Track): TrackQuality => {
        const {downloadQuality, downloadQualityFallback} = ctx.getState().ui;
        const candidates = (track as Track & {candidates?: TrackCandidate[]}).candidates ?? [];
        const available = candidates.find((item) => item.source === track.source)?.qualities ?? [];
        return pickQualityWithFallback(available, downloadQuality, downloadQualityFallback);
    };

    /** 浏览器预览：把占位项同步转成「模拟下载中」，由 `tick()` 推进；占一个并发槽 */
    const markSimulated = (track: Track, localId?: string) => {
        const totalMb = sizeOf(track.durationSec);
        const id = localId ?? localIdOf(track);
        if (localId) {
            updateTask(localId, (task) => ({
                ...task,
                status: 'downloading',
                totalMb,
                sizeText: formatSizeMb(0, totalMb),
            }));
        } else {
            patch({
                tasks: [
                    {
                        id,
                        track,
                        status: 'downloading',
                        progress: 0,
                        totalMb,
                        sizeText: formatSizeMb(0, totalMb),
                    },
                    ...ctx.getState().download.tasks,
                ],
            });
        }
        running.add(id);
    };

    /** 真正建任务：交给核心（浏览器预览走 `markSimulated`，不会到这里） */
    const startTask = async (track: Track, localId?: string): Promise<void> => {
        const {downloadDir} = ctx.getState().ui;
        const dir = downloadDir.trim() || undefined;
        const result = await libraryService.createDownload(track, qualityFor(track), dir);

        if (result.ok) {
            /* 去掉占位项（可能与核心任务同 id：核心拒绝后重试时会出现），再放到队首 */
            const tasks = ctx.getState().download.tasks.filter(
                (task) => task.id !== localId && task.id !== result.data.id,
            );
            patch({tasks: [result.data, ...tasks]});
            running.add(result.data.id);
            return;
        }

        // 宿主在这一刻不可用了（浏览器预览 / 核心掉线）：继续走模拟，界面不会卡在「等待中」
        if (result.error.code === 'common.unsupported_platform') {
            markSimulated(track, localId);
            return;
        }

        // 核心**拒绝**建任务（插件未安装 / 解析不到地址 / 目录不存在）：让用户看到原因
        const failed: DownloadState['tasks'][number] = {
            id: localId ?? localIdOf(track),
            track,
            status: 'error',
            progress: 0,
            totalMb: 0,
            sizeText: '',
            errorCode: result.error.code,
            error: result.error.message,
        };
        if (localId && ctx.getState().download.tasks.some((task) => task.id === localId)) {
            updateTask(localId, () => failed);
        } else {
            patch({tasks: [failed, ...ctx.getState().download.tasks]});
        }
    };

    /** 槽位空出来后，按顺序把排队中的任务交给核心 */
    const pump = async (): Promise<void> => {
        if (pumping) return;
        pumping = true;
        try {
            while (queued.length > 0 && activeCount() < maxConcurrent()) {
                const next = queued.shift()!;

                if (next.kind === 'resume') {
                    const task = ctx.getState().download.tasks.find((item) => item.id === next.localId);
                    // 已经完成 / 被移除的任务不再续传（失败项允许重试）
                    if (!task || task.status === 'done') continue;

                    updateTask(next.localId, (item) => ({
                        ...item,
                        status: 'downloading',
                        speedText: undefined,
                        errorCode: undefined,
                        error: undefined,
                    }));
                    if (!coreDownloadsAvailable()) {
                        // 浏览器预览：没有真任务可续传，按模拟下载继续
                        running.add(next.localId);
                        continue;
                    }
                    starting += 1;
                    try {
                        await libraryService.resumeDownload(next.localId);
                    } finally {
                        starting -= 1;
                    }
                    running.add(next.localId);
                    continue;
                }

                // 占位项可能已被用户移除：不再替它建任务
                if (!ctx.getState().download.tasks.some((task) => task.id === next.localId)) continue;

                /* 浏览器预览：**同步**转成模拟下载（测试与界面都期望点完立刻是「下载中」） */
                if (!coreDownloadsAvailable()) {
                    markSimulated(next.track, next.localId);
                    continue;
                }

                starting += 1;
                try {
                    await startTask(next.track, next.localId);
                } finally {
                    starting -= 1;
                }
            }
        } finally {
            pumping = false;
        }
    };

    /** 订阅核心下载事件：进度/完成/失败都要反映到任务上 */
    const subscribeCore = () => {
        if (subscribed) return;
        subscribed = true;
        void libraryService
            .listenDownloads({
                onProgress: ({id, received, total, speed}) => {
                    updateTask(id, (task) => {
                        const totalBytes = total && total > 0 ? total : task.totalMb * 1024 * 1024;
                        const progress = totalBytes > 0 ? Math.min(1, (received / totalBytes) || 0) : 0;
                        return {
                            ...task,
                            status: 'downloading',
                            progress,
                            totalMb: mb(totalBytes),
                            sizeText: formatSizeMb(mb(received), mb(totalBytes)),
                            speedText: speed ? `${mb(speed).toFixed(1)}Mb/s` : undefined,
                        };
                    });
                },
                onDone: ({id, path}) => {
                    running.delete(id);
                    updateTask(id, (task) => ({
                        ...task,
                        status: 'done',
                        progress: 1,
                        sizeText: formatSizeMb(task.totalMb, task.totalMb),
                        speedText: undefined,
                        path,
                    }));
                    // 槽位空出来：把排队中的下一首交出去
                    void pump();
                },
                onError: ({id, code, message}) => {
                    running.delete(id);
                    updateTask(id, (task) => ({
                        ...task,
                        status: 'error',
                        speedText: undefined,
                        // 码给界面走 i18n，message 只作为兜底（核心的开发者说明）
                        errorCode: code,
                        error: message,
                    }));
                    void pump();
                },
            })
            .catch((err) => console.warn('[download] 订阅核心事件失败', err));
    };

    const actions: DownloadActions = {
        async load(options: {force?: boolean} = {}) {
            if (ctx.getState().download.loaded && !options.force) return;
            const tasks = await libraryService.loadDownloads();
            // 核心在不在管下载，不能靠「有没有任务」判断：浏览器里 mock 也会返回任务
            coreDriven = coreDownloadsAvailable();
            /**
             * **本机持有的任务不能被核心列表冲掉**。
             *
             * `dl:<track.id>` 这些任务（核心拒绝建任务后留下的「失败」项、浏览器里的模拟项）
             * 核心根本不知道它们存在；而 `download.list` 只回核心库里的任务。
             * 以前这里直接 `patch({tasks: tasks ?? []})`——用户点了下载（核心拒绝、留下一条失败原因），
             * 接着打开「下载管理」，`load()` 把那条失败项**抹掉**，于是界面上什么都没有
             * （R42 实测：日志里 `download.create ok=false 本地曲目不需要下载` 之后紧跟一条
             * `download.list`，页面却显示「暂无下载任务」）。
             */
            const local = ctx
                .getState()
                .download.tasks.filter((task) => task.id.startsWith(LOCAL_TASK_PREFIX));
            patch({tasks: [...local, ...(tasks ?? [])], loaded: true});
            /* 会话里记的「在跑」可能已经不在列表里（别处移除 / 上次退出）：顺手释放槽位 */
            pruneRunning();
            if (coreDriven) subscribeCore();
            // 核心列表里可能没有「下载中」了（上次退出时在跑的都停了）：把排队项接上
            void pump();
        },

        /**
         * 加入下载队列：**先入队**，再由 `pump()` 按并发上限交给核心。
         *
         * 用户在设置页改过下载目录 / 默认音质 / 缺档策略，这里都按当前设置执行；
         * 快速连点下载只会排出一个等待队列，不会一口气建一堆任务。
         */
        add(track) {
            const {tasks} = ctx.getState().download;
            if (tasks.some((task) => task.track.id === track.id)) return;

            const localId = localIdOf(track);
            if (queued.some((item) => item.localId === localId)) return;

            queued.push({kind: 'create', localId, track});
            patch({
                tasks: [
                    {
                        id: localId,
                        track,
                        status: 'pending',
                        progress: 0,
                        totalMb: 0,
                        sizeText: '',
                    },
                    ...ctx.getState().download.tasks,
                ],
            });
            void pump();
        },

        remove(id) {
            dropQueued(id);
            running.delete(id);
            patch({tasks: ctx.getState().download.tasks.filter((t) => t.id !== id)});
            void libraryService.removeDownload(id);
            // 让出槽位：下一首该开始了
            void pump();
        },

        pause(id) {
            // 排队中的任务还没发命令：直接从队列撤掉即可
            dropQueued(id);
            running.delete(id);
            updateTask(id, (t) =>
                t.status === 'downloading' || t.status === 'pending'
                    ? {...t, status: 'paused', speedText: undefined}
                    : t,
            );
            void libraryService.pauseDownload(id);
            // 暂停也让出槽位
            void pump();
        },

        resume(id) {
            const task = ctx.getState().download.tasks.find((t) => t.id === id);
            if (!task) return;

            /* 有核心时，本地项（核心拒绝的失败项 / 浏览器占位）核心不认识这个 id：
               「继续」= 按当前设置重新建一次任务（用户可能刚把插件装好）。
               浏览器预览没有核心，占位项就是模拟任务本身——在**原地**继续，
               换一个 id 会让列表里那一条任务突然消失、进度也丢了。 */
            if (isLocalTask(id) && coreDownloadsAvailable()) {
                dropQueued(id);
                patch({tasks: ctx.getState().download.tasks.filter((t) => t.id !== id)});
                actions.add(task.track);
                return;
            }

            /* resume 会让核心立刻起线程（浏览器预览则立刻变成模拟下载），先排队、
               轮到它时再动手——否则连点几下「继续」就绕过了并发上限。 */
            if (queued.some((item) => item.localId === id)) return;
            queued.push({kind: 'resume', localId: id, track: task.track});
            updateTask(id, (t) => ({...t, status: 'pending', speedText: undefined}));
            void pump();
        },

        clearFinished() {
            patch({tasks: ctx.getState().download.tasks.filter((t) => t.status !== 'done')});
            void libraryService.clearFinishedDownloads();
        },

        /** 推进所有「下载中」的任务（**仅 mock**：核心在管时它必须什么都不做） */
        tick() {
            if (coreDriven) return;
            const {tasks} = ctx.getState().download;
            if (!tasks.some((task) => task.status === 'downloading')) return;

            const step = appConfig.download.progressPerTick;

            patch({
                tasks: tasks.map((task) => {
                    if (task.status !== 'downloading') return task;

                    const progress = Math.min(1, task.progress + step);
                    const done = progress >= 1;
                    const speedMb = (step * task.totalMb).toFixed(1);

                    return {
                        ...task,
                        progress,
                        status: done ? 'done' : 'downloading',
                        sizeText: formatSizeMb(progress * task.totalMb, task.totalMb),
                        speedText: done ? undefined : `${speedMb}Mb/s`,
                    };
                }),
            });
            // 模拟任务完成也释放槽位：把排队中的下一首接上
            pruneRunning();
            void pump();
        },
    };

    return {key: 'download' as const, state, actions};
}
