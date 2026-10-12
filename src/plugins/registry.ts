import type {PluginInfo, TrackQuality} from '../types';
import type {MusicSourcePlugin} from './types';

const registry = new Map<string, MusicSourcePlugin>();

/**
 * 启用状态：注册表是「哪个音源可用」的唯一来源。
 * 不直接改插件自带的 `info.enabled`，避免污染插件元数据。
 */
const enabledState = new Map<string, boolean>();

/** 注册（或覆盖）一个音乐源插件 */
export function registerMusicSource(plugin: MusicSourcePlugin): void {
    if (!plugin?.info?.id) {
        console.warn('[plugins] 非法音乐源：缺少 info.id');
        return;
    }
    registry.set(plugin.info.id, plugin);
    if (!enabledState.has(plugin.info.id)) {
        enabledState.set(plugin.info.id, plugin.info.enabled);
    }
}

export function getMusicSource(id: string): MusicSourcePlugin | undefined {
    return registry.get(id);
}

/** 卸载音源（内置源由调用方拦截） */
export function unregisterMusicSource(id: string): void {
    registry.delete(id);
    enabledState.delete(id);
}

export function listMusicSources(): MusicSourcePlugin[] {
    return [...registry.values()];
}

export function isMusicSourceEnabled(id: string): boolean {
    return enabledState.get(id) ?? false;
}

/** 启用 / 停用音源；停用后不再参与聚合与自动回退 */
export function setMusicSourceEnabled(id: string, enabled: boolean): void {
    if (!registry.has(id)) return;
    enabledState.set(id, enabled);
}

export function listEnabledMusicSources(): MusicSourcePlugin[] {
    return listMusicSources().filter((plugin) => isMusicSourceEnabled(plugin.info.id));
}

/** 供 UI 展示的插件元数据（enabled 取注册表状态） */
export function listMusicSourceInfos(): PluginInfo[] {
    return listMusicSources().map((plugin) => ({
        ...plugin.info,
        enabled: isMusicSourceEnabled(plugin.info.id),
    }));
}

export function getMusicSourceQualities(id: string): readonly TrackQuality[] {
    return registry.get(id)?.qualities ?? [];
}

/**
 * 当前生效的音乐源：第一个已启用的插件；**一个都没有时返回 `undefined`**。
 *
 * 「桌面上一个音源都没装」是**正常状态**，不是异常：以前这里 `throw`，
 * 调用方（设置页）在渲染期直接抛出，而应用没有错误边界——整页白屏。
 * 空列表由调用方按空态呈现（设置页显示「还没有安装任何插件」），
 * 与「源可用」是两条不同的路。
 *
 * 仅用于「单源」调用（如本地库），聚合场景请使用 `listEnabledMusicSources`。
 */
export function getActiveMusicSource(): MusicSourcePlugin | undefined {
    return listEnabledMusicSources()[0] ?? listMusicSources()[0];
}
