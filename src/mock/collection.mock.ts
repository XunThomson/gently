import type {Playlist, Track} from '../types';
import {makeTrack} from './track.mock';
import {appConfig} from '../config/app.config';

/** 收藏与歌单的初始数据（mock；后续由持久化层替换） */

const FAVORITE_INDEXES = [0, 2, 5, 7];

export const FAVORITE_TRACKS: Track[] = FAVORITE_INDEXES.slice(
    0,
    appConfig.mock.favoriteTracks,
).map((index) => makeTrack(index, 'mock'));

interface PlaylistSeed {
    id: string;
    name: string;
    /** 距今多少天创建 */
    createdDaysAgo: number;
    indexes: number[];
}

const PLAYLIST_SEEDS: PlaylistSeed[] = [
    {id: 'pl:midnight', name: '深夜循环', createdDaysAgo: 6, indexes: [3, 4, 9]},
    {id: 'pl:commute', name: '通勤路上', createdDaysAgo: 3, indexes: [1, 6, 8, 11]},
];

export const PLAYLISTS: Playlist[] = PLAYLIST_SEEDS.slice(0, appConfig.mock.playlistCount).map(
    (seed, i) => ({
        id: seed.id,
        name: seed.name,
        createdAt: Date.now() - seed.createdDaysAgo * 86400000,
        tracks: seed.indexes
            .slice(0, appConfig.mock.playlistTrackCounts[i] ?? seed.indexes.length)
            .map((index) => makeTrack(index, 'mock')),
    }),
);
