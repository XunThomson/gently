import {createStore, shallowEqual, useStore, type StoreApi} from './createStore';
import {readPersistedUi, writePersistedUi} from './persist';
import {createCollectionSlice} from './slices/collection.slice';
import {createDownloadSlice} from './slices/download.slice';
import {createLibrarySlice} from './slices/library.slice';
import {createPlayerSlice} from './slices/player.slice';
import {createPluginSlice} from './slices/plugin.slice';
import {createRankingSlice} from './slices/ranking.slice';
import {createUiSlice} from './slices/ui.slice';
import type {RootActions, RootState, StoreCtx} from './types';

/**
 * 应用唯一的集中式状态树。
 *
 * 设计约定：
 * - 每个 domain 一个切片（state + actions），切片之间只通过 ctx.getActions() 交互；
 * - 组件只通过下面的 selector hooks 订阅自己关心的数据，避免无效重渲染；
 * - 需要衍生数据时在 selector 中计算，或放到 services 层，state 只存事实；
 * - 需要跨启动保留的偏好（主题模式 / 主题预设）由 persist 层落 localStorage。
 */

let store!: StoreApi<RootState>;
let rootActions!: RootActions;

const ctx: StoreCtx = {
    getState: () => store.getState(),
    setState: (patch) => store.setState(patch),
    getActions: () => rootActions,
};

const persisted = readPersistedUi();

const ui = createUiSlice(ctx, persisted);
const player = createPlayerSlice(ctx);
const ranking = createRankingSlice(ctx);
const download = createDownloadSlice(ctx);
const plugin = createPluginSlice(ctx);
const library = createLibrarySlice(ctx);
const collection = createCollectionSlice(ctx);

store = createStore<RootState>({
    ui: ui.state,
    player: player.state,
    ranking: ranking.state,
    download: download.state,
    plugin: plugin.state,
    library: library.state,
    collection: collection.state,
});

rootActions = {
    ui: ui.actions,
    player: player.actions,
    ranking: ranking.actions,
    download: download.actions,
    plugin: plugin.actions,
    library: library.actions,
    collection: collection.actions,
};

/* 偏好持久化：只在真正变化时写入，避免每秒进度更新触发 localStorage 写 */
let lastPersistedKey = '';
store.subscribe(() => {
    const {themeMode, themePresetId, sourceDisplay, sourceFilterStyle, preferredSource, preferredQuality} =
        store.getState().ui;
    const key = [
        themeMode,
        themePresetId,
        sourceDisplay,
        sourceFilterStyle,
        preferredSource ?? '',
        preferredQuality,
    ].join('|');
    if (key === lastPersistedKey) return;
    lastPersistedKey = key;
    writePersistedUi({
        themeMode,
        themePresetId,
        sourceDisplay,
        sourceFilterStyle,
        preferredSource,
        preferredQuality,
    });
});

export {store, shallowEqual};

/** 命令（actions）对象引用恒定，无需订阅 */
export const useActions = (): RootActions => rootActions;

/** 读取任意派生数据 */
export function useSelect<S>(
    selector: (state: RootState) => S,
    isEqual?: (a: S, b: S) => boolean,
): S {
    return useStore(store, selector, isEqual);
}

export const useUiState = () => useStore(store, (s) => s.ui);
export const usePlayerState = () => useStore(store, (s) => s.player);
export const useRankingState = () => useStore(store, (s) => s.ranking);
export const useDownloadState = () => useStore(store, (s) => s.download);
export const usePluginState = () => useStore(store, (s) => s.plugin);
export const useLibraryState = () => useStore(store, (s) => s.library);
export const useCollectionState = () => useStore(store, (s) => s.collection);

export type {RootState, RootActions} from './types';
