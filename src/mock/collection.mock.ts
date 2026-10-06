import type {Playlist, Track} from '../types';
import {makeTrack} from './track.mock';

/** 收藏与歌单的初始数据（mock；后续由持久化层替换） */

export const FAVORITE_TRACKS: Track[] = [0, 2, 5, 7].map((index) =>
    makeTrack(index, 'mock'),
);

export const PLAYLISTS: Playlist[] = [
    {
        id: 'pl:midnight',
        name: '深夜循环',
        createdAt: Date.now() - 6 * 86400000,
        tracks: [3, 4, 9].map((index) => makeTrack(index, 'mock')),
    },
    {
        id: 'pl:commute',
        name: '通勤路上',
        createdAt: Date.now() - 3 * 86400000,
        tracks: [1, 6, 8, 11].map((index) => makeTrack(index, 'mock')),
    },
];
