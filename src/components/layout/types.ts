import type React from "react";

export type SizeMode = "hidden" | "fixed" | "auto" | "ratio";

export interface RegionConfig {
    size: SizeMode;
    /** fixed → 像素值；ratio → 权重。auto / hidden 忽略。 */
    value?: number;
    min?: number;
    max?: number;
    /** 内容溢出时是否滚动，默认 true。 */
    scroll?: boolean;
    /** 相邻分隔条是否可拖。默认 true。 */
    resizable?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

export interface LayoutConfigBase {
    /** 分隔条尺寸 = 区域间隔。默认 6，设为 0 则无间隔。 */
    gap?: number;
    /** 顶层拖拽总开关，默认 true。单区域 resizable:false 可再覆盖。 */
    resizable?: boolean;
}

export interface TMBLayoutConfig extends LayoutConfigBase {
    top?: RegionConfig;
    main: RegionConfig;
    bottom?: RegionConfig;
}

export interface LMRLayoutConfig extends LayoutConfigBase {
    left?: RegionConfig;
    main: RegionConfig;
    right?: RegionConfig;
}

export interface TMBLayoutProps {
    config: TMBLayoutConfig;
    top?: React.ReactNode;
    main: React.ReactNode;
    bottom?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    onHeightChange?: (heights: { top: number; main: number; bottom: number }) => void;
}

export interface LMRLayoutProps {
    config: LMRLayoutConfig;
    left?: React.ReactNode;
    main: React.ReactNode;
    right?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    onWidthChange?: (widths: { left: number; main: number; right: number }) => void;
}