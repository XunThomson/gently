import {appConfig} from '../../config/app.config';
import {skinService} from '../../services';
import {activeUserSkinId, resolveActivePreset} from '../../theme';
import {themeConfig} from '../../theme/tokens';
import {DEFAULT_PRESET_ID, themePresets} from '../../theme/presets';
import type {PersistedUi} from '../persist';
import type {UiActions, UiState, StoreCtx} from '../types';

/**
 * UI 切片：主题、侧边栏折叠、全局搜索词、音源展示偏好。
 * 主题与音源偏好的实际解析由 ThemeProvider / 视图完成，这里只保存用户选择（并持久化）。
 */
export function createUiSlice(ctx: StoreCtx, persisted: PersistedUi = {}) {
    const customSkins = persisted.customSkins ?? [];
    const validPreset = [...themePresets, ...customSkins].some(
        (preset) => preset.id === persisted.themePresetId,
    );
    const mode = persisted.themeMode ?? themeConfig.mode;

    /** 并发数是设置页的一档档选项：越界/坏值一律钳回合法区间，不把 NaN 存进状态 */
    const clampConcurrent = (value: number): number => {
        if (!Number.isFinite(value)) return appConfig.download.maxConcurrent;
        const options = appConfig.download.maxConcurrentOptions;
        const min = Math.min(...options);
        const max = Math.max(...options);
        return Math.min(max, Math.max(min, Math.round(value)));
    };

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
        confirmDestructive: persisted.confirmDestructive ?? true,
        downloadDir: persisted.downloadDir ?? '',
        downloadQuality: persisted.downloadQuality ?? appConfig.download.defaultQuality,
        downloadQualityFallback:
            persisted.downloadQualityFallback ?? appConfig.download.defaultQualityFallback,
        downloadMaxConcurrent: clampConcurrent(
            persisted.downloadMaxConcurrent ?? appConfig.download.maxConcurrent,
        ),
        customSkins,
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

            /* 核心的 `meta.skin.active` 只记录**用户皮肤**：内置预设随前端包发布，
               核心的 `skins` 表里没有它们。因此选内置预设时要把用户皮肤的激活标记清掉
               （`null` = 恢复默认主题），而不是把一个核心不认识的 id 发过去——
               那只会换来一条必然失败的 `skin.not_found`。 */
            const {customSkins} = ctx.getState().ui;
            const isUserSkin = customSkins.some((skin) => skin.id === themePresetId);
            void skinService.setActive(isUserSkin ? themePresetId : null);
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
        setConfirmDestructive(confirmDestructive) {
            patch({confirmDestructive});
        },
        setDownloadDir(downloadDir) {
            patch({downloadDir});
        },
        setDownloadQuality(downloadQuality) {
            patch({downloadQuality});
        },
        setDownloadQualityFallback(downloadQualityFallback) {
            patch({downloadQualityFallback});
        },
        setDownloadMaxConcurrent(downloadMaxConcurrent) {
            patch({downloadMaxConcurrent: clampConcurrent(downloadMaxConcurrent)});
        },
        installSkin(skin) {
            const {customSkins} = ctx.getState().ui;
            patch({
                customSkins: customSkins.some((item) => item.id === skin.id)
                    ? customSkins.map((item) => (item.id === skin.id ? skin : item))
                    : [...customSkins, skin],
                // 导入后立即应用，符合「导入即预览」的直觉
                themePresetId: skin.id,
            });
        },
        removeSkin(skinId) {
            const {customSkins, themePresetId} = ctx.getState().ui;
            patch({
                customSkins: customSkins.filter((item) => item.id !== skinId),
                // 删掉正在使用的皮肤时回到默认
                themePresetId: themePresetId === skinId ? DEFAULT_PRESET_ID : themePresetId,
            });
            void skinService.remove(skinId);
        },

        /**
         * 桌面端皮肤以**本机核心**为准（`skin.list`）：导入的皮肤存在核心的库里，
         * localStorage 里那份只是浏览器预览用的。核心不可用时保持现状。
         *
         * 同时按核心的 `active` 标记**纠正当前选中的预设**：换了机器 / 清了 localStorage
         * 之后，本地记的 id 可能已经失效，而核心知道用户真正选过哪套。
         */
        async loadSkins() {
            const viaCore = await skinService.load();
            if (!viaCore) return;

            const {themePresetId} = ctx.getState().ui;
            patch({
                customSkins: viaCore,
                themePresetId: resolveActivePreset(
                    activeUserSkinId(viaCore),
                    themePresetId,
                    viaCore,
                ),
            });
        },
    };

    return {key: 'ui' as const, state, actions};
}
