import {useActions, useSelect} from '../store';
import {readPersistedUi} from '../store/persist';
import {applyCssVars, buildCssVars, themeConfig} from './tokens';
import {allSkins, getThemeSkin, resolveTheme, serializeSkin} from './presets';
import type {ColorScheme, ThemeConfig, ThemeMode, ThemeSkin} from './types';

import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

interface ThemeContextValue {
    /** 当前生效的完整主题配置（已叠加皮肤） */
    config: ThemeConfig;
    /** 用户选择的模式 */
    mode: ThemeMode;
    /** 实际生效的配色方案 */
    scheme: ColorScheme;
    setMode: (mode: ThemeMode) => void;
    /** 明暗一键切换（灯泡按钮） */
    toggleScheme: () => void;
    /** 当前皮肤 id */
    presetId: string;
    setPreset: (id: string) => void;
    /** 内置 + 自定义皮肤 */
    skins: ThemeSkin[];
    /** 用户导入的皮肤 */
    customSkins: ThemeSkin[];
    /** 当前皮肤对象 */
    skin: ThemeSkin;
    installSkin: (skin: ThemeSkin) => void;
    removeSkin: (id: string) => void;
    /** 导出当前皮肤为可分享的 JSON 文本 */
    exportSkin: () => string;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const prefersDark = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;

export function resolveScheme(mode: ThemeMode): ColorScheme {
    if (mode === 'system') return prefersDark() ? 'dark' : 'light';
    return mode;
}

/**
 * 把「主题配置 + 主题市场预设」解析成 CSS 变量并注入 `<html>`。
 * 主题状态（模式 / 预设）集中在 store 的 ui 切片中，本组件只负责解析与副作用。
 */
export function ThemeProvider({children}: { children: ReactNode }) {
    const mode = useSelect((s) => s.ui.themeMode);
    const presetId = useSelect((s) => s.ui.themePresetId);
    const scheme = useSelect((s) => s.ui.scheme);
    const customSkins = useSelect((s) => s.ui.customSkins);
    const {setScheme, setThemeMode, setThemePreset, installSkin, removeSkin} = useActions().ui;

    const [systemDark, setSystemDark] = useState(prefersDark);

    /* 跟随系统：仅在 mode === 'system' 时监听 */
    useEffect(() => {
        if (mode !== 'system' || typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [mode]);

    const resolved: ColorScheme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

    /* 皮肤叠加后的主题配置 */
    const activeConfig = useMemo(
        () => resolveTheme(themeConfig, presetId, customSkins),
        [presetId, customSkins],
    );

    /* 解析结果回写 store，供业务代码读取（歌词 / 封面配色等） */
    useEffect(() => {
        setScheme(resolved);
    }, [resolved, setScheme]);

    /* 注入 CSS 变量 */
    useEffect(() => {
        applyCssVars(buildCssVars(activeConfig, resolved));
        const root = document.documentElement;
        root.dataset.theme = resolved;
        root.dataset.preset = presetId;
        // 让原生控件（滚动条、输入框）跟随主题
        root.style.colorScheme = resolved;
    }, [activeConfig, resolved, presetId]);

    const value = useMemo<ThemeContextValue>(() => {
        const skins = allSkins(customSkins);
        const skin = getThemeSkin(presetId, customSkins);

        return {
            config: activeConfig,
            mode,
            scheme,
            setMode: setThemeMode,
            toggleScheme: () => setThemeMode(scheme === 'dark' ? 'light' : 'dark'),
            presetId,
            setPreset: setThemePreset,
            skins,
            customSkins,
            skin,
            installSkin,
            removeSkin,
            exportSkin: () => serializeSkin(skin),
        };
    }, [
        activeConfig,
        mode,
        scheme,
        setThemeMode,
        setThemePreset,
        presetId,
        customSkins,
        installSkin,
        removeSkin,
    ]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme 必须在 <ThemeProvider> 内使用');
    return ctx;
}

/**
 * 首次渲染前同步注入主题变量，避免首屏闪烁。
 * 由 `main.tsx` 在挂载 React 之前调用（会读取已持久化的主题与皮肤）。
 */
export function applyInitialTheme(): void {
    const {themeMode, themePresetId, customSkins} = readPersistedUi();
    const mode = themeMode ?? themeConfig.mode;
    const scheme = resolveScheme(mode);
    applyCssVars(
        buildCssVars(resolveTheme(themeConfig, themePresetId ?? '', customSkins ?? []), scheme),
    );
    const root = document.documentElement;
    root.dataset.theme = scheme;
    root.dataset.preset = themePresetId ?? '';
    root.style.colorScheme = scheme;
}
