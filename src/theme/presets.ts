import rawSkins from '../config/theme/presets.json';
import type {
    ColorScheme,
    ComponentOverrides,
    ComponentTokens,
    SchemeTokens,
    ThemeConfig,
    ThemeSkin,
} from './types';

/** 内置皮肤（数据源：src/config/theme/presets.json） */
export const builtinSkins = rawSkins.skins as ThemeSkin[];

/** 兼容旧命名 */
export const themePresets = builtinSkins;

export const DEFAULT_PRESET_ID = builtinSkins[0]?.id ?? 'violet';

/** 内置 + 用户导入的皮肤 */
export function allSkins(customSkins: readonly ThemeSkin[] = []): ThemeSkin[] {
    return [...builtinSkins, ...customSkins];
}

export function getThemeSkin(id: string, customSkins: readonly ThemeSkin[] = []): ThemeSkin {
    return allSkins(customSkins).find((skin) => skin.id === id) ?? builtinSkins[0];
}

/** 兼容旧命名 */
export const getThemePreset = getThemeSkin;

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

/** 合并 Record<string, string> 型令牌组（spacing），跳过 undefined */
function mergeRecord(
    base: Record<string, string>,
    patch?: Record<string, string>,
): Record<string, string> {
    if (!patch) return base;
    const next: Record<string, string> = {...base};
    Object.entries(patch).forEach(([key, value]) => {
        if (value !== undefined) next[key] = value;
    });
    return next;
}

/**
 * 把皮肤叠加到主题配置上：只合并皮肤显式声明的字段。
 * 纯函数，便于测试。
 */
export function resolveTheme(
    base: ThemeConfig,
    skinId: string,
    customSkins: readonly ThemeSkin[] = [],
): ThemeConfig {
    const skin = allSkins(customSkins).find((item) => item.id === skinId);
    if (!skin) return base;

    const mergeScheme = (scheme: ColorScheme): SchemeTokens => ({
        ...base.scheme[scheme],
        ...(skin.scheme?.[scheme] ?? {}),
    });

    return {
        ...base,
        palette: {...base.palette, ...skin.palette},
        scheme: {light: mergeScheme('light'), dark: mergeScheme('dark')},
        typography: {...base.typography, ...skin.typography},
        radius: {...base.radius, ...skin.radius},
        // Record 型令牌（spacing）需要剔除未定义值
        spacing: mergeRecord(base.spacing, skin.spacing as Record<string, string> | undefined),
        shadow: {...base.shadow, ...skin.shadow},
        motion: {...base.motion, ...skin.motion},
        zIndex: {...base.zIndex, ...skin.zIndex},
        components: mergeComponents(base.components, skin.components),
    };
}

/* ============================== 皮肤导入 / 导出 ============================== */

export interface SkinParseResult {
    ok: boolean;
    skin?: ThemeSkin;
    /** 失败原因（用于提示用户） */
    reason?: string;
}

const REQUIRED_FIELDS = ['id', 'name'] as const;

/**
 * 解析并校验用户导入的皮肤 JSON。
 * 只做结构与类型校验，不执行任何代码，避免导入任意内容带来的风险。
 */
export function parseSkin(input: string): SkinParseResult {
    let raw: unknown;
    try {
        raw = JSON.parse(input);
    } catch {
        return {ok: false, reason: 'JSON'};
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {ok: false, reason: 'structure'};
    }

    const candidate = raw as Partial<ThemeSkin>;
    for (const field of REQUIRED_FIELDS) {
        if (typeof candidate[field] !== 'string' || !candidate[field]) {
            return {ok: false, reason: `field:${field}`};
        }
    }

    if (candidate.swatches && !Array.isArray(candidate.swatches)) {
        return {ok: false, reason: 'field:swatches'};
    }

    return {
        ok: true,
        skin: {
            ...candidate,
            id: candidate.id as string,
            name: candidate.name as string,
            description: candidate.description ?? '',
            author: candidate.author ?? 'imported',
            swatches: candidate.swatches ?? [],
            builtin: false,
        },
    };
}

/** 导出皮肤为可分享的 JSON 文本 */
export function serializeSkin(skin: ThemeSkin): string {
    const {builtin: _builtin, ...shareable} = skin;
    return JSON.stringify(shareable, null, 2);
}
