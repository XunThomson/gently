import {themeConfig} from '../../theme/tokens';
import {DEFAULT_PRESET_ID, themePresets} from '../../theme/presets';
import type {PersistedUi} from '../persist';
import type {UiActions, UiState, StoreCtx} from '../types';

/**
 * UI 切片：主题、侧边栏折叠、全局搜索词、音源展示偏好。
 * 主题与音源偏好的实际解析由 ThemeProvider / 视图完成，这里只保存用户选择（并持久化）。
 */
export function createUiSlice(ctx: StoreCtx, persisted: PersistedUi = {}) {
    const validPreset = themePresets.some((preset) => preset.id === persisted.themePresetId);
    const mode = persisted.themeMode ?? themeConfig.mode;

    const state: UiState = {
        themeMode: mode,
        themePresetId: validPreset ? (persisted.themePresetId as string) : DEFAULT_PRESET_ID,
        scheme: mode === 'dark' ? 'dark' : 'light',
        collapsedGroups: [],
        searchQuery: '',
        sourceDisplay: persisted.sourceDisplay ?? 'aggregate',
        sourceFilterStyle: persisted.sourceFilterStyle ?? 'tabs',
        sourceFilter: 'all',
        preferredSource: persisted.preferredSource ?? null,
        preferredQuality: persisted.preferredQuality ?? 'high',
    };

    const patch = (partial: Partial<UiState>) => {
        ctx.setState({ui: {...ctx.getState().ui, ...partial}});
    };

    const actions: UiActions = {
        setThemeMode(themeMode) {
            patch({themeMode});
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
        setSourceDisplay(sourceDisplay) {
            patch({sourceDisplay});
        },
        setSourceFilterStyle(sourceFilterStyle) {
            patch({sourceFilterStyle});
        },
        setSourceFilter(sourceFilter) {
            patch({sourceFilter});
        },
        setPreferredSource(preferredSource) {
            patch({preferredSource});
        },
        setPreferredQuality(preferredQuality) {
            patch({preferredQuality});
            // 音质偏好变化后立即重新解析当前曲目
            ctx.getActions().player.reloadSource();
        },
    };

    return {key: 'ui' as const, state, actions};
}
