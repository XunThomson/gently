import type {ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import type {ColorScheme} from '../../../theme';
import {
    IconBulb,
    IconClose,
    IconLyrics,
    IconMaximize,
    IconMinimize,
    IconPalette,
    IconPip,
    IconGear,
    IconRestore,
} from '../../ui/icon';
import styles from './title-bar.module.css';

export interface ToolbarProps {
    /** 当前配色方案（灯泡亮/暗状态） */
    scheme?: ColorScheme;
    /** 明暗背景一键切换 */
    onSchemeToggle?: () => void;
    /** 打开主题市场 */
    onThemeMarketClick?: () => void;
    onSettingsClick?: () => void;
    /** 悬浮小窗（置顶小尺寸）开关 */
    onCompactClick?: () => void;
    compact?: boolean;
    /** 桌面歌词窗口（独立置顶窗口）开关 */
    onDesktopLyricsClick?: () => void;
    desktopLyricsOpen?: boolean;
    /**
     * 是否可用原生窗口控制。
     * 浏览器 / vite dev 下没有 Tauri 宿主，按钮必须禁用，
     * 否则会出现「点了没反应」的 UI 与效果不一致。
     */
    windowControlsEnabled?: boolean;
    /** 窗口当前是否最大化（决定最后一个窗口按钮是「最大化」还是「向下还原」） */
    maximized?: boolean;
    onMinimizeClick?: () => void;
    onMaximizeClick?: () => void;
    onCloseClick?: () => void;
}

/**
 * 顶部工具栏。
 * 三个应用级入口职责互不重叠：
 * - 灯泡  → 明暗背景切换
 * - 调色板 → 主题市场（预设主题）
 * - 齿轮  → 设置
 * 右侧为原生窗口控制。
 */
export function Toolbar({
    scheme = 'light',
    onSchemeToggle,
    onThemeMarketClick,
    onSettingsClick,
    onCompactClick,
    compact = false,
    onDesktopLyricsClick,
    desktopLyricsOpen = false,
    windowControlsEnabled = false,
    maximized = false,
    onMinimizeClick,
    onMaximizeClick,
    onCloseClick,
}: ToolbarProps) {
    const {t} = useTranslation();

    const lightOn = scheme === 'light';

    const button = (
        label: string,
        icon: ReactNode,
        onClick?: () => void,
        options: {pressed?: boolean; className?: string; disabled?: boolean} = {},
    ) => (
        <button
            type="button"
            className={[styles.toolbarButton, options.className].filter(Boolean).join(' ')}
            aria-label={label}
            title={label}
            aria-pressed={options.pressed}
            disabled={options.disabled}
            onClick={onClick}
        >
            {icon}
        </button>
    );

    return (
        <div className={styles.toolbar}>
            {button(
                lightOn ? t('toolbar.switchToDark') : t('toolbar.switchToLight'),
                <IconBulb size={18}/>,
                onSchemeToggle,
                {pressed: lightOn, className: lightOn ? styles.bulbOn : styles.bulbOff},
            )}
            {button(t('toolbar.themeMarket'), <IconPalette size={18}/>, onThemeMarketClick)}
            {button(t('toolbar.settings'), <IconGear size={18}/>, onSettingsClick)}

            <div className={styles.toolbarDivider} aria-hidden="true"/>

            {button(t('toolbar.pip'), <IconPip size={18}/>, onCompactClick, {
                pressed: compact,
                disabled: !windowControlsEnabled,
            })}
            {button(t('toolbar.desktopLyrics'), <IconLyrics size={18}/>, onDesktopLyricsClick, {
                pressed: desktopLyricsOpen,
                disabled: !windowControlsEnabled,
            })}
            {button(t('toolbar.minimize'), <IconMinimize size={18}/>, onMinimizeClick, {
                disabled: !windowControlsEnabled,
            })}
            {/* 最大化 / 向下还原：**图标 + 文案都要区分**，否则用户看不出当前状态 */}
            {button(
                maximized ? t('toolbar.restore') : t('toolbar.maximize'),
                maximized ? <IconRestore size={18}/> : <IconMaximize size={18}/>,
                onMaximizeClick,
                {disabled: !windowControlsEnabled},
            )}
            {button(t('toolbar.close'), <IconClose size={18}/>, onCloseClick, {
                disabled: !windowControlsEnabled,
            })}
        </div>
    );
}

export default Toolbar;
