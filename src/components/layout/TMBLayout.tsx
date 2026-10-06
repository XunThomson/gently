import SplitLayout, { type SplitRegion } from "./SplitLayout";
import { VERTICAL_AXIS } from "./axis";
import type { TMBLayoutProps } from "./types";
import { HIDDEN_REGION } from "./utils";

export type { TMBLayoutProps, TMBLayoutConfig } from "./types";

export default function TMBLayout({
                                      config,
                                      top,
                                      main,
                                      bottom,
                                      className,
                                      style,
                                      onHeightChange,
                                  }: TMBLayoutProps) {
    const regions: [SplitRegion, SplitRegion, SplitRegion] = [
        { key: "top", config: config.top ?? HIDDEN_REGION, content: top },
        { key: "main", config: config.main, content: main },
        { key: "bottom", config: config.bottom ?? HIDDEN_REGION, content: bottom },
    ];

    const onSizeChange = onHeightChange
        ? (sizes: Record<string, number>) =>
            onHeightChange({
                top: sizes.top ?? 0,
                main: sizes.main ?? 0,
                bottom: sizes.bottom ?? 0,
            })
        : undefined;

    return (
        <SplitLayout
            axis={VERTICAL_AXIS}
            regions={regions}
            gap={config.gap}
            resizable={config.resizable}
            className={className}
            style={style}
            onSizeChange={onSizeChange}
        />
    );
}