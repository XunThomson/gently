import type {MusicSourcePlugin} from './types';

const registry = new Map<string, MusicSourcePlugin>();

/** 注册（或覆盖）一个音乐源插件 */
export function registerMusicSource(plugin: MusicSourcePlugin): void {
    if (!plugin?.info?.id) {
        console.warn('[plugins] 非法音乐源：缺少 info.id');
        return;
    }
    registry.set(plugin.info.id, plugin);
}

export function getMusicSource(id: string): MusicSourcePlugin | undefined {
    return registry.get(id);
}

export function listMusicSources(): MusicSourcePlugin[] {
    return [...registry.values()];
}

/**
 * 当前生效的音乐源：第一个已启用的插件。
 * 后续 plugin 管理界面切换启用状态时，这里的结果会同步变化。
 */
export function getActiveMusicSource(): MusicSourcePlugin {
    const active = listMusicSources().find((p) => p.info.enabled);
    if (active) return active;

    const fallback = listMusicSources()[0];
    if (!fallback) throw new Error('[plugins] 没有可用的音乐源');
    return fallback;
}
