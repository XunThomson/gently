import React from "react";
import IconChevronRight from "../icons/IconChevronRight.tsx";
import IconChevronDown from "../icons/IconChevronDown.tsx";
import {MenuRoute} from "../../router/routes.types.ts";
import {Link} from "react-router";
import {useTranslation} from "react-i18next";

// ============================== 类型 ==============================

export interface SidebarProps {
    /** 当前选中的菜单 key */
    activeKey?: string;
    /** 点击菜单项回调 */
    onSelect?: (key: string | number) => void;
    mainMenu?: MenuRoute[];
    /** 我的歌单数据 */
    playlists?: MenuRoute[];
    className?: string;
    style?: React.CSSProperties;
}

// ============================== 默认数据 ==============================

const DEFAULT_MAIN_MENU: MenuRoute[] = [];

const DEFAULT_PLAYLISTS: MenuRoute[] = [];

// ============================== 组件 ==============================

const Sidebar: React.FC<SidebarProps> = ({
                                             activeKey,
                                             onSelect,
                                             mainMenu = DEFAULT_MAIN_MENU,
                                             playlists = DEFAULT_PLAYLISTS,
                                             className,
                                             style,
                                         }) => {
    const [hoveredKey, setHoveredKey] = React.useState<string | null | number>(null);
    const { t } = useTranslation()

    // 主题色：淡金色/黄色
    const baseColor = "rgba(253, 230, 138, 0.85)";
    const hoverColor = "#fff";
    const activeColor = "#fff";
    const hoverBg = "rgba(255, 255, 255, 0.1)";
    const activeBg = "rgba(255, 255, 255, 0.15)";

    const baseItemStyle: React.CSSProperties = {
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderRadius: 8,
        cursor: "pointer",
        color: baseColor,
        fontSize: 14,
        fontWeight: 400,
        textDecoration: "none",
        transition: "background-color 0.15s, color 0.15s",
        userSelect: "none",
    };

    const getItemStyle = (key: string | number): React.CSSProperties => {
        const isActive = activeKey === key;
        const isHovered = hoveredKey === key;

        if (isActive) {
            return {
                ...baseItemStyle,
                background: activeBg,
                color: activeColor,
                fontWeight: 500,
            };
        }
        if (isHovered) {
            return {
                ...baseItemStyle,
                background: hoverBg,
                color: hoverColor,
            };
        }
        return baseItemStyle;
    };

    const renderItem = (item: MenuRoute) => (
        <Link to={item.path}>
            <div
                key={item.order}
                role="button"
                tabIndex={0}
                aria-label={item.labelKey}
                onClick={() => onSelect?.(item.order)}
                onMouseEnter={() => setHoveredKey(item.order)}
                onMouseLeave={() => setHoveredKey(null)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect?.(item.order);
                    }
                }}
                style={getItemStyle(item.order)}
            >
                {item.icon && <span style={{display: "flex", flexShrink: 0}}>{item.icon}</span>}
                <span style={{flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>
        {t(item.labelKey)}
      </span>
            </div>
        </Link>
    );

    const sectionTitleStyle: React.CSSProperties = {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 16px 6px",
        fontSize: 13,
        color: "rgba(253, 230, 138, 0.6)",
        fontWeight: 500,
        cursor: "pointer",
        userSelect: "none",
    };

    return (
        <nav
            className={className}
            style={{
                display: "flex",
                flexDirection: "column",
                width: 200,
                padding: "8px",
                boxSizing: "border-box",
                ...style,
            }}
        >
            {/* 主菜单 */}
            {mainMenu.map(renderItem)}

            {/* 我的歌单 */}
            <div style={sectionTitleStyle}>
                <span>我的歌单</span>
                <IconChevronDown/>
            </div>
            {playlists.map(renderItem)}

            {/* 我的收藏 */}
            <div style={sectionTitleStyle}>
                <span>我的收藏</span>
                <IconChevronRight/>
            </div>
        </nav>
    );
};

export default Sidebar;