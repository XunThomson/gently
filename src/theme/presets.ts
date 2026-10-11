import rawSkins from '../config/theme/presets.json';
import type {
    ColorScheme,
    ComponentOverrides,
    ComponentTokens,
    SchemeTokens,
    ThemeConfig,
    ThemeSkin,
} from './types';

/**
 * 内置皮肤（数据源：`src/config/theme/presets.json`）。
 *
 * **`builtin: true` 在这里补上**，而不是要求数据文件每条都写一遍：
 * 视图据此隐藏「删除皮肤」入口、导出时据此决定要不要问核心（内置预设核心根本不认识）。
 * 数据文件不写会得到一个「点了没用还会谎报成功」的删除按钮——
 * `presets.json` 里漏了 `builtin`，R51 实测每个内置卡片都长出了那个按钮，点击后提示
 * 「已删除皮肤「深海蓝」」而卡片纹丝不动（核心回 `skin.not_found`，被忽略）。
 */
export const builtinSkins: ThemeSkin[] = (rawSkins.skins as ThemeSkin[]).map((skin) => ({
    ...skin,
    builtin: true,
}));

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

/* ============================== 「当前用哪套皮肤」的唯一裁决 ============================== */

/**
 * 核心报的激活皮肤从 `skin.list` 的 `active` 标记里读出来。
 *
 * 只有**用户皮肤**可能带这个标记：内置预设随前端包发布，核心的 `skins` 表里没有它们，
 * 因此「用户当前用的是哪套内置预设」只能存在前端（localStorage）。
 */
export function activeUserSkinId(skins: readonly (ThemeSkin & {active?: boolean})[]): string | null {
    return skins.find((skin) => skin.active)?.id ?? null;
}

/**
 * 启动时决定用哪套皮肤——**这里只有一份裁决逻辑**，避免「核心说 A、localStorage 说 B」。
 *
 * 规则：
 * 1. 核心有激活的用户皮肤 → 用它（桌面端「当前选择」的事实来源是核心的 `meta.skin.active`）；
 * 2. 否则沿用本地存的 id（内置预设只能这样记），但**必须仍然存在于当前皮肤集合里**
 *    （换了机器、删了皮肤、清了 localStorage 都可能让它失效）；
 * 3. 都不成立 → 回到默认预设。
 */
export function resolveActivePreset(
    coreActive: string | null,
    localId: string,
    customSkins: readonly ThemeSkin[],
): string {
    if (coreActive) return coreActive;
    return allSkins(customSkins).some((skin) => skin.id === localId) ? localId : DEFAULT_PRESET_ID;
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
