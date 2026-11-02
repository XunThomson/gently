import {createContext, useMemo, useState, type ReactNode} from 'react';
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

                    <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
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
