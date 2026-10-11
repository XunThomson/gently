import {catalogService, libraryService} from '../../services';
import type {PluginActions, PluginState, StoreCtx} from '../types';

/**
 * 插件（音源）切片。
 *
 * 启用状态同时写入插件注册表（`catalogService`）——真正决定「哪些源参与聚合与自动回退」
 * 的是注册表，而不是这份 UI 列表；桌面端另外把状态落到本机核心（重启后仍在）。
 *
 * 卸载/启停/检查更新在**浏览器预览**里退回 mock 行为（无核心），桌面端一律以核心为准。
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
            void libraryService.setPluginEnabled(id, enabled);
        },

        remove(id) {
            const target = ctx.getState().plugin.list.find((p) => p.id === id);
            if (!target || target.builtin) return; // 内置源不可卸载
            catalogService.unregisterSource(id);
            patch({list: ctx.getState().plugin.list.filter((p) => p.id !== id)});
            void libraryService.removePlugin(id);
        },

        /**
         * 检查更新：桌面端与**来源**比对（URL / 订阅索引），只报告不自动更新；
         * 浏览器预览没有来源可比，沿用 mock 的「补丁位 +1」行为以保持界面可演示。
         */
        async update(id) {
            const checked = await libraryService.checkPluginUpdate(id);
            if (checked) {
                update(id, (p) => ({...p, version: checked.latest}));
                return;
            }

            update(id, (p) => {
                const [major, minor, patchNo] = p.version.split('.').map(Number);
                return {...p, version: `${major}.${minor}.${(patchNo || 0) + 1}`};
            });
        },
    };

    return {key: 'plugin' as const, state, actions};
}
