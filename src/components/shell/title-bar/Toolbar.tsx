import type {ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import type {ColorScheme} from '../../../theme';
import {
    IconBulb,
    IconClose,
    IconMaximize,
    IconMinimize,
    IconPalette,
    IconPip,
    IconGear,
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
        options: {pressed?: boolean; className?: string} = {},
    ) => (
        <button
            type="button"
            className={[styles.toolbarButton, options.className].filter(Boolean).join(' ')}
            aria-label={label}
            title={label}
            aria-pressed={options.pressed}
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

            {button(t('toolbar.pip'), <IconPip size={18}/>, onCompactClick, {pressed: compact})}
            {button(t('toolbar.minimize'), <IconMinimize size={18}/>, onMinimizeClick)}
            {button(t('toolbar.maximize'), <IconMaximize size={18}/>, onMaximizeClick)}
            {button(t('toolbar.close'), <IconClose size={18}/>, onCloseClick)}
        </div>
    );
}

export default Toolbar;
