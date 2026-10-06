import type {ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {
    IconClose,
    IconMaximize,
    IconMinimize,
    IconPalette,
    IconGear,
    IconPip,
} from '../../ui/icon';
import styles from './title-bar.module.css';

export interface ToolbarProps {
    /** 切换主题模式（浅色 / 深色 / 跟随系统） */
    onAppearanceClick?: () => void;
    onSettingsClick?: () => void;
    /** 悬浮小窗（置顶小尺寸）开关 */
    onCompactClick?: () => void;
    compact?: boolean;
    onMinimizeClick?: () => void;
    onMaximizeClick?: () => void;
    onCloseClick?: () => void;
}

/** 顶部工具栏：应用级操作 + 原生窗口控制。 */
export function Toolbar({
    onAppearanceClick,
    onSettingsClick,
    onCompactClick,
    compact = false,
    onMinimizeClick,
    onMaximizeClick,
    onCloseClick,
}: ToolbarProps) {
    const {t} = useTranslation();

    const button = (label: string, icon: ReactNode, onClick?: () => void, pressed?: boolean) => (
        <button
            type="button"
            className={styles.toolbarButton}
            aria-label={label}
            title={label}
            aria-pressed={pressed}
            onClick={onClick}
        >
            {icon}
        </button>
    );

    return (
        <div className={styles.toolbar}>
            {button(t('toolbar.theme'), <IconPalette size={18}/>, onAppearanceClick)}
            {button(t('toolbar.settings'), <IconGear size={18}/>, onSettingsClick)}

            <div className={styles.toolbarDivider} aria-hidden="true"/>

            {button(t('toolbar.pip'), <IconPip size={18}/>, onCompactClick, compact)}
            {button(t('toolbar.minimize'), <IconMinimize size={18}/>, onMinimizeClick)}
            {button(t('toolbar.maximize'), <IconMaximize size={18}/>, onMaximizeClick)}
            {button(t('toolbar.close'), <IconClose size={18}/>, onCloseClick)}
        </div>
    );
}

export default Toolbar;
