import {createContext, useMemo, useRef, useState, type ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {useBackToClose} from '../../../hooks/useBackToClose';
import type {RowAction} from '../data-table';
import styles from './RowActions.module.css';

export interface RowActionsRequest {
    /** 面板标题：让用户知道自己在操作哪一行（手机上没有表头可参考） */
    title: string;
    actions: RowAction[];
}

export interface RowActionsApi {
    open: (request: RowActionsRequest) => void;
    close: () => void;
}

/**
 * 行操作的宿主句柄。
 *
 * 手机上没有「行内一排小按钮」这种东西（放不下、也点不准），
 * 所以列表行右上角只留一个 ⋯，点开是**底部操作面板**——这是安卓的原生做法，
 * 也是 polished-ui 的 `mobile-layout.md` 建议的「密集信息用 bottom sheet 做渐进披露」。
 *
 * 没有宿主时（桌面端、或冒烟测试里直接渲染表格）值是 `null`，
 * `MobileRowActions` 据此**退回行内按钮**：宁可多几个按钮，也不要一个点了没反应的 ⋯。
 */
export const RowActionsContext = createContext<RowActionsApi | null>(null);

/**
 * 底部操作面板的宿主：挂在手机外壳里一次即可。
 *
 * 为什么宿主必须比列表**高一层**：面板要盖住整个屏幕（含常驻播放条），
 * 放在表格行里会被单元格的 `overflow: hidden` 与滚动容器裁掉。
 * 状态是本组件自己的（一次只有一个面板），不进 store——它没有跨页面含义，
 * 换页/卸载时跟着一起消失才是对的。
 */
export function RowActionsProvider({children}: { children: ReactNode }) {
    const {t} = useTranslation();
    const [request, setRequest] = useState<RowActionsRequest | null>(null);

    /* 引用恒定：不然每次渲染都换一个新 api 对象，所有 ⋯ 按钮都会白重渲染一遍 */
    const api = useMemo<RowActionsApi>(
        () => ({
            open: (next) => setRequest(next),
            close: () => setRequest(null),
        }),
        [],
    );

    /* 安卓的系统返回 / 返回手势 = 收起面板（与抽屉一致，R121） */
    useBackToClose(request !== null, api.close);

    /* 面板下拉收起（R125，#1 的手势补齐）：底部面板的常规手势是「往下拖走」。
       左边缘横滑那条路走不通（被系统返回吞掉，见 GOTCHAS §67），但下拉不冲突。
       拖动时只跟位移、不打断点击：位移小于阈值松手就弹回原处。 */
    const [dragY, setDragY] = useState(0);
    const dragStart = useRef<number | null>(null);
    const onSheetPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        dragStart.current = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onSheetPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (dragStart.current === null) return;
        setDragY(Math.max(0, event.clientY - dragStart.current));
    };
    const onSheetPointerUp = () => {
        if (dragStart.current === null) return;
        const moved = dragY;
        dragStart.current = null;
        setDragY(0);
        if (moved > 48) api.close();
    };

    return (
        <RowActionsContext.Provider value={api}>
            {children}

            {request && (
                <div
                    className={styles.root}
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('mobile.actionsFor', {name: request.title})}
                    /* 点面板外的空白 = 关掉。**挂在根 div 上**而不是那块透明 `<button>`：
                       真机上「铺满屏幕且不涂色的 button」不收点击（GOTCHAS §55）。 */
                    onClick={api.close}
                >
                    <button
                        type="button"
                        className={styles.scrim}
                        aria-label={t('common.cancel')}
                        onClick={api.close}
                    />

                    <div
                        className={styles.sheet}
                        style={dragY > 0 ? {transform: `translateY(${dragY}px)`} : undefined}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={onSheetPointerDown}
                        onPointerMove={onSheetPointerMove}
                        onPointerUp={onSheetPointerUp}
                        onPointerCancel={onSheetPointerUp}
                    >
                        <span className={styles.grabber} aria-hidden="true"/>
                        <p className={styles.title}>{request.title}</p>

                        <div className={styles.actions}>
                            {request.actions.map((action) => (
                                <button
                                    key={action.key}
                                    type="button"
                                    className={`${styles.action} ${styles[`action_${action.tone ?? 'default'}`]}`}
                                    disabled={action.disabled}
                                    onClick={() => {
                                        /* 先收起面板再执行：动作可能弹二次确认（危险操作走 useConfirm） */
                                        api.close();
                                        action.onClick();
                                    }}
                                >
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </RowActionsContext.Provider>
    );
}

export default RowActionsProvider;
