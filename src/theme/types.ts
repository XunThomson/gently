/**
 * 主题元数据类型。
 *
 * 唯一数据源：`src/config/theme/theme.config.json`
 * 运行时由 `ThemeProvider` 解析为 CSS 变量并注入 `<html>`。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

/** 解析后的实际配色方案（system 会被解析成 light / dark） */
export type ColorScheme = 'light' | 'dark';

export interface ThemeMeta {
    name: string;
    version: string;
    description?: string;
}

export interface ThemePalette {
    /** 品牌主色 */
    brand: string;
    brandHover: string;
    brandSoft: string;
    brandContrast: string;
    success: string;
    warning: string;
    danger: string;
}

/** 一种配色方案下的语义色板 */
export interface SchemeTokens {
    app: string;
    surface: string;
    surfaceAlt: string;
    subtle: string;
    elevated: string;
    hover: string;
    active: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
    textInverse: string;
    borderSubtle: string;
    borderDefault: string;
    borderStrong: string;
    divider: string;
    scrollbarThumb: string;
}

export interface TypographyTokens {
    fontFamilySans: string;
    fontFamilyMono: string;
    fontSizeXs: string;
    fontSizeSm: string;
    fontSizeBase: string;
    fontSizeLg: string;
    fontSizeXl: string;
    fontSize2xl: string;
    fontSize3xl: string;
    fontSize4xl: string;
    lineHeightTight: number;
    lineHeightNormal: number;
    lineHeightRelaxed: number;
    weightNormal: number;
    weightMedium: number;
    weightSemibold: number;
    weightBold: number;
}

export interface RadiusTokens {
    none: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    '2xl': string;
    full: string;
}

/** 间距刻度（键即倍数，如 "4" → `--space-4`） */
export type SpacingTokens = Record<string, string>;

export interface ShadowTokens {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    panel: string;
}

export interface MotionTokens {
    fast: string;
    base: string;
    slow: string;
    easing: string;
}

export interface ZIndexTokens {
    base: number;
    dropdown: number;
    overlay: number;
    modal: number;
    toast: number;
}

export interface ComponentTokens {
    titleBar: {
        height: number;
        paddingX: number;
        logoFontSize: number;
        logoFontWeight: number;
        logoColor: string;
    };
    searchBox: {
        height: number;
        maxWidth: number;
        minWidth: number;
        radius: string;
        fontSize: number;
        placeholderColor: string;
        iconSize: number;
        iconColor: string;
        submitTextColor: string;
        panelMaxHeight: number;
        /** 行为参数（非样式） */
        historyKey: string;
        maxHistory: number;
        debounce: number;
    };
    toolbar: {
        buttonSize: number;
        iconSize: number;
        gap: number;
        paddingX: number;
        paddingY: number;
        radius: string;
        iconColor: string;
        hoverColor: string;
        hoverBg: string;
        dividerColor: string;
    };
    sidebar: {
        width: number;
        padding: number;
        itemHeight: number;
        itemGap: number;
        itemPaddingX: number;
        itemRadius: string;
        fontSize: number;
        iconSize: number;
        textColor: string;
        hoverTextColor: string;
        hoverBg: string;
        activeTextColor: string;
        activeBg: string;
        sectionTitleFontSize: number;
        sectionTitleColor: string;
    };
    playerBar: {
        height: number;
        paddingX: number;
        coverSize: number;
        coverRadius: string;
        controlSize: number;
        progressWidth: number;
        progressHeight: number;
    };
    view: {
        titleFontSize: number;
        titleFontWeight: number;
        paddingX: number;
        paddingY: number;
        gap: number;
        maxWidth: number;
    };
    section: {
        titleFontSize: number;
        subtitleFontSize: number;
        gap: number;
        marginBottom: number;
    };
    dataTable: {
        fontSize: number;
        headerFontSize: number;
        headerColor: string;
        cellPaddingX: number;
        cellPaddingY: number;
        radius: string;
        rowHoverBg: string;
        borderColor: string;
        emptyPaddingY: number;
    };
    card: {
        radius: string;
        gap: number;
        minWidth: number;
        coverRatio: number;
        titleFontSize: number;
        metaFontSize: number;
    };
    chart: {
        rankColumnWidth: number;
        coverColumnWidth: number;
        heatColumnWidth: number;
        durationColumnWidth: number;
        rowPaddingY: number;
        rowPaddingX: number;
        heatBarHeight: number;
    };
}

export interface ThemeConfig {
    meta: ThemeMeta;
    mode: ThemeMode;
    palette: ThemePalette;
    scheme: Record<ColorScheme, SchemeTokens>;
    typography: TypographyTokens;
    radius: RadiusTokens;
    spacing: SpacingTokens;
    shadow: ShadowTokens;
    motion: MotionTokens;
    zIndex: ZIndexTokens;
    components: ComponentTokens;
}

/** CSS 变量字典：--name → value */
export type CssVarMap = Record<string, string>;
