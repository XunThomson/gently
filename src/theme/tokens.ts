import rawTheme from '../config/theme/theme.config.json';
import type {ColorScheme, CssVarMap, ThemeConfig} from './types';

/** 主题配置（唯一数据源） */
export const themeConfig = rawTheme as ThemeConfig;

const px = (v: number | string): string => (typeof v === 'number' ? `${v}px` : v);

/**
 * 解析形如 `{text.primary}` / `{brand.soft}` 的语义引用。
 * 同时支持数字（返回 px 字符串）。
 */
export function resolveTokenRef(
    value: number | string,
    scheme: ColorScheme,
): string {
    if (typeof value === 'number') return `${value}px`;

    const matched = /^\{(.+)\}$/.exec(value);
    if (!matched) return value;

    const s = themeConfig.scheme[scheme];
    const p = themeConfig.palette;

    const table: Record<string, string> = {
        'text.primary': s.textPrimary,
        'text.secondary': s.textSecondary,
        'text.tertiary': s.textTertiary,
        'text.inverse': s.textInverse,
        'bg.app': s.app,
        'bg.surface': s.surface,
        'bg.surface-alt': s.surfaceAlt,
        'bg.subtle': s.subtle,
        'bg.elevated': s.elevated,
        'bg.hover': s.hover,
        'bg.active': s.active,
        'border.subtle': s.borderSubtle,
        'border.default': s.borderDefault,
        'border.strong': s.borderStrong,
        'divider': s.divider,
        'scrim': s.videoScrim,
        'brand': p.brand,
        'brand.hover': p.brandHover,
        'brand.soft': p.brandSoft,
        'brand.contrast': p.brandContrast,
        'status.success': p.success,
        'status.warning': p.warning,
        'status.danger': p.danger,
    };

    const hit = table[matched[1]];
    if (hit === undefined) {
        console.warn(`[theme] 未定义的语义引用：${value}`);
        return value;
    }
    return hit;
}

/** 把主题配置拍平成 CSS 变量表。纯函数，便于测试与快照。 */
export function buildCssVars(config: ThemeConfig, scheme: ColorScheme): CssVarMap {
    const t = (v: number | string) => resolveTokenRef(v, scheme);
    const s = config.scheme[scheme];
    const c = config.components;

    const vars: CssVarMap = {
        /* ---------- 配色（当前 scheme） ---------- */
        '--bg-app': s.app,
        '--bg-surface': s.surface,
        '--bg-surface-alt': s.surfaceAlt,
        '--bg-subtle': s.subtle,
        '--bg-elevated': s.elevated,
        '--bg-surface-translucent': s.surfaceTranslucent,
        '--bg-hover': s.hover,
        '--bg-active': s.active,
        '--text-primary': s.textPrimary,
        '--text-secondary': s.textSecondary,
        '--text-tertiary': s.textTertiary,
        '--text-inverse': s.textInverse,
        '--border-subtle': s.borderSubtle,
        '--border-default': s.borderDefault,
        '--border-strong': s.borderStrong,
        '--divider': s.divider,
        '--scrollbar-thumb': s.scrollbarThumb,

        /* ---------- 品牌与状态色 ---------- */
        '--brand': config.palette.brand,
        '--brand-hover': config.palette.brandHover,
        '--brand-soft': config.palette.brandSoft,
        '--brand-contrast': config.palette.brandContrast,
        '--success': config.palette.success,
        '--warning': config.palette.warning,
        '--danger': config.palette.danger,

        /* ---------- 字体 ---------- */
        '--font-sans': config.typography.fontFamilySans,
        '--font-mono': config.typography.fontFamilyMono,
        '--font-size-xs': config.typography.fontSizeXs,
        '--font-size-sm': config.typography.fontSizeSm,
        '--font-size-base': config.typography.fontSizeBase,
        '--font-size-lg': config.typography.fontSizeLg,
        '--font-size-xl': config.typography.fontSizeXl,
        '--font-size-2xl': config.typography.fontSize2xl,
        '--font-size-3xl': config.typography.fontSize3xl,
        '--font-size-4xl': config.typography.fontSize4xl,
        '--line-height-tight': String(config.typography.lineHeightTight),
        '--line-height-normal': String(config.typography.lineHeightNormal),
        '--line-height-relaxed': String(config.typography.lineHeightRelaxed),
        '--font-weight-normal': String(config.typography.weightNormal),
        '--font-weight-medium': String(config.typography.weightMedium),
        '--font-weight-semibold': String(config.typography.weightSemibold),
        '--font-weight-bold': String(config.typography.weightBold),

        /* ---------- 圆角 ---------- */
        '--radius-none': config.radius.none,
        '--radius-sm': config.radius.sm,
        '--radius-md': config.radius.md,
        '--radius-lg': config.radius.lg,
        '--radius-xl': config.radius.xl,
        '--radius-2xl': config.radius['2xl'],
        '--radius-full': config.radius.full,

        /* ---------- 间距 ---------- */
        ...Object.fromEntries(
            Object.entries(config.spacing).map(([step, value]) => [`--space-${step}`, value]),
        ),

        /* ---------- 阴影 ---------- */
        '--shadow-xs': config.shadow.xs,
        '--shadow-sm': config.shadow.sm,
        '--shadow-md': config.shadow.md,
        '--shadow-lg': config.shadow.lg,
        '--shadow-xl': config.shadow.xl,
        '--shadow-panel': config.shadow.panel,

        /* ---------- 动效 ---------- */
        '--motion-fast': config.motion.fast,
        '--motion-base': config.motion.base,
        '--motion-slow': config.motion.slow,
        '--ease': config.motion.easing,

        /* ---------- 层级 ---------- */
        '--z-dropdown': String(config.zIndex.dropdown),
        '--z-overlay': String(config.zIndex.overlay),
        '--z-modal': String(config.zIndex.modal),
        '--z-toast': String(config.zIndex.toast),

        /* ---------- 组件：标题栏 ---------- */
        '--title-bar-height': px(c.titleBar.height),
        '--title-bar-padding-x': px(c.titleBar.paddingX),
        '--logo-font-size': px(c.titleBar.logoFontSize),
        '--logo-font-weight': String(c.titleBar.logoFontWeight),
        '--logo-color': t(c.titleBar.logoColor),

        /* ---------- 组件：搜索框 ---------- */
        '--search-box-height': px(c.searchBox.height),
        '--search-box-max-width': px(c.searchBox.maxWidth),
        '--search-box-min-width': px(c.searchBox.minWidth),
        '--search-box-radius': c.searchBox.radius,
        '--search-box-font-size': px(c.searchBox.fontSize),
        '--search-box-placeholder': t(c.searchBox.placeholderColor),
        '--search-box-icon-size': px(c.searchBox.iconSize),
        '--search-box-icon-color': t(c.searchBox.iconColor),
        '--search-box-submit-color': t(c.searchBox.submitTextColor),
        '--search-box-panel-max-height': px(c.searchBox.panelMaxHeight),

        /* ---------- 组件：工具栏 ---------- */
        '--toolbar-button-size': px(c.toolbar.buttonSize),
        '--toolbar-icon-size': px(c.toolbar.iconSize),
        '--toolbar-gap': px(c.toolbar.gap),
        '--toolbar-padding-x': px(c.toolbar.paddingX),
        '--toolbar-padding-y': px(c.toolbar.paddingY),
        '--toolbar-radius': c.toolbar.radius,
        '--toolbar-icon-color': t(c.toolbar.iconColor),
        '--toolbar-hover-color': t(c.toolbar.hoverColor),
        '--toolbar-hover-bg': t(c.toolbar.hoverBg),
        '--toolbar-divider-color': t(c.toolbar.dividerColor),

        /* ---------- 组件：侧边栏 ---------- */
        '--sidebar-width': px(c.sidebar.width),
        '--sidebar-padding': px(c.sidebar.padding),
        '--sidebar-item-height': px(c.sidebar.itemHeight),
        '--sidebar-item-gap': px(c.sidebar.itemGap),
        '--sidebar-item-padding-x': px(c.sidebar.itemPaddingX),
        '--sidebar-item-radius': c.sidebar.itemRadius,
        '--sidebar-font-size': px(c.sidebar.fontSize),
        '--sidebar-icon-size': px(c.sidebar.iconSize),
        '--sidebar-text-color': t(c.sidebar.textColor),
        '--sidebar-hover-text-color': t(c.sidebar.hoverTextColor),
        '--sidebar-hover-bg': t(c.sidebar.hoverBg),
        '--sidebar-active-text-color': t(c.sidebar.activeTextColor),
        '--sidebar-active-bg': t(c.sidebar.activeBg),
        '--sidebar-section-title-size': px(c.sidebar.sectionTitleFontSize),
        '--sidebar-section-title-color': t(c.sidebar.sectionTitleColor),
        '--sidebar-active-weight': String(c.sidebar.activeWeight),
        '--sidebar-group-gap': px(c.sidebar.groupGap),
        '--sidebar-count-font-size': px(c.sidebar.countFontSize),
        '--sidebar-indicator-width': px(c.sidebar.indicatorWidth),
        '--sidebar-indicator-height': px(c.sidebar.indicatorHeight),
        '--sidebar-row-action-size': px(c.sidebar.rowActionSize),
        '--sidebar-empty-font-size': px(c.sidebar.emptyFontSize),

        /* ---------- 组件：播放条 ---------- */
        '--player-bar-height': px(c.playerBar.height),
        '--player-bar-padding-x': px(c.playerBar.paddingX),
        '--player-cover-size': px(c.playerBar.coverSize),
        '--player-cover-radius': c.playerBar.coverRadius,
        '--player-control-size': px(c.playerBar.controlSize),
        '--player-title-font-size': px(c.playerBar.titleFontSize),
        '--player-meta-font-size': px(c.playerBar.metaFontSize),
        '--player-chip-font-size': px(c.playerBar.chipFontSize),
        '--player-icon-button-size': px(c.playerBar.iconButtonSize),
        '--player-volume-width': px(c.playerBar.volumeWidth),
        '--player-progress-height': px(c.playerBar.progressHeight),
        '--player-progress-hover-height': px(c.playerBar.progressHoverHeight),
        '--player-progress-thumb-size': px(c.playerBar.progressThumbSize),
        '--player-progress-track': t(c.playerBar.progressTrackColor),
        '--player-progress-fill': t(c.playerBar.progressFillColor),
        '--player-progress-glow': t(c.playerBar.progressGlowColor),

        /* ---------- 组件：播放条抽屉 ---------- */
        '--panel-width': px(c.panel.width),
        '--panel-max-height': px(c.panel.maxHeight),
        '--panel-padding': px(c.panel.padding),
        '--panel-radius': c.panel.radius,
        '--panel-item-padding-x': px(c.panel.itemPaddingX),
        '--panel-item-padding-y': px(c.panel.itemPaddingY),
        '--panel-item-radius': c.panel.itemRadius,
        '--panel-index-width': px(c.panel.indexWidth),
        '--panel-chip-padding-x': px(c.panel.chipPaddingX),
        '--panel-chip-padding-y': px(c.panel.chipPaddingY),

        /* ---------- 组件：按钮 ---------- */
        '--button-radius': c.button.radius,
        '--button-icon-gap': px(c.button.iconGap),
        '--button-height-sm': px(c.button.heightSm),
        '--button-height-md': px(c.button.heightMd),
        '--button-padding-x-sm': px(c.button.paddingXSm),
        '--button-padding-x-md': px(c.button.paddingXMd),
        '--button-font-size-sm': px(c.button.fontSizeSm),
        '--button-font-size-md': px(c.button.fontSizeMd),

        /* ---------- 组件：歌词 ---------- */
        '--lyrics-font-size': px(c.lyrics.fontSize),
        '--lyrics-active-font-size': px(c.lyrics.activeFontSize),
        '--lyrics-line-gap': px(c.lyrics.lineGap),
        '--lyrics-padding-x': px(c.lyrics.paddingX),
        '--lyrics-padding-y': px(c.lyrics.paddingY),
        '--lyrics-inactive-color': t(c.lyrics.inactiveColor),
        '--lyrics-hover-color': t(c.lyrics.hoverColor),
        '--lyrics-active-color': t(c.lyrics.activeColor),
        '--lyrics-active-weight': String(c.lyrics.activeWeight),

        /* ---------- 组件：空态 ---------- */
        '--empty-padding-x': px(c.emptyState.paddingX),
        '--empty-padding-y': px(c.emptyState.paddingY),
        '--empty-icon-gap': px(c.emptyState.iconGap),
        '--empty-icon-color': t(c.emptyState.iconColor),
        '--empty-title-font-size': px(c.emptyState.titleFontSize),
        '--empty-hint-font-size': px(c.emptyState.hintFontSize),

        /* ---------- 组件：下划线单选组 ---------- */
        '--radio-gap': px(c.radioGroup.gap),
        '--radio-font-size': px(c.radioGroup.fontSize),
        '--radio-underline-height': px(c.radioGroup.underlineHeight),
        '--radio-underline-offset': px(c.radioGroup.underlineOffset),
        '--radio-underline-short-width': c.radioGroup.underlineShortWidth,
        '--radio-color': t(c.radioGroup.color),
        '--radio-hover-color': t(c.radioGroup.hoverColor),
        '--radio-active-color': t(c.radioGroup.activeColor),

        /* ---------- 组件：今日推荐卡 ---------- */
        '--hero-padding-x': px(c.hero.paddingX),
        '--hero-padding-y': px(c.hero.paddingY),
        '--hero-cover-size': px(c.hero.coverSize),
        '--hero-cover-radius': c.hero.coverRadius,
        '--hero-disc-size': px(c.hero.discSize),
        '--hero-disc-dot-size': px(c.hero.discDotSize),
        '--hero-title-font-size': px(c.hero.titleFontSize),
        '--hero-tag-font-size': px(c.hero.tagFontSize),
        '--hero-glow-color': t(c.hero.glowColor),

        /* ---------- 组件：日期选择器 ---------- */
        '--datepicker-cell-size': px(c.datePicker.cellSize),
        '--datepicker-panel-padding': px(c.datePicker.panelPadding),
        '--datepicker-chip-height': px(c.datePicker.chipHeight),
        '--datepicker-chip-padding-x': px(c.datePicker.chipPaddingX),

        /* ---------- 组件：动态背景 ---------- */
        '--bg-video-opacity': String(c.background.opacity),
        '--bg-video-blur': px(c.background.blurPx),
        '--bg-video-scrim': t(c.background.scrim),
        '--bg-surface-blur': px(c.background.surfaceBlurPx),

        /* ---------- 组件：页面容器 ---------- */
        '--view-title-size': px(c.view.titleFontSize),
        '--view-title-weight': String(c.view.titleFontWeight),
        '--view-title-spacing': c.view.titleSpacing,
        '--view-subtitle-size': px(c.view.subtitleFontSize),
        '--view-header-gap': px(c.view.headerGap),
        '--view-padding-x': px(c.view.paddingX),
        '--view-padding-y': px(c.view.paddingY),
        '--view-gap': px(c.view.gap),
        '--view-max-width': px(c.view.maxWidth),

        /* ---------- 组件：区块标题 ---------- */
        '--section-title-size': px(c.section.titleFontSize),
        '--section-subtitle-size': px(c.section.subtitleFontSize),
        '--section-gap': px(c.section.gap),
        '--section-margin-bottom': px(c.section.marginBottom),

        /* ---------- 组件：数据表格 ---------- */
        '--table-font-size': px(c.dataTable.fontSize),
        '--table-header-font-size': px(c.dataTable.headerFontSize),
        '--table-header-color': t(c.dataTable.headerColor),
        '--table-header-spacing': c.dataTable.headerSpacing,
        '--table-cell-padding-x': px(c.dataTable.cellPaddingX),
        '--table-cell-padding-y': px(c.dataTable.cellPaddingY),
        '--table-row-min-height': px(c.dataTable.rowMinHeight),
        '--table-radius': c.dataTable.radius,
        '--table-row-hover-bg': t(c.dataTable.rowHoverBg),
        '--table-border-color': t(c.dataTable.borderColor),
        '--table-empty-padding-y': px(c.dataTable.emptyPaddingY),
        '--table-indicator-width': px(c.dataTable.indicatorWidth),
        '--table-indicator-height': px(c.dataTable.indicatorHeight),
        '--table-action-gap': px(c.dataTable.actionGap),
        '--table-action-padding-x': px(c.dataTable.actionPaddingX),
        '--table-action-padding-y': px(c.dataTable.actionPaddingY),
        '--table-action-radius': c.dataTable.actionRadius,

        /* ---------- 组件：卡片 ---------- */
        '--card-radius': c.card.radius,
        '--card-gap': px(c.card.gap),
        '--card-min-width': px(c.card.minWidth),
        '--card-cover-ratio': String(c.card.coverRatio),
        '--card-title-size': px(c.card.titleFontSize),
        '--card-meta-size': px(c.card.metaFontSize),
        '--card-initial-size': px(c.card.initialFontSize),
        '--card-play-size': px(c.card.playSize),
        '--card-play-inset': px(c.card.playInset),
        '--card-hover-lift': c.card.hoverLift,

        /* ---------- 组件：榜单 ---------- */
        '--chart-rank-width': px(c.chart.rankColumnWidth),
        '--chart-cover-width': px(c.chart.coverColumnWidth),
        '--chart-cover-radius': c.chart.coverRadius,
        '--chart-heat-width': px(c.chart.heatColumnWidth),
        '--chart-duration-width': px(c.chart.durationColumnWidth),
        '--chart-row-padding-y': px(c.chart.rowPaddingY),
        '--chart-row-padding-x': px(c.chart.rowPaddingX),
        '--chart-heat-bar-height': px(c.chart.heatBarHeight),
        '--chart-hover-bg': t(c.chart.hoverBg),
        '--chart-playing-bg': t(c.chart.playingBg),
        '--chart-rank-first': t(c.chart.rankFirstColor),
        '--chart-rank-second': t(c.chart.rankSecondColor),
        '--chart-rank-third': t(c.chart.rankThirdColor),
    };

    return vars;
}

/** 应用一组 CSS 变量到目标元素（默认 `<html>`）。 */
export function applyCssVars(vars: CssVarMap, el?: HTMLElement): void {
    const target = el ?? document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
        target.style.setProperty(key, value);
    }
}
