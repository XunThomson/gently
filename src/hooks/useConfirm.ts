import {useCallback} from 'react';
import {useActions} from '../store';
import type {ConfirmRequest} from '../store/types';

/**
 * 危险操作的二次确认入口。
 *
 * 用法：
 * ```tsx
 * const confirm = useConfirm();
 * confirm({
 *     titleKey: 'confirm.clearQueueTitle',
 *     descKey: 'confirm.clearQueueDesc',
 *     tone: 'danger',
 *     onConfirm: () => clearQueue(),
 * });
 * ```
 *
 * - 默认弹窗确认；
 * - 用户在设置里关闭「危险操作前二次确认」后，直接执行 `onConfirm`；
 * - 组件不需要关心弹窗渲染（由 App 里的 `ConfirmHost` 统一承载）。
 */
export function useConfirm() {
    const requestConfirm = useActions().dialog.requestConfirm;

    return useCallback(
        (request: Omit<ConfirmRequest, 'id'>) => {
            requestConfirm(request);
        },
        [requestConfirm],
    );
}

export type {ConfirmRequest};
