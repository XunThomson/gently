import React from "react";
import type { AxisSpec } from "./axis";
import type { RegionConfig } from "./types";
import {
    buildRegionStyle,
    clamp,
    configsSignature,
    DEFAULT_GAP,
    isFlexible,
} from "./utils";

// ============================== 类型 ==============================

export interface SplitRegion {
    /** 稳定标识，用于 React key / 回调键名 */
    key: string;
    config: RegionConfig;
    content: React.ReactNode;
}

export interface SplitLayoutProps {
    axis: AxisSpec;
    /** 恰好三个区域，顺序即主轴顺序 */
    regions: [SplitRegion, SplitRegion, SplitRegion];
    gap?: number;
    resizable?: boolean;
    className?: string;
    style?: React.CSSProperties;
    /** 尺寸变化回调，按 key 返回三段尺寸 */
    onSizeChange?: (sizes: Record<string, number>) => void;
}

// ============================== 内部 ==============================

type Idx = 0 | 1 | 2;

interface DragState {
    before: Idx;
    after: Idx;
    startPos: number;
    startBefore: number;
    startAfter: number;
}

interface State {
    /** 用户拖拽产生的高度 / 宽度覆盖（按区域索引） */
    override: Partial<Record<Idx, number>>;
    dragging: DragState | null;
    hovering: Idx | null;
}

// ============================== 组件 ==============================

class SplitLayout extends React.Component<SplitLayoutProps, State> {
    state: State = { override: {}, dragging: null, hovering: null };

    private containerRef = React.createRef<HTMLDivElement>();
    private regionRefs: [
        React.RefObject<HTMLDivElement | null>,
        React.RefObject<HTMLDivElement | null>,
        React.RefObject<HTMLDivElement | null>,
    ] = [React.createRef(), React.createRef(), React.createRef()];

    private ro: ResizeObserver | null = null;
    private rafId: number | null = null;
    private lastKey = "";

    // ---------- 生命周期 ----------

    componentDidMount() {
        window.addEventListener("pointermove", this.handlePointerMove);
        window.addEventListener("pointerup", this.handlePointerUp);
        window.addEventListener("pointercancel", this.handlePointerUp);
        this.attachObservers();
    }

    componentDidUpdate(prev: SplitLayoutProps) {
        this.attachObservers();

        const before = configsSignature(prev.regions.map((r) => r.config));
        const after = configsSignature(this.props.regions.map((r) => r.config));
        if (before !== after && Object.keys(this.state.override).length > 0) {
            this.setState({ override: {}, dragging: null });
        }
    }

    componentWillUnmount() {
        window.removeEventListener("pointermove", this.handlePointerMove);
        window.removeEventListener("pointerup", this.handlePointerUp);
        window.removeEventListener("pointercancel", this.handlePointerUp);
        this.ro?.disconnect();
        this.ro = null;
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
        this.releaseDragUI();
    }

    // ---------- 尺寸观测 ----------

    private attachObservers() {
        if (!this.props.onSizeChange || typeof ResizeObserver === "undefined") return;
        if (!this.ro) this.ro = new ResizeObserver(this.scheduleEmit);

        const els: (HTMLElement | null)[] = [
            this.containerRef.current,
            ...this.regionRefs.map((r) => r.current),
        ];
        // observe 对同一元素幂等
        els.forEach((el) => el && this.ro!.observe(el));
    }

    private scheduleEmit = () => {
        if (this.rafId != null) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.emit();
        });
    };

    private emit() {
        const sizes = this.measure();
        const key = sizes.join("|");
        if (key === this.lastKey) return;
        this.lastKey = key;

        const cb = this.props.onSizeChange;
        if (!cb) return;
        const map: Record<string, number> = {};
        this.props.regions.forEach((r, i) => {
            map[r.key] = sizes[i];
        });
        cb(map);
    }

    private measure(): [number, number, number] {
        const prop = this.props.axis.measure;
        const get = (i: Idx) => Math.round(this.regionRefs[i].current?.[prop] ?? 0);
        return [get(0), get(1), get(2)];
    }

    // ---------- 拖拽 ----------

    private canResize(before: Idx, after: Idx): boolean {
        if (this.props.resizable === false) return false;
        const a = this.props.regions[before].config;
        const b = this.props.regions[after].config;
        if (a.resizable === false || b.resizable === false) return false;
        return isFlexible(a) || isFlexible(b);
    }

    private startDrag = (e: React.PointerEvent, before: Idx, after: Idx) => {
        e.preventDefault();
        const sizes = this.measure();
        this.setState({
            dragging: {
                before,
                after,
                startPos: e[this.props.axis.pointer],
                startBefore: sizes[before],
                startAfter: sizes[after],
            },
        });
        this.applyDragUI();
    };

    private handlePointerMove = (e: PointerEvent) => {
        const { dragging, override } = this.state;
        if (!dragging) return;

        const { axis, regions } = this.props;
        const { before, after, startPos, startBefore, startAfter } = dragging;
        const total = startBefore + startAfter;

        const cb = regions[before].config;
        const ca = regions[after].config;

        const lo = Math.max(cb.min ?? 0, total - (ca.max ?? Number.POSITIVE_INFINITY));
        const hi = Math.min(cb.max ?? Number.POSITIVE_INFINITY, total - (ca.min ?? 0));

        const delta = (e[axis.pointer] as number) - startPos;
        const next = clamp(startBefore + delta, lo, hi);

        this.setState({
            override: { ...override, [before]: next, [after]: total - next },
        });
    };

    private handlePointerUp = () => {
        if (!this.state.dragging) return;
        this.releaseDragUI();
        this.setState({ dragging: null });
    };

    private applyDragUI() {
        document.body.style.cursor = this.props.axis.cursor;
        document.body.style.userSelect = "none";
    }

    private releaseDragUI() {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    }

    // ---------- 渲染 ----------

    render() {
        const { axis, regions, gap = DEFAULT_GAP, className, style } = this.props;
        const { dragging, hovering, override } = this.state;

        const visible = ([0, 1, 2] as Idx[]).filter(
            (i) => regions[i].config.size !== "hidden",
        );

        const children: React.ReactNode[] = [];

        visible.forEach((idx, order) => {
            if (order > 0) {
                const beforeIdx = visible[order - 1];
                const afterIdx = idx;
                const dividerKey = regions[afterIdx].key;

                const resizable = gap > 0 && this.canResize(beforeIdx, afterIdx);
                const active = dragging?.after === afterIdx || hovering === afterIdx;

                children.push(
                    <div
                        key={`divider-${dividerKey}`}
                        role="separator"
                        aria-orientation={axis.ariaOrientation}
                        className={`${axis.regionClassPrefix}divider ${axis.regionClassPrefix}divider--${dividerKey}`}
                        style={{
                            flex: `0 0 ${gap}px`,
                            cursor: resizable ? axis.cursor : "default",
                            backgroundColor: resizable ? (active ? "#999" : "#e0e0e0") : "transparent",
                            transition: "background-color 0.15s",
                            userSelect: "none",
                            touchAction: "none",
                        }}
                        onPointerDown={
                            resizable ? (e) => this.startDrag(e, beforeIdx, afterIdx) : undefined
                        }
                        onPointerEnter={
                            resizable ? () => this.setState({ hovering: afterIdx }) : undefined
                        }
                        onPointerLeave={() => this.setState({ hovering: null })}
                    />,
                );
            }

            const region = regions[idx];
            const regionClassName =
                `${axis.regionClassPrefix}${region.key}` +
                (region.config.className ? ` ${region.config.className}` : "");

            children.push(
                <div
                    key={region.key}
                    ref={this.regionRefs[idx]}
                    className={regionClassName}
                    style={{
                        ...buildRegionStyle(axis, region.config, override[idx]),
                        ...region.config.style,
                    }}
                >
                    {region.content}
                </div>,
            );
        });

        return (
            <div
                ref={this.containerRef}
                className={[axis.layoutClass, className].filter(Boolean).join(" ")}
                style={{
                    display: "flex",
                    flexDirection: axis.direction,
                    width: "100%",
                    height: "100%",
                    ...style,
                }}
            >
                {children}
            </div>
        );
    }
}

export default SplitLayout;