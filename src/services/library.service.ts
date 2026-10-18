import {DOWNLOAD_TASKS, getInstalledPlugins, LOCAL_TRACKS, RECENT_TRACKS} from '../mock/library.mock';
import {FAVORITE_TRACKS, PLAYLISTS} from '../mock/collection.mock';
import {makeLyrics} from '../mock/lyrics.mock';
import {appConfig} from '../config/app.config';
import type {
    DownloadTask,
    LocalTrack,
    LyricLine,
    Playlist,
    PluginInfo,
    RecentTrack,
    Track,
    TrackQuality,
} from '../types';
import type {CoreResult, LocalScanResult, PluginUpdateCheck} from '../api';
import {coreAvailable, corePlugin} from './core.bridge';
import {coreLyrics} from './core.catalog';
import {corePluginCheckUpdate} from './core.plugin';
import {isCoreSource, rememberCoreSources} from './core.sources';
import {
    coreClearFinishedDownloads,
    coreCreateDownload,
    coreListenDownloads,
    corePauseDownload,
    coreRemoveDownload,
    coreResumeDownload,
    type DownloadHandlers,
} from './core.download';
import {
    coreClearHistory,
    coreDeletePlaylist,
    coreListenScanProgress,
    coreLoadDownloads,
    coreLoadFavorites,
    coreLoadLocal,
    coreLoadPlaylists,
    coreLoadRecent,
    corePlaybackReport,
    coreRemoveLocal,
    coreSavePlaylist,
    coreScanLocal,
    coreSetFavorite,
    coreRecommendFeedback,
    trackRefOf,
} from './core.library';
import {toLyricLines} from '../utils/lyrics';

/**
 * 本地数据门面（本地曲库 / 最近播放 / 收藏歌单 / 下载 / 插件 / 歌词）。
 *
 * **桌面端以本机核心为准，只有「没有核心」（浏览器预览）才退回 mock**——与
 * `catalogService` 同一套策略，因此视图与 store 不需要分支，浏览器预览行为与改造前一致。
 *
 * 这里的分界线很关键：`coreLoadX()` 返回 `null` 有**两种**含义——「没有核心」与
 * 「核心报错了」，两者不能用同一个 fallback 处理。核心在却读失败时退回 mock，
 * 用户看到的会是**别人的假数据冒充自己的收藏/歌单/下载**（比空列表糟得多），
 * 所以 mock 只在 `!coreAvailable()` 时出现（`loadLyrics` 一直是这么做的，见下）。
 *
 * 写入同理：核心可用时落库，不可用时是**安全空操作**（store 已经做了乐观更新，
 * 下一次 `load()` 会以核心为准）。
 */

const delay = (ms: number = appConfig.latency.libraryMs) =>
    new Promise<void>((r) => setTimeout(r, ms));

export const libraryService = {
    async loadLocal(): Promise<LocalTrack[]> {
        const viaCore = await coreLoadLocal();
        if (viaCore) return viaCore;
        if (coreAvailable()) return [];
        await delay();
        return LOCAL_TRACKS;
    },

    async loadRecent(): Promise<RecentTrack[]> {
        const viaCore = await coreLoadRecent();
        if (viaCore) return viaCore;
        if (coreAvailable()) return [];
        await delay();
        return RECENT_TRACKS;
    },

    async loadCollection(): Promise<{favorites: Track[]; playlists: Playlist[]}> {
        const [favorites, playlists] = await Promise.all([coreLoadFavorites(), coreLoadPlaylists()]);
        if (favorites || playlists) {
            return {favorites: favorites ?? [], playlists: playlists ?? []};
        }
        if (coreAvailable()) return {favorites: [], playlists: []};
        await delay();
        return {favorites: [...FAVORITE_TRACKS], playlists: [...PLAYLISTS]};
    },

    async loadDownloads(): Promise<DownloadTask[]> {
        const viaCore = await coreLoadDownloads();
        if (viaCore) return viaCore;
        if (coreAvailable()) return [];
        await delay();
        return DOWNLOAD_TASKS;
    },

    /**
     * 扫描本地目录并入库（`library.local.scan`）。
     *
     * 长任务：进度经 `library:scan.progress` 事件推送（见 `scanLocal` 的订阅方 `listenScanProgress`），
     * 返回的是**统计结果**（新增/更新/移除/跳过/读不了），界面据此说明这次扫描做了什么。
     * 浏览器没有核心，返回 `common.unsupported_platform` 失败——界面据此不显示扫描入口。
     */
    scanLocal(dirs: string[], recursive = true): Promise<CoreResult<LocalScanResult>> {
        return coreScanLocal(dirs, recursive);
    },

    /** 订阅扫描进度；浏览器/没有核心时是安全空操作。 */
    listenScanProgress(handler: (progress: {dir: string; found: number; percent?: number}) => void): Promise<() => void> {
        return coreListenScanProgress(handler);
    },

    /**
     * 推荐反馈（`recommend.feedback`）：**弱信号**，核心在下次打分时消费。
     *
     * 为什么界面必须显式上报：「听了 10 秒就切走」这件事核心自己看不到——
     * 画像只消费播放次数与时间（`build_taste` 不看 `playedSec`），
     * 不报的话它在画像里和「完整听完」没有区别。`skip` 的 `progress` 决定它是负信号还是噪音
     * （核心只认 `< 0.5` 的跳过）。
     */
    recommendFeedback(
        track: Track,
        action: 'play' | 'skip' | 'like' | 'unlike' | 'complete',
        progress?: number,
    ): Promise<void> {
        return coreRecommendFeedback(track, action, progress).then(() => undefined);
    },

    /**
     * 已安装插件列表。
     *
     * 桌面端以**本机核心**为准：核心返回的 `PluginSummary` 与 `PluginInfo` 同形
     * （`builtin` 恒为 false——我们不预置任何插件，ADR-0005），因此不需要额外映射。
     * 同时把核心的这份清单记进 `core.sources` 缓存——`catalogService` 靠它判断
     * 「这个音源该问核心还是走前端本地实现」。
     *
     * **核心在时只回核心那一份**：内置演示源与占位项（`qqmusic` / `kugou`）都是
     * 前端 mock（`src/mock/library.mock.ts`），把它们混进桌面端的插件列表就是
     * 「拿 mock 冒充用户数据」——用户会以为装了这些源，点进去却什么都没有。
     * 核心读失败时同样如实返回空（并 `console.warn` 说明原因），不退回演示列表。
     *
     * 演示列表只在**没有核心**（浏览器预览）时出现。
     */
    async loadPlugins(): Promise<PluginInfo[]> {
        const list = await corePlugin.list();
        if (list.ok && list.data) {
            rememberCoreSources(list.data);
            return list.data;
        }
        if (coreAvailable()) {
            rememberCoreSources(null);
            console.warn(
                '[library] 核心在但 plugin.list 读失败，插件列表按空处理（不退回演示数据）',
                list.ok ? '未返回数据' : `${list.error.code}：${list.error.message}`,
            );
            return [];
        }
        rememberCoreSources(null);
        await delay();
        return getInstalledPlugins();
    },

    /**
     * 歌词。
     *
     * **桌面端以核心为准**：`catalog.lyrics` 走插件（`getLyric`），没有就是没有——
     * 不拿生成出来的假歌词糊弄用户。浏览器预览没有插件，才用 mock 生成（页面形状一致）。
     * 核心给的是**原文**（LRC 或纯文本），解析成行由 `src/utils/lyrics.ts` 完成。
     *
     * 只有**核心认识的插件源**才值得问核心：本地文件（`local`）与内置演示源根本没有插件，
     * 问了只会拿到 `common.not_found`，还在日志里留下一条误导人的「插件未安装：local」（实测见过）。
     */
    async loadLyrics(track: Track): Promise<LyricLine[]> {
        if (isCoreSource(track.source)) {
            const viaCore = await coreLyrics(trackRefOf(track).id, true);
            if (viaCore) return toLyricLines(viaCore);
        }
        if (coreAvailable()) return [];

        await delay(appConfig.latency.lyricsMs);
        return makeLyrics(track);
    },

    /**
     * 按**引用**取歌词（`source:rawId`，可以不是当前曲目自己的源）。
     *
     * 用于恢复用户手动挑过的那一份歌词（`utils/lyricsSyncCache.ts` 的 `appliedLyricsRef`）。
     * 取不到就返回 `null`——插件被卸载、源不再给词、或根本没有核心，都由调用方退回
     * 「源自动给的词」，而不是把空歌词当成「这首没有词」写进播放状态。
     */
    async loadLyricsFrom(reference: string): Promise<LyricLine[] | null> {
        if (!coreAvailable() || !reference.includes(':')) return null;
        const viaCore = await coreLyrics(reference, true);
        if (!viaCore) return null;
        const lines = toLyricLines(viaCore);
        return lines.length > 0 ? lines : null;
    },

    /* ---------------- 写入（桌面端落核心；浏览器端安全空操作） ---------------- */

    /** 收藏/取消收藏（带上曲目快照，插件被卸载后收藏列表仍能显示） */
    async setFavorite(track: Track, favorite: boolean): Promise<void> {
        await coreSetFavorite(track, favorite);
    },

    /** 新建或整体覆盖歌单；返回核心生成的歌单（浏览器端返回 null，由调用方用本地 id） */
    savePlaylist(input: {id?: string; name: string; tracks: Track[]}): Promise<Playlist | null> {
        return coreSavePlaylist(input);
    },

    async deletePlaylist(id: string): Promise<void> {
        await coreDeletePlaylist(id);
    },

    /**
     * 上报一次**真实播放**：调用方在「放完/切走/暂停/停止」时调用，
     * 带上实际播成的音源与真实秒数（`playback.report`，与 `library.history.push` 同一份历史）。
     *
     * 前端**只有这一条**写历史的路径——`library.history.push` 是核心侧的原始原语，
     * 由 `playback.report` 复用（见契约 §2），前端再包一份只会让播放次数被记两次。
     */
    async reportPlay(
        track: Track,
        input: {source?: string; quality?: string; playedSec?: number; completed?: boolean} = {},
    ): Promise<void> {
        await corePlaybackReport(track, input);
    },

    async clearHistory(): Promise<void> {
        await coreClearHistory();
    },

    /** 从曲库移除本地曲目（缺省**不删磁盘文件**：删除必须由用户在二次确认里明确选择） */
    async removeLocal(id: string, deleteFile = false): Promise<void> {
        await coreRemoveLocal(id, deleteFile);
    },

    /* ---------------- 插件管理（桌面端落核心；浏览器端是安全空操作） ---------------- */

    /** 与来源比对版本/校验和（只检查，不自动更新）；`null` 表示无从比对或没有核心 */
    checkPluginUpdate(id: string): Promise<PluginUpdateCheck | null> {
        return corePluginCheckUpdate(id);
    },

    async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
        // 内置演示源只活在前端注册表（`src/plugins`）里，核心不认识这个名字：
        // 发过去只会换回一条 `common.not_found`，还会把日志弄得像出了故障
        if (!isCoreSource(id)) return;
        await corePlugin.setEnabled(id, enabled);
    },

    /**
     * 回退优先级：数值越小越优先（决定播放候选顺序）。
     *
     * 内置演示源不在核心里 → 直接返回成功（界面的「上移/下移」不该因为它弹一条 not_found）。
     */
    setPluginPriority(id: string, priority: number): Promise<CoreResult<unknown>> {
        if (!isCoreSource(id)) return Promise.resolve({ok: true, data: null, traceId: 'client'});
        return corePlugin.setPriority(id, priority);
    },

    /** 卸载插件；`deleteFiles` 缺省为 true（核心侧默认连文件一起删） */
    async removePlugin(id: string, deleteFiles = true): Promise<void> {
        if (!isCoreSource(id)) return;
        await corePlugin.remove(id, deleteFiles);
    },

    /* ---------------- 下载（长任务：命令 + 事件） ---------------- */

    /**
     * 交给核心建下载任务；返回信封（浏览器端是 `common.unsupported_platform` 失败，
     * 调用方据此退回模拟进度；其他失败码要显示给用户，见 `download.slice`）。
     *
     * `dir` 是设置页里的下载目录：空/未传 → 核心默认目录（`<data>/downloads`）。
     */
    createDownload(
        track: Track,
        quality: TrackQuality = 'standard',
        dir?: string,
    ): Promise<CoreResult<DownloadTask>> {
        return coreCreateDownload(track, quality, dir);
    },

    async pauseDownload(id: string): Promise<void> {
        await corePauseDownload(id);
    },

    async resumeDownload(id: string): Promise<void> {
        await coreResumeDownload(id);
    },

    async removeDownload(id: string, deleteFile = false): Promise<void> {
        await coreRemoveDownload(id, deleteFile);
    },

    async clearFinishedDownloads(): Promise<void> {
        await coreClearFinishedDownloads();
    },

    /** 订阅下载进度/完成/失败事件（浏览器端是空操作，返回空退订函数） */
    listenDownloads(handlers: DownloadHandlers): Promise<() => void> {
        return coreListenDownloads(handlers);
    },
};
