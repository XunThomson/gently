import rawPresets from '../config/theme/presets.json';
import type {ColorScheme, ThemeConfig, ThemePreset} from './types';

/** 主题市场预设列表（数据源：src/config/theme/presets.json） */
export const themePresets = rawPresets.presets as ThemePreset[];

export const DEFAULT_PRESET_ID = themePresets[0]?.id ?? 'violet';

export function getThemePreset(id: string): ThemePreset {
    return themePresets.find((preset) => preset.id === id) ?? themePresets[0];
}

/**
 * 把预设叠加到主题配置上：只合并 palette 与 scheme 中预设显式声明的字段。
 * 纯函数，便于测试。
 */
export function resolveTheme(base: ThemeConfig, presetId: string): ThemeConfig {
    const preset = themePresets.find((p) => p.id === presetId);
    if (!preset) return base;

    const mergeScheme = (scheme: ColorScheme) => ({
        ...base.scheme[scheme],
        ...(preset.scheme?.[scheme] ?? {}),
    });

    return {
        ...base,
        palette: {...base.palette, ...preset.palette},
        scheme: {light: mergeScheme('light'), dark: mergeScheme('dark')},
    };
}
