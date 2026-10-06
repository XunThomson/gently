import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import {useActions, useSelect} from '../store';
import {applyCssVars, buildCssVars, themeConfig} from './tokens';
import type {ColorScheme, ThemeConfig, ThemeMode} from './types';

interface ThemeContextValue {
    /** 完整主题配置（只读） */
    config: ThemeConfig;
    /** 用户选择的模式 */
    mode: ThemeMode;
    /** 实际生效的配色方案 */
    scheme: ColorScheme;
    setMode: (mode: ThemeMode) => void;
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
 * 首次渲染前同步注入主题变量，避免首屏闪烁。
 * 由 `main.tsx` 在挂载 React 之前调用。
 */
export function applyInitialTheme(): void {
    const scheme = resolveScheme(themeConfig.mode);
    applyCssVars(buildCssVars(themeConfig, scheme));
    const root = document.documentElement;
    root.dataset.theme = scheme;
    root.style.colorScheme = scheme;
}

/**
 * 把 theme.config.json 解析成 CSS 变量并注入 `<html>`。
 * 主题模式保存在集中式 store 中，本组件只负责解析与副作用。
 */
export function ThemeProvider({children}: { children: ReactNode }) {
    const mode = useSelect((s) => s.ui.themeMode);
    const scheme = useSelect((s) => s.ui.scheme);
    const {setScheme, setThemeMode} = useActions().ui;

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

    /* 解析结果回写 store，供业务代码读取（歌词 / 封面配色等） */
    useEffect(() => {
        setScheme(resolved);
    }, [resolved, setScheme]);

    /* 注入 CSS 变量 */
    useEffect(() => {
        applyCssVars(buildCssVars(themeConfig, resolved));
        const root = document.documentElement;
        root.dataset.theme = resolved;
        // 让原生控件（滚动条、输入框）跟随主题
        root.style.colorScheme = resolved;
    }, [resolved]);

    const value = useMemo<ThemeContextValue>(
        () => ({config: themeConfig, mode, scheme, setMode: setThemeMode}),
        [mode, scheme, setThemeMode],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme 必须在 <ThemeProvider> 内使用');
    return ctx;
}
