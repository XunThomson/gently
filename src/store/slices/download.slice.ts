import {appConfig} from '../../config/app.config';
import {coreDownloadsAvailable, libraryService} from '../../services';
import {formatSizeMb} from '../../utils/helpers';
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
 * 本地项只可能是「浏览器模拟」或「核心拒绝建任务后留下的错误项」，
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

    const patch = (partial: Partial<DownloadState>) => {
        ctx.setState({download: {...ctx.getState().download, ...partial}});
    };

    const updateTask = (
        id: string,
        updater: (task: DownloadState['tasks'][number]) => DownloadState['tasks'][number],
    ) => {
        patch({tasks: ctx.getState().download.tasks.map((t) => (t.id === id ? updater(t) : t))});
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
                    updateTask(id, (task) => ({
                        ...task,
                        status: 'done',
                        progress: 1,
                        sizeText: formatSizeMb(task.totalMb, task.totalMb),
                        speedText: undefined,
                        path,
                    }));
                },
                onError: ({id, code, message}) => {
                    updateTask(id, (task) => ({
                        ...task,
                        status: 'error',
                        speedText: undefined,
                        // 码给界面走 i18n，message 只作为兜底（核心的开发者说明）
                        errorCode: code,
                        error: message,
                    }));
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
            if (coreDriven) subscribeCore();
        },

        /** 已存在的曲目不重复入队 */
        add(track) {
            const {tasks} = ctx.getState().download;
            if (tasks.some((task) => task.track.id === track.id)) return;

            // 桌面端：交给核心（真实 URL、真实进度、落盘）
            void libraryService.createDownload(track).then((result) => {
                if (result.ok) {
                    patch({tasks: [result.data, ...ctx.getState().download.tasks]});
                    return;
                }
                // 浏览器预览（没有核心）：下面插占位并由 `tick()` 推进
                if (result.error.code === 'common.unsupported_platform') return;
                // 核心**拒绝**建任务（插件未安装 / 解析不到地址）：必须让用户看到原因。
                // 以前这里 `if (!created) return`——点了下载什么都不发生，也说不清为什么。
                // **不编造文件大小**：核心没建任务，就没有真实总量，写「0.0Mb/3.4Mb」
                // 是拿时长估算冒充事实（失败项本就不显示进度列）。
                patch({
                    tasks: [
                        {
                            id: `${LOCAL_TASK_PREFIX}${track.id}`,
                            track,
                            status: 'error',
                            progress: 0,
                            totalMb: 0,
                            sizeText: '',
                            errorCode: result.error.code,
                            error: result.error.message,
                        },
                        ...ctx.getState().download.tasks,
                    ],
                });
            });

            // 有核心就不模拟：是否走模拟只取决于**有没有核心**，而不是 `load()` 时的快照。
            // 用快照会在「load() 之前点下载」时同时插一条假任务、又收到核心的真任务（同一首歌两条）。
            if (coreDownloadsAvailable()) return;

            const totalMb = sizeOf(track.durationSec);
            patch({
                tasks: [
                    {
                        id: `${LOCAL_TASK_PREFIX}${track.id}`,
                        track,
                        status: 'pending',
                        progress: 0,
                        totalMb,
                        sizeText: formatSizeMb(0, totalMb),
                    },
                    ...tasks,
                ],
            });
        },

        remove(id) {
            patch({tasks: ctx.getState().download.tasks.filter((t) => t.id !== id)});
            void libraryService.removeDownload(id);
        },

        pause(id) {
            updateTask(id, (t) =>
                t.status === 'downloading' ? {...t, status: 'paused', speedText: undefined} : t,
            );
            void libraryService.pauseDownload(id);
        },

        resume(id) {
            const task = ctx.getState().download.tasks.find((t) => t.id === id);

            // 本地兜底项（核心拒绝建任务 / 浏览器模拟）的 id 形如 `dl:<track.id>`，**核心不认识它**。
            // 有核心时「重试」= 重新建一次任务（用户可能刚把插件装好）；没有核心时照旧跑模拟。
            if (task && id.startsWith(LOCAL_TASK_PREFIX) && coreDownloadsAvailable()) {
                patch({tasks: ctx.getState().download.tasks.filter((t) => t.id !== id)});
                actions.add(task.track);
                return;
            }

            /* 速度只有**浏览器模拟**能编：核心持有的任务由 `download:progress` 事件给真实速度，
               这里先写一个 `1.0Mb/s` 会让界面在核心还没回报时显示一个假数字（随后被真值覆盖，
               但那一瞬间是假的；核心报错时更是永远留着假的）。 */
            const simulated = !coreDownloadsAvailable();
            updateTask(id, (t) =>
                t.status === 'paused' || t.status === 'error' || t.status === 'pending'
                    ? {...t, status: 'downloading', ...(simulated ? {speedText: '1.0Mb/s'} : {})}
                    : t,
            );
            void libraryService.resumeDownload(id);
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
        },
    };

    return {key: 'download' as const, state, actions};
}
