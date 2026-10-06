import React from "react";

// ============================== 图标组件 ==============================

const IconSparkles = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <path d="M9 3L10.5 7.5L15 9L10.5 10.5L9 15L7.5 10.5L3 9L7.5 7.5L9 3Z" />
        <path d="M17 12L17.8 14.2L20 15L17.8 15.8L17 18L16.2 15.8L14 15L16.2 14.2L17 12Z" />
        <path d="M17 5L17.6 6.4L19 7L17.6 7.6L17 9L16.4 7.6L15 7L16.4 6.4L17 5Z" />
    </svg>
);

const IconTshirt = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <path d="M15 3L18 6L16 8L16 20H8V8L6 6L9 3C9 3 10 5 12 5C14 5 15 3 15 3Z" />
    </svg>
);

const IconGear = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
    </svg>
);

const IconPiP = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="12" y="12" width="6" height="6" rx="1" />
    </svg>
);

const IconMinimize = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <path d="M5 12h14" />
    </svg>
);

const IconMaximize = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
);

const IconClose = ({ size = 18 }: { size?: number }) => (
    <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    >
        <path d="M6 6L18 18M18 6L6 18" />
    </svg>
);

// ============================== 组件 ==============================

export interface ToolbarProps {
    /** 点击 AI/魔法按钮 */
    onAiClick?: () => void;
    /** 点击主题/服装按钮 */
    onThemeClick?: () => void;
    /** 点击设置按钮 */
    onSettingsClick?: () => void;
    /** 点击画中画按钮 */
    onPiPClick?: () => void;
    /** 点击最小化按钮 */
    onMinimizeClick?: () => void;
    /** 点击最大化按钮 */
    onMaximizeClick?: () => void;
    /** 点击关闭按钮 */
    onCloseClick?: () => void;
    className?: string;
    style?: React.CSSProperties;
}

const Toolbar: React.FC<ToolbarProps> = ({
                                             onAiClick,
                                             onThemeClick,
                                             onSettingsClick,
                                             onPiPClick,
                                             onMinimizeClick,
                                             onMaximizeClick,
                                             onCloseClick,
                                             className,
                                             style,
                                         }) => {
    const iconColor = "rgba(255, 255, 255, 0.85)";

    const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "rgba(255, 255, 255, 0.15)";
        e.currentTarget.style.color = "#fff";
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = iconColor;
    };

    const baseBtnStyle: React.CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        padding: 0,
        border: 0,
        background: "transparent",
        borderRadius: 6,
        color: iconColor,
        cursor: "pointer",
        transition: "background-color 0.15s, color 0.15s",
    };

    const renderButton = (
        icon: React.ReactNode,
        label: string,
        onClick?: () => void,
    ) => (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            style={baseBtnStyle}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {icon}
        </button>
    );

    return (
        <div
            className={className}
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "6px 10px",
                borderRadius: 12,
                ...style,
            }}
        >
            {/* 左侧功能组 */}
            {renderButton(<IconSparkles />, "AI 助手", onAiClick)}
            {renderButton(<IconTshirt />, "主题外观", onThemeClick)}
            {renderButton(<IconGear />, "设置", onSettingsClick)}

            {/* 分隔线 */}
            <div
                aria-hidden="true"
                style={{
                    width: 1,
                    height: 16,
                    margin: "0 8px",
                    background: "rgba(255, 255, 255, 0.3)",
                    flexShrink: 0,
                }}
            />

            {/* 右侧窗口控制组 */}
            {renderButton(<IconPiP />, "画中画", onPiPClick)}
            {renderButton(<IconMinimize />, "最小化", onMinimizeClick)}
            {renderButton(<IconMaximize />, "最大化", onMaximizeClick)}
            {renderButton(<IconClose />, "关闭", onCloseClick)}
        </div>
    );
};

export default Toolbar;