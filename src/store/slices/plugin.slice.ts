import {catalogService, libraryService} from '../../services';
import type {PluginActions, PluginState, StoreCtx} from '../types';

/**
 * 插件（音源）切片。
 *
 * 启用状态同时写入插件注册表（`catalogService`），
 * 因为真正决定「哪些源参与聚合与自动回退」的是注册表，而不是这份 UI 列表。
 */
export function createPluginSlice(ctx: StoreCtx) {
    const state: PluginState = {list: [], loaded: false};

    const patch = (partial: Partial<PluginState>) => {
        ctx.setState({plugin: {...ctx.getState().plugin, ...partial}});
    };

    const update = (
        id: string,
        updater: (p: PluginState['list'][number]) => PluginState['list'][number],
    ) => {
        patch({list: ctx.getState().plugin.list.map((p) => (p.id === id ? updater(p) : p))});
    };

    const actions: PluginActions = {
        async load() {
            if (ctx.getState().plugin.loaded) return;
            const list = await libraryService.loadPlugins();
            patch({list: [...list], loaded: true});
        },

        setEnabled(id, enabled) {
            catalogService.setSourceEnabled(id, enabled);
            update(id, (p) => ({...p, enabled}));
        },

        remove(id) {
            const target = ctx.getState().plugin.list.find((p) => p.id === id);
            if (!target || target.builtin) return; // 内置源不可卸载
            catalogService.unregisterSource(id);
            patch({list: ctx.getState().plugin.list.filter((p) => p.id !== id)});
        },

        /** mock：把补丁位版本号 +1，代表一次更新 */
        update(id) {
            update(id, (p) => {
                const [major, minor, patchNo] = p.version.split('.').map(Number);
                return {...p, version: `${major}.${minor}.${(patchNo || 0) + 1}`};
            });
        },
    };

    return {key: 'plugin' as const, state, actions};
}
