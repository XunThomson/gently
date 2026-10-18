import type {ColorScheme} from '../theme';
import type {Track} from '../types';

/**
 * 桌面宠物扩展点（2.x 预留，当前不渲染任何宠物）。
 *
 * 设计约束（见 `docs/adr/0007-versioning-and-pet-extension.md`）：
 * - 宠物是**纯本地 UI 扩展**：不联网、不上报、不读写用户文件；需要外部能力时必须走既有
 *   `services/**` 门面，且由用户动作触发；
 * - 宠物只消费**只读**播放快照，不直接改播放器状态（避免一个装饰性扩展影响播放）；
 * - 生命周期 `mount → dispose`；宠物自己负责容器内的 DOM / 动画，宿主只给一个容器和上下文。
 */

/** 宠物能看到的播放状态（只读快照；不含队列与音源内部细节） */
export interface PetPlaybackSnapshot {
    track: Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'artwork'> | null;
    playing: boolean;
    elapsed: number;
    duration: number;
    /** 当前行 / 下一行（没有歌词时为 null） */
    lyric: {text: string; translation?: string; next: string} | null;
    theme: ColorScheme;
}

/** 宿主注入给宠物的上下文 */
export interface PetContext {
    getPlayback(): PetPlaybackSnapshot;
    /** 订阅播放快照变化；返回退订函数 */
    subscribePlayback(listener: (snapshot: PetPlaybackSnapshot) => void): () => void;
}

/** `mount` 的返回值：宿主卸载时调用 `dispose` */
export interface PetInstance {
    dispose(): void;
}

/** 一个桌面宠物（2.x 由内置或用户导入的实现提供） */
export interface PetDefinition {
    /** 稳定 id（小写、短横线），用于替换与持久化 */
    id: string;
    name: string;
    version: string;
    /** 在宿主提供的容器里创建宠物；抛错只会跳过该宠物，不影响应用 */
    mount(container: HTMLElement, context: PetContext): PetInstance;
}
