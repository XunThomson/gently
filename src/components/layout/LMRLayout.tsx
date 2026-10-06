import SplitLayout, { type SplitRegion } from "./SplitLayout";
import { HORIZONTAL_AXIS } from "./axis";
import type { LMRLayoutProps } from "./types";
import { HIDDEN_REGION } from "./utils";

export type { LMRLayoutProps, LMRLayoutConfig } from "./types";

export default function LMRLayout({
                                      config,
                                      left,
                                      main,
                                      right,
                                      className,
                                      style,
                                      onWidthChange,
                                  }: LMRLayoutProps) {
    const regions: [SplitRegion, SplitRegion, SplitRegion] = [
        { key: "left", config: config.left ?? HIDDEN_REGION, content: left },
        { key: "main", config: config.main, content: main },
        { key: "right", config: config.right ?? HIDDEN_REGION, content: right },
    ];

    const onSizeChange = onWidthChange
        ? (sizes: Record<string, number>) =>
            onWidthChange({
                left: sizes.left ?? 0,
                main: sizes.main ?? 0,
                right: sizes.right ?? 0,
            })
        : undefined;

    return (
        <SplitLayout
            axis={HORIZONTAL_AXIS}
            regions={regions}
            gap={config.gap}
            resizable={config.resizable}
            className={className}
            style={style}
            onSizeChange={onSizeChange}
        />
    );
}