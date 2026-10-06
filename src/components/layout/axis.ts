/**
 * 描述「一条分割轴」上所有与方向相关的差异。
 * 基类只依赖这份描述符，不关心是 TMB 还是 LMR。
 */
export interface AxisSpec {
    /** 主轴方向 */
    direction: "column" | "row";
    /** 从 PointerEvent 取坐标的字段 */
    pointer: "clientX" | "clientY";
    /** 从 HTMLDivElement 取尺寸的字段 */
    measure: "clientWidth" | "clientHeight";
    /** 区域样式里的最小 / 最大约束属性 */
    minProp: "minWidth" | "minHeight";
    maxProp: "maxWidth" | "maxHeight";
    /** 拖拽时 body 光标 */
    cursor: "col-resize" | "row-resize";
    /** 分隔条 aria-orientation（与区域排列方向相反） */
    ariaOrientation: "vertical" | "horizontal";
    /** 顶层容器 class */
    layoutClass: string;
    /** 区域 / 分隔条 class 前缀 */
    regionClassPrefix: string;
}

export const VERTICAL_AXIS: AxisSpec = {
    direction: "column",
    pointer: "clientY",
    measure: "clientHeight",
    minProp: "minHeight",
    maxProp: "maxHeight",
    cursor: "row-resize",
    ariaOrientation: "horizontal",
    layoutClass: "tmb-layout",
    regionClassPrefix: "tmb-layout__",
};

export const HORIZONTAL_AXIS: AxisSpec = {
    direction: "row",
    pointer: "clientX",
    measure: "clientWidth",
    minProp: "minWidth",
    maxProp: "maxWidth",
    cursor: "col-resize",
    ariaOrientation: "vertical",
    layoutClass: "lmr-layout",
    regionClassPrefix: "lmr-layout__",
};