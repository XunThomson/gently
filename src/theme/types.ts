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
    /** 动态背景开启时外壳使用的半透明表面 */
    surfaceTranslucent: string;
    /** 动态背景之上的遮罩（跟随明暗方案，保证文字可读） */
    videoScrim: string;
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
        /** 选中项字重 */
        activeWeight: number;
        sectionTitleFontSize: number;
        sectionTitleColor: string;
        /** 分组之间的间距 */
        groupGap: number;
        countFontSize: number;
        /** 选中项左侧指示条 */
        indicatorWidth: number;
        indicatorHeight: number;
        /** 歌单行悬浮操作按钮尺寸 */
        rowActionSize: number;
        emptyFontSize: number;
    };
    playerBar: {
        height: number;
        paddingX: number;
        coverSize: number;
        coverRadius: string;
        controlSize: number;
        titleFontSize: number;
        metaFontSize: number;
        chipFontSize: number;
        iconButtonSize: number;
        volumeWidth: number;
        /** 默认进度条高度（默认不显示焦点） */
        progressHeight: number;
        /** 悬浮 / 拖拽时进度条高度（bilibili 式放大） */
        progressHoverHeight: number;
        progressThumbSize: number;
        /** 焦点皮肤：default | glow | ring */
        progressThumbSkin: string;
        progressTrackColor: string;
        progressFillColor: string;
        progressGlowColor: string;
    };
    /** 播放条上方的抽屉（播放列表 / 更多功能） */
    panel: {
        width: number;
        maxHeight: number;
        padding: number;
        radius: string;
        itemPaddingX: number;
        itemPaddingY: number;
        itemRadius: string;
        indexWidth: number;
        chipPaddingX: number;
        chipPaddingY: number;
    };
    button: {
        radius: string;
        iconGap: number;
        heightSm: number;
        heightMd: number;
        paddingXSm: number;
        paddingXMd: number;
        fontSizeSm: number;
        fontSizeMd: number;
    };
    lyrics: {
        fontSize: number;
        activeFontSize: number;
        lineGap: number;
        paddingX: number;
        paddingY: number;
        inactiveColor: string;
        hoverColor: string;
        activeColor: string;
        activeWeight: number;
        /** 当前行背景（药丸高亮） */
        activeBg: string;
        /** 当前行上下虚线引导线 */
        guideColor: string;
        guideWidth: number;
        /** 非当前行透明度 */
        inactiveOpacity: number;
        linePaddingX: number;
        linePaddingY: number;
    };
    /** 下拉菜单 / 抽屉列表（音源、音质、筛选抽屉共用） */
    menu: {
        width: number;
        maxHeight: number;
        padding: number;
        radius: string;
        itemPaddingX: number;
        itemPaddingY: number;
        itemRadius: string;
        fontSize: number;
    };
    /** 页面音源筛选（tabs / 抽屉） */
    sourceFilter: {
        height: number;
        gap: number;
        tabPaddingX: number;
        fontSize: number;
        drawerWidth: number;
    };
    emptyState: {
        paddingX: number;
        paddingY: number;
        iconGap: number;
        iconColor: string;
        titleFontSize: number;
        hintFontSize: number;
    };
    radioGroup: {
        gap: number;
        fontSize: number;
        underlineHeight: number;
        underlineOffset: number;
        underlineShortWidth: string;
        color: string;
        hoverColor: string;
        activeColor: string;
    };
    /** 榜单顶部今日推荐卡 */
    hero: {
        paddingX: number;
        paddingY: number;
        coverSize: number;
        coverRadius: string;
        discSize: number;
        discDotSize: number;
        titleFontSize: number;
        tagFontSize: number;
        glowColor: string;
    };
    datePicker: {
        /** 月历单元格尺寸（日历格宽度与高度） */
        cellSize: number;
        panelPadding: number;
        /** 月 / 年胶囊高度 */
        chipHeight: number;
        chipPaddingX: number;
    };
    /** 动态背景（视频） */
    background: {
        enabled: boolean;
        opacity: number;
        blurPx: number;
        scrim: string;
        /** 外壳玻璃化的背景模糊半径 */
        surfaceBlurPx: number;
    };
    view: {
        titleFontSize: number;
        titleFontWeight: number;
        titleSpacing: string;
        subtitleFontSize: number;
        headerGap: number;
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
        headerSpacing: string;
        cellPaddingX: number;
        cellPaddingY: number;
        rowMinHeight: number;
        radius: string;
        rowHoverBg: string;
        borderColor: string;
        emptyPaddingY: number;
        indicatorWidth: number;
        indicatorHeight: number;
        actionGap: number;
        actionPaddingX: number;
        actionPaddingY: number;
        actionRadius: string;
    };
    card: {
        radius: string;
        gap: number;
        minWidth: number;
        coverRatio: number;
        titleFontSize: number;
        metaFontSize: number;
        initialFontSize: number;
        playSize: number;
        playInset: number;
        /** 悬浮上移距离，如 -3px */
        hoverLift: string;
    };
    chart: {
        rankColumnWidth: number;
        coverColumnWidth: number;
        coverRadius: string;
        heatColumnWidth: number;
        durationColumnWidth: number;
        rowPaddingY: number;
        rowPaddingX: number;
        heatBarHeight: number;
        hoverBg: string;
        playingBg: string;
        rankFirstColor: string;
        rankSecondColor: string;
        rankThirdColor: string;
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

/**
 * 组件度量的局部覆盖：每个组件组只声明要改的字段。
 * 允许主题市场预设调整密度 / 布局，而不只是配色。
 */
export type ComponentOverrides = {
    [K in keyof ComponentTokens]?: Partial<ComponentTokens[K]>;
};

/**
 * 主题市场预设（`src/config/theme/presets.json`）。
 * 可覆盖品牌色、配色板与组件度量；未声明的字段继承主题配置。
 */
export interface ThemePreset {
    id: string;
    name: string;
    description: string;
    author: string;
    /** 预览色块 */
    swatches: string[];
    palette: Partial<ThemePalette>;
    scheme?: {
        light?: Partial<SchemeTokens>;
        dark?: Partial<SchemeTokens>;
    };
    /** 可选：覆盖组件度量（间距 / 行高 / 尺寸），实现「密度」类主题 */
    components?: ComponentOverrides;
}

/** CSS 变量字典：--name → value */
export type CssVarMap = Record<string, string>;
