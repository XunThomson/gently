import {catalogService, coreAvailable, libraryService} from '../../services';
import {invalidateCoreSources} from '../../services/core.sources';
import type {PluginActions, PluginState, StoreCtx} from '../types';

/**
 * 插件（音源）切片。
 *
 * 启用状态同时写入插件注册表（`catalogService`）——真正决定「哪些源参与聚合与自动回退」
 * 的是注册表，而不是这份 UI 列表；桌面端另外把状态落到本机核心（重启后仍在）。
 *
 * **这份 `list` 是全局唯一的一份插件清单**：插件页、播放条音源选择器、页面音源筛选、
 * 设置页都订阅它，视图不再自己 `plugin.list` 一遍。因此任何改变插件集合的动作
 * （导入 / 卸载 / 启停 / 改优先级）都必须回到这里刷新，否则界面会停在旧清单上，
 * 用户只能重启应用才能看到刚导入的插件（R87 修的 bug）。
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

    /** 从核心重读清单，并**顺手刷新按源路由表**（`core.sources` 的缓存） */
    const refreshFromCore = async (): Promise<void> => {
        // 先标脏：即使下面这次读失败，下一次按源路由也会重新问核心
        invalidateCoreSources();
        const list = await libraryService.loadPlugins();
        // `loadPlugins()` 成功时已经把清单记进路由缓存；这里只需要落到 store
        patch({list: [...list], loaded: true});
    };

    const actions: PluginActions = {
        async load() {
            if (ctx.getState().plugin.loaded) return;
            await refreshFromCore();
        },

        /**
         * 强制重读清单：导入 / 卸载 / 启停 / 改优先级之后调用。
         *
         * 与 `load()` 的区别只有「跳过 loaded 守卫」——`load()` 是启动时的一次性加载，
         * 这里表达的是「核心那边已经变了，界面必须跟着变」。
         */
        reload() {
            return refreshFromCore();
        },

        setEnabled(id, enabled) {
            catalogService.setSourceEnabled(id, enabled);
            update(id, (p) => ({...p, enabled}));
            // 启用状态参与「哪些源参与搜索/回退」，路由表同样必须立即过期
            invalidateCoreSources();
            void libraryService.setPluginEnabled(id, enabled);
        },

        remove(id) {
            const target = ctx.getState().plugin.list.find((p) => p.id === id);
            if (!target || target.builtin) return; // 内置源不可卸载
            catalogService.unregisterSource(id);
            patch({list: ctx.getState().plugin.list.filter((p) => p.id !== id)});
            invalidateCoreSources();
            void libraryService.removePlugin(id);
        },

        /**
         * 检查更新：桌面端与**来源**比对（URL / 订阅索引），只报告不自动更新。
         *
         * 浏览器预览没有来源可比，沿用 mock 的「补丁位 +1」行为以保持界面可演示；
         * **核心在时绝不编造版本号**——那会让用户以为「有更新」，点下去却没有任何来源可更新。
         * 没有可比对的来源就什么都不做（按钮点了没反应，好过谎报有新版本）。
         */
        async update(id) {
            const checked = await libraryService.checkPluginUpdate(id);
            if (checked) {
                update(id, (p) => ({...p, version: checked.latest}));
                return;
            }
            if (coreAvailable()) return;

            update(id, (p) => {
                const [major, minor, patchNo] = p.version.split('.').map(Number);
                return {...p, version: `${major}.${minor}.${(patchNo || 0) + 1}`};
            });
        },
    };

    return {key: 'plugin' as const, state, actions};
}
