/**
 * 主题元数据类型。
 *
 * 唯一数据源：`src/config/theme/theme.config.json`
 * 运行时由 `ThemeProvider` 解析为 CSS 变量并注入 `<html>`。
 */

/* 主题包背景的形状来自背景模块（同一条数据在设置页也用它）：只借类型，不引运行时依赖 */
import type {SkinBackgroundHint} from '../utils/skinPackage';

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
        /** 紧凑模式下的图标栏宽度 */
        compactWidth: number;
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
        lineGap: number;
        paddingX: number;
        paddingY: number;
        inactiveColor: string;
        hoverColor: string;
        activeColor: string;
        activeWeight: number;
        /** 非当前行透明度 */
        inactiveOpacity: number;
        linePaddingX: number;
        linePaddingY: number;
        /** 译文比原文小一号 */
        translationFontSize: number;
        translationGap: number;
    };
    /** 迷你播放器（窗口小于断点后替换整个外壳） */
    miniPlayer: {
        padding: number;
        headerHeight: number;
        /** 封面是随窗口高度伸缩的尺寸表达式（如 clamp(...)） */
        coverSize: string;
        coverRadius: string;
        titleFontSize: number;
        artistFontSize: number;
        lyricsFontSize: number;
        lyricsLineGap: number;
        lyricsPaddingY: number;
        /** 三行窗口里空槽（当前行在首/尾）的高度 */
        lyricsSlotHeight: number;
        controlSize: number;
        iconButtonSize: number;
        windowButtonSize: number;
    };
    /** 手机外壳（左侧导航抽屉 + 常驻播放条） */
    mobile: {
        headerHeight: number;
        tabBarHeight: number;
        playerBarHeight: number;
        coverSize: number;
        coverRadius: string;
        titleFontSize: number;
        metaFontSize: number;
        controlSize: number;
        iconButtonSize: number;
        tabIconSize: number;
        paddingX: number;
        sheetItemHeight: number;
        drawerWidth: number;
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
        /** 背景开启时内容表面的不透明度；只作用于背景色，不影响文字 */
        contentOpacity: number;
        /** 背景开启时抽屉/浮层表面的不透明度；与内容表面独立 */
        drawerOpacity: number;
        /** 抽屉/浮层的默认虚化半径；用户可在背景设置里单独覆盖 */
        drawerBlurPx: number;
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
    /** 榜单/分类列表（名次 + 封面 + 专辑 + 时长） */
    topList: {
        rankColumnWidth: number;
        coverColumnWidth: number;
        coverRadius: string;
        durationColumnWidth: number;
        rowPaddingY: number;
        rowPaddingX: number;
        hoverBg: string;
        playingBg: string;
        rankFirstColor: string;
        rankSecondColor: string;
        rankThirdColor: string;
    };

    /** 专辑 / 歌单详情头图 */
    collection: {
        coverSize: number;
    };

    /** 歌词页（封面 + 歌词） */
    nowPlaying: {
        coverMinWidth: number;
        coverMaxWidth: number;
        /** 首列占内容宽度的比例（如 44%），窄窗口按它收缩但不少于最小值 */
        coverWidthRatio: string;
        /** 强制展开成单列时的封面上限 */
        coverStackMaxWidth: number;
        /** 歌词卡片高度表达式（固定高度才能把当前行滚到中间） */
        lyricsPanelHeight: string;
        /** 手机端「封面作为背景」时的不透明度（默认不显示封面） */
        mobileCoverOpacity: number;
        /** 手机端「封面作为背景」时的虚化半径 */
        mobileCoverBlur: string;
        /** 手机端（默认不看封面）时的歌词卡片高度：把封面省下来的高度还给歌词 */
        mobileLyricsPanelHeight: string;
    };

    /** 业务列表（数据表格）：标题列左边的封面缩略图 */
    table: {
        coverSize: number;
        coverRadius: string;
        coverGap: number;
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
 * 皮肤可覆盖的全部令牌组。
 * 每组都是「只声明要改的字段」，其余继承 `theme.config.json`，
 * 因此皮肤既能只换配色，也能整套替换字体 / 圆角 / 阴影 / 动效 / 密度（复杂主题）。
 */
export interface SkinOverrides {
    palette?: Partial<ThemePalette>;
    scheme?: {
        light?: Partial<SchemeTokens>;
        dark?: Partial<SchemeTokens>;
    };
    typography?: Partial<TypographyTokens>;
    radius?: Partial<RadiusTokens>;
    spacing?: Partial<SpacingTokens>;
    shadow?: Partial<ShadowTokens>;
    motion?: Partial<MotionTokens>;
    zIndex?: Partial<ZIndexTokens>;
    components?: ComponentOverrides;
}

/**
 * 主题皮肤（主题市场条目 / `src/config/theme/presets.json`）。
 * 内置皮肤随包发布；用户导入的皮肤存本地（`ui.customSkins`）。
 */
export interface ThemeSkin extends SkinOverrides {
    id: string;
    name: string;
    description: string;
    author: string;
    version?: string;
    /** 分类标签（配色 / 密度 / 圆角 / 字体 / 效果…） */
    tags?: string[];
    /** 市场卡片预览色块 */
    swatches: string[];
    /** 是否内置 */
    builtin?: boolean;
    /**
     * 主题包自带的背景（R87）：`{kind, file?, options?}`。
     *
     * 背景属于皮肤——用户导入一套主题就该连背景一起得到，而不是再去设置页手动导入一次。
     * 素材本身不进 JSON：`file` 只是主题包内的文件名，前端按皮肤 id 把它绑定到 IndexedDB。
     * 设置页的背景参数仍然保留，用于**微调**。
     */
    background?: SkinBackgroundHint;
}

/** 兼容旧命名 */
export type ThemePreset = ThemeSkin;

/** CSS 变量字典：--name → value */
export type CssVarMap = Record<string, string>;
