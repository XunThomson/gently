import {DOWNLOAD_TASKS, INSTALLED_PLUGINS, LOCAL_TRACKS, RECENT_TRACKS} from '../mock/library.mock';
import {FAVORITE_TRACKS, PLAYLISTS} from '../mock/collection.mock';
import {makeLyrics} from '../mock/lyrics.mock';
import type {DownloadTask, LocalTrack, LyricLine, Playlist, PluginInfo, RecentTrack, Track} from '../types';

/**
 * 本地数据门面（本地曲库 / 最近播放 / 收藏歌单 / 下载 / 插件 / 歌词）。
 *
 * 目前由 mock 提供；后续替换为 Tauri 文件系统 / 数据库实现时，
 * 只需替换本文件的实现，UI 与 store 无需改动。
 */

const delay = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms));

export const libraryService = {
    async loadLocal(): Promise<LocalTrack[]> {
        await delay();
        return LOCAL_TRACKS;
    },

    async loadRecent(): Promise<RecentTrack[]> {
        await delay();
        return RECENT_TRACKS;
    },

    async loadCollection(): Promise<{favorites: Track[]; playlists: Playlist[]}> {
        await delay();
        return {favorites: [...FAVORITE_TRACKS], playlists: [...PLAYLISTS]};
    },

    async loadDownloads(): Promise<DownloadTask[]> {
        await delay();
        return DOWNLOAD_TASKS;
    },

    async loadPlugins(): Promise<PluginInfo[]> {
        await delay();
        return INSTALLED_PLUGINS;
    },

    async loadLyrics(track: Track): Promise<LyricLine[]> {
        await delay(80);
        return makeLyrics(track);
    },
};
