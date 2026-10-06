import {libraryService} from '../../services';
import type {PluginActions, PluginState, StoreCtx} from '../types';

/** 插件（数据源）切片 */
export function createPluginSlice(ctx: StoreCtx) {
    const state: PluginState = {list: [], loaded: false};

    const patch = (partial: Partial<PluginState>) => {
        ctx.setState({plugin: {...ctx.getState().plugin, ...partial}});
    };

    const update = (id: string, updater: (p: PluginState['list'][number]) => PluginState['list'][number]) => {
        patch({list: ctx.getState().plugin.list.map((p) => (p.id === id ? updater(p) : p))});
    };

    const actions: PluginActions = {
        async load() {
            if (ctx.getState().plugin.loaded) return;
            const list = await libraryService.loadPlugins();
            patch({list: [...list], loaded: true});
        },

        setEnabled(id, enabled) {
            update(id, (p) => ({...p, enabled}));
        },

        remove(id) {
            patch({list: ctx.getState().plugin.list.filter((p) => p.id !== id || p.builtin)});
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
