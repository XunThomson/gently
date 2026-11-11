import {useCallback, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {useTranslation} from 'react-i18next';
import {useBackToClose} from '../../../hooks/useBackToClose';
import {useActions, useSelect} from '../../../store';
import {useSleepTimerRemaining} from '../../../hooks/useSleepTimer';
import {IconClose, IconMoon} from '../icon';
import styles from './SleepTimerSheet.module.css';

/** 预设时长选项（分钟） */
const PRESET_MINUTES = [15, 30, 45, 60, 90] as const;

export interface SleepTimerSheetProps {
    onClose: () => void;
}

/**
 * 定时关闭底部面板。
 *
 * 为什么是底部面板而不是弹窗：手机上「从底部滑出来的面板」是这类「一次性操作」的标准形态，
 * 与行操作面板共享视觉语言，用户已经熟悉这个交互模式。
 */
export function SleepTimerSheet({onClose}: SleepTimerSheetProps) {
    const {t} = useTranslation();
    const sleepTimerMode = useSelect((s) => s.ui.sleepTimerMode);
    const {setSleepTimer, setSleepTimerEndOfTrack, cancelSleepTimer} = useActions().ui;
    const remaining = useSleepTimerRemaining();

    /* 安卓系统返回 = 关闭面板 */
    useBackToClose(true, onClose);

    const handlePreset = useCallback((minutes: number) => {
        setSleepTimer(minutes);
        onClose();
    }, [setSleepTimer, onClose]);

    const handleEndOfTrack = useCallback(() => {
        setSleepTimerEndOfTrack();
        onClose();
    }, [setSleepTimerEndOfTrack, onClose]);

    const handleCancel = useCallback(() => {
        cancelSleepTimer();
        onClose();
    }, [cancelSleepTimer, onClose]);

    /* 格式化剩余时间 */
    const formatRemaining = useCallback((seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }, []);

    /* 面板挂到 body（R139）：播放条 / 外壳在**开启动态背景时**有 `backdrop-filter`，
       而带 filter 的祖先会成为 `position: fixed` 的包含块——面板会被困在 62px 高的播放条里，
       看起来「点了没反应」。portal 到 body 后 fixed 才真正相对视口。 */
    if (typeof document === 'undefined') return null;

    return createPortal(
        <div className={styles.sheetRoot} onClick={onClose}>
            <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
                <div className={styles.grabber}>
                    <div className={styles.grabberBar}/>
                </div>

                <div className={styles.header}>
                    <span className={styles.title}>{t('sleepTimer.title')}</span>
                    <button
                        type="button"
                        className={styles.closeBtn}
                        aria-label={t('common.cancel')}
                        onClick={onClose}
                    >
                        <IconClose size={16}/>
                    </button>
                </div>

                <div className={styles.content}>
                    <div className={styles.options}>
                        {PRESET_MINUTES.map((minutes) => {
                            const isActive = sleepTimerMode === 'duration' && remaining !== null && remaining > 0;
                            /* 简化判断：当前选中时长 = 剩余时间落在该档位的 ±30 秒区间内 */
                            const isThisPreset = isActive && remaining !== null &&
                                Math.abs(remaining - minutes * 60) < 30;
                            return (
                                <button
                                    key={minutes}
                                    type="button"
                                    className={isThisPreset ? styles.optionActive : styles.option}
                                    onClick={() => handlePreset(minutes)}
                                >
                                    <span className={styles.optionIcon}>
                                        <IconMoon size={18}/>
                                    </span>
                                    {t('sleepTimer.minutes', {count: minutes})}
                                </button>
                            );
                        })}
                        <button
                            type="button"
                            className={sleepTimerMode === 'endOfTrack' ? styles.optionActive : styles.option}
                            onClick={handleEndOfTrack}
                        >
                            <span className={styles.optionIcon}>
                                <IconMoon size={18}/>
                            </span>
                            {t('sleepTimer.endOfTrack')}
                        </button>
                    </div>

                    {/* 活跃定时：显示剩余时间 */}
                    {sleepTimerMode && remaining !== null && (
                        <div className={styles.activeInfo}>
                            <span className={styles.activeLabel}>{t('sleepTimer.remaining')}</span>
                            <span className={styles.activeTime}>{formatRemaining(remaining)}</span>
                        </div>
                    )}

                    {/* 取消按钮 */}
                    {sleepTimerMode && (
                        <button
                            type="button"
                            className={styles.cancelBtn}
                            onClick={handleCancel}
                        >
                            {t('sleepTimer.cancel')}
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * 定时关闭按钮：显示在播放条上，点击打开定时面板。
 * 定时活跃时显示剩余时间徽标。
 */
export function SleepTimerButton() {
    const [open, setOpen] = useState(false);
    const sleepTimerMode = useSelect((s) => s.ui.sleepTimerMode);
    const remaining = useSleepTimerRemaining();
    const {t} = useTranslation();

    /* 格式化简短剩余时间（如 "12:34" → "12:34"） */
    const formatShort = useCallback((seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }, []);

    /* 定时活跃时每秒刷新显示 */
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!sleepTimerMode) return;
        const interval = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(interval);
    }, [sleepTimerMode]);

    const isActive = sleepTimerMode !== null && remaining !== null;

    return (
        <>
            <button
                type="button"
                className={styles.triggerBtn}
                aria-label={t('sleepTimer.title')}
                data-active={isActive || undefined}
                onClick={() => setOpen(true)}
            >
                <IconMoon size={18}/>
                {isActive && remaining !== null && (
                    <span className={styles.badge}>{formatShort(remaining)}</span>
                )}
            </button>
            {open && <SleepTimerSheet onClose={() => setOpen(false)}/>}
        </>
    );
}

export default SleepTimerSheet;
