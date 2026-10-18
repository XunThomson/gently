import {store} from '../store';
import {activeLyricIndex} from '../utils/lyrics';
import type {PetContext, PetPlaybackSnapshot} from './types';

/** 从当前 store 取一份**只读**播放快照（宠物不接触内部状态与 action） */
export function petPlaybackSnapshot(): PetPlaybackSnapshot {
    const {player, ui} = store.getState();
    const active = activeLyricIndex(player.lyrics, player.elapsed + player.lyricsOffset);
    const line = active >= 0 ? player.lyrics[active] : undefined;
    const next = player.lyrics[active + 1];

    return {
        track: player.current
            ? {
                id: player.current.id,
                title: player.current.title,
                artist: player.current.artist,
                album: player.current.album,
                ...(player.current.artwork ? {artwork: player.current.artwork} : {}),
            }
            : null,
        playing: player.playing,
        elapsed: player.elapsed,
        duration: player.duration,
        lyric: line
            ? {
                text: line.text,
                ...(line.translation ? {translation: line.translation} : {}),
                next: next?.text ?? '',
            }
            : null,
        theme: ui.scheme,
    };
}

/** 给宠物用的上下文：读快照 + 订阅变化 */
export function createPetContext(): PetContext {
    return {
        getPlayback: petPlaybackSnapshot,
        subscribePlayback(listener) {
            return store.subscribe(() => {
                listener(petPlaybackSnapshot());
            });
        },
    };
}
