import type React from "react";
import type { AxisSpec } from "./axis";
import type { RegionConfig } from "./types";

export const DEFAULT_GAP = 6;

export const HIDDEN_REGION: RegionConfig = { size: "hidden" };

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 只有 ratio / auto 才能被压缩，fixed / hidden 不参与拖拽 */
export const isFlexible = (c: RegionConfig) => c.size === "ratio" || c.size === "auto";

/** 结构签名：size / value / min / max 变化时才需要丢弃拖拽残留 */
export function configsSignature(configs: readonly (RegionConfig | undefined)[]): string {
    return configs
        .map((c) => (c ? `${c.size}:${c.value ?? ""}:${c.min ?? ""}:${c.max ?? ""}` : "-"))
        .join("|");
}

/** 根据轴方向 + 区域配置 + 用户拖拽覆盖，算出该区域的 flex 样式 */
export function buildRegionStyle(
    axis: AxisSpec,
    config: RegionConfig,
    override: number | undefined,
): React.CSSProperties {
    const style: Record<string, unknown> = {
        overflow: config.scroll === false ? "visible" : "auto",
    };
    if (config.min != null) style[axis.minProp] = config.min;
    if (config.max != null) style[axis.maxProp] = config.max;

    // hidden 优先，避免残留 override 把隐藏区域顶出来
    if (config.size === "hidden") {
        style.display = "none";
        return style as React.CSSProperties;
    }
    if (override != null) {
        style.flex = `0 0 ${override}px`;
        return style as React.CSSProperties;
    }

    switch (config.size) {
        case "fixed":
            style.flex = `0 0 ${config.value ?? 0}px`;
            break;
        case "auto":
            style.flex = "0 0 auto";
            break;
        case "ratio":
            style.flex = `${config.value ?? 1} 1 0%`;
            break;
    }
    return style as React.CSSProperties;
}