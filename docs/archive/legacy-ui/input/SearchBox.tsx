import React from "react";

// ============================== 类型 ==============================

export type SearchBoxSize = "sm" | "md" | "lg";

export interface SearchBoxProps
    extends Omit<
        React.InputHTMLAttributes<HTMLInputElement>,
        "size" | "value" | "defaultValue" | "onChange"
    > {
    /** 受控值 */
    value?: string;
    /** 非受控初始值 */
    defaultValue?: string;
    /** 输入变化。参数是字符串而非事件。 */
    onChange?: (value: string) => void;
    /** 回车 / 输入法确认 / 移动端「搜索」键触发 */
    onSearch?: (value: string) => void;
    /** 点击清除按钮或按 Escape 清空时触发 */
    onClear?: () => void;
    /** 尺寸，默认 md */
    size?: SearchBoxSize;
    /** 加载态：右侧显示 spinner，并隐藏清除按钮 */
    loading?: boolean;
    /** 是否显示清除按钮，默认 true */
    allowClear?: boolean;
}

// ============================== 常量 ==============================

interface SizeSpec {
    height: number;
    font: number;
    pad: number;
    icon: number;
    radius: number;
}

const SIZES: Record<SearchBoxSize, SizeSpec> = {
    sm: { height: 28, font: 13, pad: 8,  icon: 14, radius: 6  },
    md: { height: 36, font: 14, pad: 10, icon: 16, radius: 8  },
    lg: { height: 44, font: 15, pad: 12, icon: 18, radius: 10 },
};

const C = {
    border:       "#d4d4d8",
    borderFocus:  "#3b82f6",
    ring:         "rgba(59,130,246,0.15)",
    icon:         "#71717a",
    iconDisabled: "#a1a1aa",
    iconActive:   "#18181b",
    text:         "#18181b",
    bg:           "#ffffff",
    bgDisabled:   "#f4f4f5",
} as const;

// ============================== 图标 ==============================

const IconSearch = ({ size }: { size: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" aria-hidden="true"
    >
        <circle cx="11" cy="11" r="7" />
        <path d="M16.5 16.5 21 21" />
    </svg>
);

const IconClear = ({ size }: { size: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" aria-hidden="true"
    >
        <path d="M6 6 18 18M18 6 6 18" />
    </svg>
);

const IconSpinner = ({ size }: { size: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" aria-hidden="true"
        style={{ animation: "sbox-spin 0.7s linear infinite" }}
    >
        <circle cx="12" cy="12" r="9" opacity={0.25} />
        <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
);

// ============================== 组件 ==============================

const SearchBox = React.forwardRef<HTMLInputElement, SearchBoxProps>(
    function SearchBox(
        {
            value,
            defaultValue = "",
            onChange,
            onSearch,
            onClear,
            placeholder = "搜索…",
            size = "md",
            loading = false,
            allowClear = true,
            disabled = false,
            className,
            style,
            onFocus,
            onBlur,
            onKeyDown,
            "aria-label": ariaLabel,
            ...inputRest
        },
        forwardedRef,
    ) {
        // ---------- 受控 / 非受控 ----------
        const isControlled = value !== undefined;
        const [inner, setInner] = React.useState(defaultValue);
        const current = isControlled ? value : inner;

        const setValue = React.useCallback(
            (next: string) => {
                if (!isControlled) setInner(next);
                onChange?.(next);
            },
            [isControlled, onChange],
        );

        // ---------- 本地状态 ----------
        const [focused, setFocused] = React.useState(false);
        const [clearHover, setClearHover] = React.useState(false);

        const inputRef = React.useRef<HTMLInputElement>(null);
        React.useImperativeHandle(
            forwardedRef,
            () => inputRef.current as HTMLInputElement,
        );

        const focusInput = () => inputRef.current?.focus();

        // ---------- 事件 ----------

        const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
            setValue(e.target.value);
        };

        const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;

            if (e.key === "Enter") {
                // 输入法组合过程中的 Enter 不算确认
                if ((e.nativeEvent as KeyboardEvent).isComposing) return;
                e.preventDefault();
                onSearch?.(current);
            } else if (e.key === "Escape" && current) {
                e.preventDefault();
                setValue("");
                onClear?.();
            }
        };

        const handleClear = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            setValue("");
            onClear?.();
            focusInput();
        };

        // ---------- 样式 ----------

        const s = SIZES[size];

        const rootStyle: React.CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            gap: Math.round(s.pad * 0.6),
            height: s.height,
            padding: `0 ${s.pad}px`,
            boxSizing: "border-box",
            borderRadius: s.radius,
            border: `1px solid ${focused ? C.borderFocus : C.border}`,
            backgroundColor: disabled ? C.bgDisabled : C.bg,
            boxShadow: focused ? `0 0 0 3px ${C.ring}` : "none",
            color: disabled ? C.iconDisabled : C.text,
            fontSize: s.font,
            lineHeight: 1,
            cursor: disabled ? "not-allowed" : "text",
            transition: "border-color .15s, box-shadow .15s, background-color .15s",
            ...style,
        };

        const inputStyle: React.CSSProperties = {
            flex: 1,
            minWidth: 0,
            height: "100%",
            padding: 0,
            margin: 0,
            border: 0,
            outline: 0,
            background: "transparent",
            color: "inherit",
            font: "inherit",
            cursor: "inherit",
        };

        const iconStyle: React.CSSProperties = {
            display: "inline-flex",
            flex: "0 0 auto",
            color: disabled ? C.iconDisabled : C.icon,
        };

        const showClear = allowClear && !disabled && !loading && current.length > 0;

        // ---------- 渲染 ----------

        return (
            <div
                className={["sbox", className].filter(Boolean).join(" ")}
                style={rootStyle}
                onClick={() => !disabled && focusInput()}
            >
        <span style={iconStyle}>
          <IconSearch size={s.icon} />
        </span>

                <input
                    {...inputRest}
                    ref={inputRef}
                    type="text"
                    role="searchbox"
                    enterKeyHint="search"
                    className="sbox__input"
                    style={inputStyle}
                    value={current}
                    placeholder={placeholder}
                    disabled={disabled}
                    aria-label={ariaLabel ?? placeholder}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    onFocus={(e) => {
                        setFocused(true);
                        onFocus?.(e);
                    }}
                    onBlur={(e) => {
                        setFocused(false);
                        onBlur?.(e);
                    }}
                />

                {loading ? (
                    <span style={iconStyle}>
            <IconSpinner size={s.icon} />
          </span>
                ) : showClear ? (
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-label="清除"
                        onClick={handleClear}
                        onMouseEnter={() => setClearHover(true)}
                        onMouseLeave={() => setClearHover(false)}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flex: "0 0 auto",
                            width: s.icon + 6,
                            height: s.icon + 6,
                            padding: 0,
                            border: 0,
                            borderRadius: "50%",
                            background: "transparent",
                            color: clearHover ? C.iconActive : C.icon,
                            cursor: "pointer",
                            transition: "color .12s",
                        }}
                    >
                        <IconClear size={s.icon - 2} />
                    </button>
                ) : null}
            </div>
        );
    },
);

export default SearchBox;

// ============================== 全局关键帧（仅注入一次） ==============================

if (
    typeof document !== "undefined" &&
    !document.getElementById("sbox-keyframes")
) {
    const el = document.createElement("style");
    el.id = "sbox-keyframes";
    el.textContent = "@keyframes sbox-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(el);
}