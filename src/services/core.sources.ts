/**
 * 「核心侧已安装音源」的进程内缓存，以及**按源路由**的判定。
 *
 * **为什么必须有这份缓存**：桌面上有**两类音源**并存——
 * 1. 真正的插件音源，住在核心里（`plugin.list` 是唯一权威），只能由 `catalog.*` 命令执行；
 * 2. **内置演示源**，只存在于前端注册表（`src/plugins/builtin`），核心完全不认识它。
 *
 * 不区分这两类，两条路都会走错（实测都踩到过）：
 * - 拿演示源的 id 去问核心 → `common.not_found` / `插件未安装：mock`，
 *   榜单页把「核心没这个源」当成「源跑挂了」，界面只剩一句错误而不是演示数据；
 * - 反过来把核心的源当本地源找实现 → 找不到 → 空列表，或者**静默退回演示源**
 *   （用户以为在搜 A 源，拿到的其实是演示数据，比报错更糟）。
 *
 * 判定规则（`catalogService` / `libraryService` 共用）：
 * - 核心**认识**这个 id → 走核心命令；
 * - 核心不认识（或核心不可用）→ 走前端本地的实现。
 *
 * 缓存由两条路刷新：`libraryService.loadPlugins()`（读了 `plugin.list` 就记下来）
 * 与 [`ensureCoreSources`]（路由前的**按需刷新**，TTL 内不重复请求）。
 * 按需刷新是必要的：用户可能直接在搜索页输入关键词，从未打开过榜单/插件页，
 * 那时缓存还是空的——若不刷新，装好的插件会被误判成「本地源」。
 */

import type {PluginSummary} from '../api';
import type {TrackQuality} from '../types';
import {coreAvailable, corePlugin} from './core.bridge';

/** 核心最近一次报告的已安装插件（`null` = 核心不可用 / 读失败 / 还没读到过）。 */
let installed: PluginSummary[] | null = null;

/** 上次取清单的时间戳（含失败），用于 TTL 与失败退避 */
let lastAttempt = 0;

/** 同一时间的并发调用共用一次请求 */
let inflight: Promise<void> | null = null;

/** 清单的有效期：装完插件最多 5 秒后生效，避免每次路由都打一次 IPC */
const TTL_MS = 5_000;

/**
 * 记下核心报告的插件列表。
 *
 * `null` 表示「核心不认识任何源（不可用 / 读失败）」，此时所有 id 都按
 * 「核心不认识」处理——浏览器的演示源因此照常工作，桌面端核心掉线时
 * 也不会把请求发给空气。
 */
export function rememberCoreSources(list: PluginSummary[] | null): void {
    installed = list;
    lastAttempt = Date.now();
}

/**
 * 确保路由表是新鲜的；TTL 内直接返回，失败也会退避到下一个窗口再试。
 *
 * 所有**按源路由**的异步入口都先 await 它（`catalogService` 的 search / topList /
 * album / resolveUrl）。它是「尽力而为」的：核心读不到清单时按「没有核心源」处理，
 * 让界面继续用本地演示源跑起来，而不是抛错。
 */
export function ensureCoreSources(): Promise<void> {
    if (!coreAvailable()) {
        installed = null;
        return Promise.resolve();
    }
    if (Date.now() - lastAttempt < TTL_MS) return Promise.resolve();

    inflight ??= corePlugin
        .list()
        .then((result) => {
            installed = result.ok && result.data ? result.data : null;
        })
        .catch(() => {
            installed = null;
        })
        .finally(() => {
            lastAttempt = Date.now();
            inflight = null;
        });
    return inflight;
}

/**
 * 核心认识的音源 id。
 *
 * `enabledOnly` 为 true 时只保留核心侧标记为启用的插件——搜索要按这个集合下发
 * `sources`，否则会把用户已经停用的源也算进这一轮搜索。
 */
export function coreSourceIds(enabledOnly = false): string[] {
    if (!coreAvailable() || installed === null) return [];
    return installed.filter((plugin) => !enabledOnly || plugin.enabled).map((plugin) => plugin.id);
}

/** 这个音源是不是由核心提供的（核心不可用或清单里没有 → 走前端本地实现）。 */
export function isCoreSource(id: string): boolean {
    return coreAvailable() && installed !== null && installed.some((plugin) => plugin.id === id);
}

/**
 * 核心音源声明的音质档位（来自 `plugin.list` 的 manifest）。
 *
 * 前端注册表只装浏览器演示源，桌面上核心插件不在里面；只查注册表会得到空，
 * 播放/下载就只能按全局首选档位盲试。空数组表示“还没读到”，调用方应保留首选档位。
 */
export function coreSourceQualities(id: string): readonly TrackQuality[] {
    if (!coreAvailable() || installed === null) return [];
    const plugin = installed.find((item) => item.id === id);
    return plugin?.manifest?.qualities ?? [];
}

/**
 * 核心自带的**伪源**：本地文件。它不属于任何插件，但 `playback.resolve` 认这个前缀，
 * 由核心把文件挂到回环代理上（M3c 的本地播放链路）。
 */
export const CORE_LOCAL_SOURCE = 'local';

/**
 * 这个源能不能交给核心**播放**（`playback.resolve`）：装好的插件 + 核心自带的 `local`。
 *
 * 为什么要和 [`isCoreSource`] 分开：`local` 只对「播放」有意义——搜索、榜单、详情
 * 这些按源路由的命令它都不该参与（核心会回 not_found）。反过来，
 * 播放若按 `isCoreSource` 判定，本地文件就会被当成「前端源」去找插件实现 →
 * 找不到 → 退回静音时钟：**本地音乐永远播不响**（R29 的路由改动引入的回归，R34 才发现）。
 */
export function isCorePlayableSource(id: string): boolean {
    return id === CORE_LOCAL_SOURCE || isCoreSource(id);
}
