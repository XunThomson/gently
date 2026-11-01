import type {ColorScheme} from '../../theme';
import type {PetPlaybackSnapshot} from '../../pet';

/**
 * 主窗口 → 宠物窗口的**窗口间事件**载荷（不是核心契约事件）。
 *
 * 为什么是事件：两个窗口是独立的 WebView 上下文（各自一份 JS 堆），store 不共享；
 * 事件是最小、单向、不需要新契约的同步方式（与桌面歌词同一条路子）。
 *
 * 只推宠物真正会用的几个字段：宠物只读播放态，不参与播放控制。
 */
export interface PetWindowPayload {
    /**
     * 宠物是否启用（`ui.petEnabled`）。
     *
     * 宠物窗口在启动时就存在（`visible: false`），隐藏期间**不该继续跑动画**——
     * 20Hz 的 `pet.tick` 白烧电、还会一直写库。窗口据此决定挂不挂渲染器。
     */
    active: boolean;
    /** 是否在播放 */
    playing: boolean;
    /** 播放进度（秒）：宠物目前只把它传下去，不用它做条件 */
    elapsed: number;
    /** 当前是否有歌词行（`lyricActive` 条件） */
    lyricActive: boolean;
    /** 当前曲目 id 的哈希源（换歌 = `trackChanged` 条件） */
    trackId: string;
    /** 安装 / 切换 / 卸载宠物后 +1：宠物窗口据此重挂渲染器 */
    revision: number;
    /** 主题（气泡与将来换肤用；宠物窗口不自己判断主题） */
    theme: ColorScheme;
}

/** 空载荷：宠物窗口刚起来、还没收到主窗口的第一次推送时的状态 */
export const EMPTY_PET_PAYLOAD: PetWindowPayload = {
    active: false,
    playing: false,
    elapsed: 0,
    lyricActive: false,
    trackId: '',
    revision: 0,
    theme: 'light',
};

/** 载荷 → 宠物上下文里的只读快照（`core-pet` 只读这几位） */
export function payloadToSnapshot(payload: PetWindowPayload): PetPlaybackSnapshot {
    return {
        /* 宠物不认识 `Track` 的内部结构：只给 id（换歌判断）与占位显示字段 */
        track: payload.trackId
            ? {id: payload.trackId, title: '', artist: '', album: ''}
            : null,
        playing: payload.playing,
        elapsed: payload.elapsed,
        duration: 0,
        lyric: payload.lyricActive ? {text: '', next: ''} : null,
        theme: payload.theme,
    };
}
