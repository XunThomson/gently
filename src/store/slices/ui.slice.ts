import {themeConfig} from '../../theme/tokens';
import {DEFAULT_PRESET_ID, themePresets} from '../../theme/presets';
import type {PersistedUi} from '../persist';
import type {UiActions, UiState, StoreCtx} from '../types';

/**
 * UI 切片：主题模式 / 主题市场预设 / 侧边栏折叠 / 全局搜索词。
 * 主题的实际配色解析由 ThemeProvider 完成，这里只保存用户选择（并持久化）。
 */
export function createUiSlice(ctx: StoreCtx, persisted: PersistedUi = {}) {
    const validPreset = themePresets.some((preset) => preset.id === persisted.themePresetId);

    const state: UiState = {
        themeMode: persisted.themeMode ?? themeConfig.mode,
        themePresetId: validPreset ? (persisted.themePresetId as string) : DEFAULT_PRESET_ID,
        scheme: (persisted.themeMode ?? themeConfig.mode) === 'dark' ? 'dark' : 'light',
        collapsedGroups: [],
        searchQuery: '',
    };

    const patch = (partial: Partial<UiState>) => {
        ctx.setState({ui: {...ctx.getState().ui, ...partial}});
    };

    const actions: UiActions = {
        setThemeMode(mode) {
            patch({themeMode: mode});
        },
        setThemePreset(themePresetId) {
            patch({themePresetId});
        },
        setScheme(scheme) {
            if (ctx.getState().ui.scheme === scheme) return;
            patch({scheme});
        },
        toggleGroup(key) {
            const {collapsedGroups} = ctx.getState().ui;
            patch({
                collapsedGroups: collapsedGroups.includes(key)
                    ? collapsedGroups.filter((k) => k !== key)
                    : [...collapsedGroups, key],
            });
        },
        isGroupCollapsed(key) {
            return ctx.getState().ui.collapsedGroups.includes(key);
        },
        setSearchQuery(searchQuery) {
            patch({searchQuery});
        },
    };

    return {key: 'ui' as const, state, actions};
}
