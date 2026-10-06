import rawPresets from '../config/theme/presets.json';
import type {
    ColorScheme,
    ComponentOverrides,
    ComponentTokens,
    ThemeConfig,
    ThemePreset,
} from './types';

/** 主题市场预设列表（数据源：src/config/theme/presets.json） */
export const themePresets = rawPresets.presets as ThemePreset[];

export const DEFAULT_PRESET_ID = themePresets[0]?.id ?? 'violet';

export function getThemePreset(id: string): ThemePreset {
    return themePresets.find((preset) => preset.id === id) ?? themePresets[0];
}

/** 按组浅合并组件度量覆盖（每个组件组都是扁平对象） */
function mergeComponents(
    base: ComponentTokens,
    override?: ComponentOverrides,
): ComponentTokens {
    if (!override) return base;

    const next: Record<string, unknown> = {...base};
    for (const key of Object.keys(override) as (keyof ComponentTokens)[]) {
        const patch = override[key] as Record<string, unknown> | undefined;
        if (!patch) continue;
        next[key] = {...(base[key] as Record<string, unknown>), ...patch};
    }
    return next as unknown as ComponentTokens;
}

/**
 * 把预设叠加到主题配置上：
 * 只合并预设显式声明的字段（palette / scheme / components）。
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
        components: mergeComponents(base.components, preset.components),
    };
}
