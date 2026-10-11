import {libraryService} from '../../services';
import type {CollectionActions, CollectionState, StoreCtx} from '../types';

let playlistSeq = 0;

const nextPlaylistId = () => `pl:${Date.now().toString(36)}${(++playlistSeq).toString(36)}`;

/**
 * 「还没拿到核心 id」的占位歌单 id。
 *
 * 桌面端歌单 id 由核心生成：本地先建一个占位 id 让界面立刻有反应，核心确认后再换成真 id。
 * 这段窗口期里**不能**拿占位 id 去写核心（核心只会回 `common.not_found`），
 * 所以 `persistPlaylist` 看到占位 id 就跳过——曲目变化由 create 那次写入或确认后的补写负责。
 */
const pendingCreateIds = new Set<string>();

/**
 * 收藏与歌单切片。
 * 当前以 Track 快照形式保存（mock 阶段）；后续接持久化时只需替换 services 层。
 */
export function createCollectionSlice(ctx: StoreCtx) {
    const state: CollectionState = {
        favorites: [],
        playlists: [],
        loaded: false,
    };

    const patch = (partial: Partial<CollectionState>) => {
        ctx.setState({collection: {...ctx.getState().collection, ...partial}});
    };

    const updatePlaylist = (id: string, updater: (tracks: CollectionState['playlists'][number]['tracks']) => CollectionState['playlists'][number]['tracks']) => {
        patch({
            playlists: ctx.getState().collection.playlists.map((playlist) =>
                playlist.id === id ? {...playlist, tracks: updater(playlist.tracks)} : playlist,
            ),
        });
    };

    /** 把当前歌单整体写回核心（歌单更新是「整体覆盖」语义，见契约 §4） */
    const persistPlaylist = (id: string) => {
        // 占位 id：核心还不认识这个歌单，写了只会得到 `common.not_found`（R40 实测过）
        if (pendingCreateIds.has(id)) return;
        const playlist = ctx.getState().collection.playlists.find((item) => item.id === id);
        if (playlist) void libraryService.savePlaylist({id, name: playlist.name, tracks: playlist.tracks});
    };

    const actions: CollectionActions = {
        async load() {
            if (ctx.getState().collection.loaded) return;
            const {favorites, playlists} = await libraryService.loadCollection();
            patch({favorites, playlists, loaded: true});
        },

        isFavorite(trackId) {
            return ctx.getState().collection.favorites.some((track) => track.id === trackId);
        },

        toggleFavorite(track) {
            const {favorites} = ctx.getState().collection;
            const favorite = !favorites.some((item) => item.id === track.id);
            // 乐观更新（界面立刻响应）+ 落到本机核心（桌面端）；
            // 浏览器端 coreSetFavorite 是安全空操作，mock 行为不变。
            patch({
                favorites: favorite
                    ? [track, ...favorites]
                    : favorites.filter((item) => item.id !== track.id),
            });
            void libraryService.setFavorite(track, favorite);
        },

        createPlaylist(name, tracks = []) {
            const playlist = {
                id: nextPlaylistId(),
                name: name.trim() || '新歌单',
                createdAt: Date.now(),
                tracks,
            };
            pendingCreateIds.add(playlist.id);
            patch({playlists: [playlist, ...ctx.getState().collection.playlists]});
            // 桌面端：让核心生成 id 并落库（**初值曲目一起带上**），然后用真实 id 替换本地占位，
            // 歌单与曲目在重启后仍在。
            void libraryService.savePlaylist({name: playlist.name, tracks}).then((saved) => {
                pendingCreateIds.delete(playlist.id);
                if (!saved) return;
                // 核心确认前用户可能又往里加了曲目：以**界面上的最新那份**为准显示，
                // 并且只有在核心那份不完整时才补写一次（正常路径不会有第二次写入）。
                const latest = ctx
                    .getState()
                    .collection.playlists.find((item) => item.id === playlist.id)?.tracks ?? saved.tracks;
                patch({
                    playlists: ctx
                        .getState()
                        .collection.playlists.map((item) =>
                            item.id === playlist.id ? {...saved, tracks: latest} : item,
                        ),
                });
                if (latest.length !== saved.tracks.length) {
                    void libraryService.savePlaylist({id: saved.id, name: saved.name, tracks: latest});
                }
            });
            return playlist;
        },

        renamePlaylist(id, name) {
            const trimmed = name.trim();
            if (!trimmed) return;
            patch({
                playlists: ctx.getState().collection.playlists.map((playlist) =>
                    playlist.id === id ? {...playlist, name: trimmed} : playlist,
                ),
            });
            const playlist = ctx.getState().collection.playlists.find((item) => item.id === id);
            if (playlist) void libraryService.savePlaylist({id, name: trimmed, tracks: playlist.tracks});
        },

        removePlaylist(id) {
            patch({playlists: ctx.getState().collection.playlists.filter((p) => p.id !== id)});
            void libraryService.deletePlaylist(id);
        },

        addToPlaylist(playlistId, track) {
            updatePlaylist(playlistId, (tracks) =>
                tracks.some((item) => item.id === track.id) ? tracks : [...tracks, track],
            );
            persistPlaylist(playlistId);
        },

        removeFromPlaylist(playlistId, trackId) {
            updatePlaylist(playlistId, (tracks) => tracks.filter((item) => item.id !== trackId));
            persistPlaylist(playlistId);
        },
    };

    return {key: 'collection' as const, state, actions};
}
