import {libraryService} from '../../services';
import type {CollectionActions, CollectionState, StoreCtx} from '../types';

let playlistSeq = 0;

const nextPlaylistId = () => `pl:${Date.now().toString(36)}${(++playlistSeq).toString(36)}`;

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
            patch({
                favorites: favorites.some((item) => item.id === track.id)
                    ? favorites.filter((item) => item.id !== track.id)
                    : [track, ...favorites],
            });
        },

        createPlaylist(name) {
            const playlist = {
                id: nextPlaylistId(),
                name: name.trim() || '新歌单',
                createdAt: Date.now(),
                tracks: [],
            };
            patch({playlists: [playlist, ...ctx.getState().collection.playlists]});
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
        },

        removePlaylist(id) {
            patch({playlists: ctx.getState().collection.playlists.filter((p) => p.id !== id)});
        },

        addToPlaylist(playlistId, track) {
            updatePlaylist(playlistId, (tracks) =>
                tracks.some((item) => item.id === track.id) ? tracks : [...tracks, track],
            );
        },

        removeFromPlaylist(playlistId, trackId) {
            updatePlaylist(playlistId, (tracks) => tracks.filter((item) => item.id !== trackId));
        },
    };

    return {key: 'collection' as const, state, actions};
}
