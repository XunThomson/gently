import {themeConfig} from '../../theme/tokens';
import type {UiActions, UiState, StoreCtx} from '../types';

/**
 * UI 切片：主题模式、侧边栏折叠等「外壳」状态。
 * 主题的实际配色解析由 ThemeProvider 完成，这里只保存用户选择。
 */
export function createUiSlice(ctx: StoreCtx) {
    const state: UiState = {
        themeMode: themeConfig.mode,
        scheme: themeConfig.mode === 'dark' ? 'dark' : 'light',
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
