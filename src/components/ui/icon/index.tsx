import type {ReactNode, SVGProps} from 'react';

/**
 * 图标集：统一的线稿风格图标。
 * 使用 `currentColor`，尺寸由 `size` 控制，颜色由父级 `color` 决定（可被主题 token 驱动）。
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
    size?: number;
}

interface SvgProps extends IconProps {
    children?: ReactNode;
    strokeWidth?: string | number;
}

function Svg({size = 18, strokeWidth = 1.6, fill = 'none', children, ...rest}: SvgProps) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill={fill}
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...rest}
        >
            {children}
        </svg>
    );
}

/* ============================== 导航 ============================== */

export const IconTrophy = (p: IconProps) => (
    <Svg {...p}>
        <path d="M8 21h8M12 17v4M6 4h12v4a6 6 0 0 1-12 0V4Z"/>
        <path d="M6 6H3v2a3 3 0 0 0 3 3M18 6h3v2a3 3 0 0 1-3 3"/>
    </Svg>
);

export const IconFire = (p: IconProps) => (
    <Svg {...p}>
        <path d="M12 2c0 4-4 6-4 10a4 4 0 0 0 8 0c0-2-1-3-1-5 3 1 5 4 5 7a8 8 0 0 1-16 0c0-5 4-8 8-12Z"/>
    </Svg>
);

export const IconDownload = (p: IconProps) => (
    <Svg {...p}>
        <path d="M12 3v12M7 10l5 5 5-5"/>
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
    </Svg>
);

export const IconFolder = (p: IconProps) => (
    <Svg {...p}>
        <path d="M4 6a2 2 0 0 1 2-2h3l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z"/>
    </Svg>
);

export const IconPuzzle = (p: IconProps) => (
    <Svg {...p}>
        <path d="M10 3v4a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2h2Zm0 0h4a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2h-4"/>
        <path d="M4 10h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10Z"/>
        <path d="M10 14v4M14 14v4"/>
    </Svg>
);

export const IconClock = (p: IconProps) => (
    <Svg {...p}>
        <circle cx="12" cy="12" r="9"/>
        <path d="M12 7v5l3 2"/>
    </Svg>
);

export const IconGear = (p: IconProps) => (
    <Svg {...p}>
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>
    </Svg>
);

/* ============================== 方向 / 状态 ============================== */

export const IconChevronDown = (p: IconProps) => (
    <Svg strokeWidth={2} {...p}>
        <path d="m6 9 6 6 6-6"/>
    </Svg>
);

export const IconChevronRight = (p: IconProps) => (
    <Svg strokeWidth={2} {...p}>
        <path d="m9 18 6-6-6-6"/>
    </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
    <Svg strokeWidth={2} {...p}>
        <path d="m15 18-6-6 6-6"/>
    </Svg>
);

/** 灯泡：明暗背景开关 */
export const IconBulb = (p: IconProps) => (
    <Svg {...p}>
        <path d="M12 3a5.6 5.6 0 0 0-3.3 10.13c.45.34.72.87.72 1.43V17h5.16v-2.44c0-.56.27-1.09.72-1.43A5.6 5.6 0 0 0 12 3Z"/>
        <path d="M9.6 20h4.8"/>
    </Svg>
);

export const IconSearch = (p: IconProps) => (
    <Svg strokeWidth={2} {...p}>
        <circle cx="11" cy="11" r="7"/>
        <path d="M20 20l-3.6-3.6"/>
    </Svg>
);

export const IconClose = (p: IconProps) => (
    <Svg strokeWidth={2} {...p}>
        <path d="M6 6l12 12M18 6L6 18"/>
    </Svg>
);

export const IconCalendar = (p: IconProps) => (
    <Svg {...p}>
        <rect x="3" y="5" width="18" height="16" rx="2"/>
        <path d="M3 10h18M8 3v4M16 3v4"/>
    </Svg>
);

/* ============================== 播放控制（实心） ============================== */

export const IconPlay = ({size = 14, ...rest}: IconProps) => (
    <Svg size={size} fill="currentColor" stroke="none" {...rest}>
        <path d="M7 4.5v15l13-7.5z"/>
    </Svg>
);

export const IconPause = ({size = 14, ...rest}: IconProps) => (
    <Svg size={size} fill="currentColor" stroke="none" {...rest}>
        <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>
    </Svg>
);

export const IconPrev = (p: IconProps) => (
    <Svg fill="currentColor" stroke="none" {...p}>
        <path d="M7 6h2v12H7zM19 6v12l-9-6z"/>
    </Svg>
);

export const IconNext = (p: IconProps) => (
    <Svg fill="currentColor" stroke="none" {...p}>
        <path d="M15 6h2v12h-2zM5 6v12l9-6z"/>
    </Svg>
);

export const IconRepeat = (p: IconProps) => (
    <Svg strokeWidth={1.9} {...p}>
        <path d="M17 2l3 3-3 3"/>
        <path d="M20 5H8a4 4 0 0 0-4 4v1"/>
        <path d="M7 22l-3-3 3-3"/>
        <path d="M4 19h12a4 4 0 0 0 4-4v-1"/>
    </Svg>
);

export const IconRepeatOne = (p: IconProps) => (
    <Svg strokeWidth={1.9} {...p}>
        <path d="M17 2l3 3-3 3"/>
        <path d="M20 5H8a4 4 0 0 0-4 4v1"/>
        <path d="M7 22l-3-3 3-3"/>
        <path d="M4 19h12a4 4 0 0 0 4-4v-1"/>
        <path d="M11.4 10.6h.9v3.4"/>
    </Svg>
);

export const IconVolume = (p: IconProps) => (
    <Svg strokeWidth={1.8} {...p}>
        <path d="M4 9v6h4l5 4V5L8 9H4z"/>
        <path d="M16.5 9a4.5 4.5 0 0 1 0 6"/>
    </Svg>
);

/* ============================== 窗口控制 ============================== */

export const IconSparkles = (p: IconProps) => (
    <Svg {...p}>
        <path d="M9 3L10.5 7.5L15 9L10.5 10.5L9 15L7.5 10.5L3 9L7.5 7.5L9 3Z"/>
        <path d="M17 12L17.8 14.2L20 15L17.8 15.8L17 18L16.2 15.8L14 15L16.2 14.2L17 12Z"/>
        <path d="M17 5L17.6 6.4L19 7L17.6 7.6L17 9L16.4 7.6L15 7L16.4 6.4L17 5Z"/>
    </Svg>
);

export const IconPalette = (p: IconProps) => (
    <Svg {...p}>
        <path d="M12 3a9 9 0 1 0 0 18c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.6-9-7.6Z"/>
        <circle cx="7.8" cy="11.5" r="1.1" fill="currentColor" stroke="none"/>
        <circle cx="10.6" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>
        <circle cx="15.2" cy="8.4" r="1.1" fill="currentColor" stroke="none"/>
    </Svg>
);

export const IconPip = (p: IconProps) => (
    <Svg {...p}>
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <rect x="12" y="12" width="6" height="6" rx="1"/>
    </Svg>
);

export const IconMinimize = (p: IconProps) => (
    <Svg {...p}>
        <path d="M5 12h14"/>
    </Svg>
);

export const IconMaximize = (p: IconProps) => (
    <Svg {...p}>
        <rect x="5" y="5" width="14" height="14" rx="1.5"/>
    </Svg>
);

/* ============================== 其它 ============================== */

export const IconHeart = (p: IconProps) => (
    <Svg {...p}>
        <path d="M12 21C7 16.5 3 13.5 3 9.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 3.5c0 4-4 7-9 11.5Z"/>
    </Svg>
);

export const IconMusic = (p: IconProps) => (
    <Svg {...p}>
        <path d="M9 18V5l10-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="16" cy="16" r="3"/>
    </Svg>
);

export const IconTrash = (p: IconProps) => (
    <Svg {...p}>
        <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13"/>
        <path d="M10 11v6M14 11v6"/>
    </Svg>
);

export const IconPlus = (p: IconProps) => (
    <Svg strokeWidth={2} {...p}>
        <path d="M12 5v14M5 12h14"/>
    </Svg>
);

export const IconFolderOpen = (p: IconProps) => (
    <Svg {...p}>
        <path d="M4 6a2 2 0 0 1 2-2h3l2 3h6a2 2 0 0 1 2 2v1"/>
        <path d="M3 10h18l-2 8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2l-1-8Z"/>
    </Svg>
);
