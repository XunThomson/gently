import {useCallback, useEffect, useId, useRef} from 'react';
import type {KeyboardEvent, MouseEvent} from 'react';

import {Button} from '../button';
import {IconTrash} from '../icon';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
    title: string;
    description?: string;
    /** danger 用红色主按钮 + 危险色强调 */
    tone?: 'default' | 'danger';
    /** 「取消」按钮文案（由宿主解析 i18n） */
    cancelLabel: string;
    /** 「确认」按钮文案（由宿主解析 i18n） */
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * 二次确认弹窗（纯展示组件）。
 *
 * 交互契约：
 * - 打开时焦点落在「取消」上（危险操作的默认选择）；
 * - `Escape` 取消，`Enter` 确认（仅当焦点在弹窗内）；
 * - `Tab` / `Shift+Tab` 在弹窗内的按钮之间循环，焦点不逃出弹窗；
 * - 点击遮罩取消，点击弹窗内部不冒泡到遮罩。
 *
 * 文案全部由调用方（ConfirmHost）通过 i18n 解析后传入，本组件不含任何文案。
 * 焦点通过弹窗根节点查询按钮获得（Button 组件未暴露 ref）。
 */
export function ConfirmDialog({
    title,
    description,
    tone = 'default',
    cancelLabel,
    confirmLabel,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const uid = useId();
    const titleId = `${uid}-title`;
    const descId = `${uid}-desc`;
    const isDanger = tone === 'danger';

    /** 弹窗内可聚焦元素：只有两个按钮，顺序为「取消 → 确认」 */
    const buttonsIn = (): HTMLButtonElement[] =>
        Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);

    /* 打开即聚焦「取消」；关闭后的焦点归还由宿主决定 */
    useEffect(() => {
        buttonsIn()[0]?.focus();
    }, []);

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            const buttons = buttonsIn();

            switch (event.key) {
                /* 仅在焦点位于弹窗内时响应 Enter，避免背景控件触发确认 */
                case 'Enter': {
                    if (!dialogRef.current?.contains(document.activeElement)) return;
                    event.preventDefault();
                    onConfirm();
                    break;
                }
                case 'Escape': {
                    event.preventDefault();
                    onCancel();
                    break;
                }
                /* 焦点陷阱：Tab 到边界时回环，焦点不在弹窗内时拉回弹窗 */
                case 'Tab': {
                    if (buttons.length === 0) return;

                    const active = document.activeElement;
                    const inside = dialogRef.current?.contains(active) ?? false;
                    /* 反向 Tab 时把顺序倒过来，边界与回环目标随之互换 */
                    const order = event.shiftKey ? [...buttons].reverse() : buttons;
                    const edge = order[0];
                    const wrapTarget = order[order.length - 1];

                    if (!inside) {
                        event.preventDefault();
                        wrapTarget.focus();
                        return;
                    }
                    if (active === edge && buttons.length > 1) {
                        event.preventDefault();
                        wrapTarget.focus();
                    }
                    break;
                }
                default:
                    break;
            }
        },
        [onCancel, onConfirm],
    );

    /* 点击遮罩取消；弹窗自身只拦截冒泡，不触发任何动作 */
    const handleScrimMouseDown = useCallback(
        (event: MouseEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            onCancel();
        },
        [onCancel],
    );

    const handleDialogClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
    }, []);

    return (
        <div className={styles.scrim} onMouseDown={handleScrimMouseDown}>
            <div
                ref={dialogRef}
                className={[styles.dialog, isDanger && styles.isDanger]
                    .filter(Boolean)
                    .join(' ')}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descId : undefined}
                onClick={handleDialogClick}
                onKeyDown={handleKeyDown}
            >
                <div className={styles.head}>
                    {isDanger && (
                        <span className={styles.icon} aria-hidden="true">
                            <IconTrash size={20}/>
                        </span>
                    )}
                    <h2 className={styles.title} id={titleId}>
                        {title}
                    </h2>
                </div>

                {description && (
                    <p className={styles.desc} id={descId}>
                        {description}
                    </p>
                )}

                <div className={styles.actions}>
                    <Button variant="ghost" onClick={onCancel}>
                        {cancelLabel}
                    </Button>
                    <Button
                        variant={isDanger ? 'danger' : 'primary'}
                        className={isDanger ? styles.confirmDanger : undefined}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default ConfirmDialog;
