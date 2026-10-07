import type {ConfirmRequest, DialogActions, DialogState, StoreCtx} from '../types';

/**
 * 二次确认切片：承载「危险操作」的确认请求。
 *
 * 视图/组件不直接弹窗，而是调用 `useConfirm()`：
 * - 开启确认时，请求进入本切片，由 `ConfirmHost` 渲染弹窗；
 * - 关闭确认时，直接执行 `onConfirm`（用户显式选择了「不要提示」）。
 */
export function createDialogSlice(ctx: StoreCtx) {
    const state: DialogState = {confirm: null};

    const actions: DialogActions = {
        requestConfirm(request: ConfirmRequest) {
            if (!ctx.getState().ui.confirmDestructive) {
                request.onConfirm();
                return;
            }
            ctx.setState({dialog: {confirm: request}});
        },

        resolveConfirm() {
            const {confirm} = ctx.getState().dialog;
            ctx.setState({dialog: {confirm: null}});
            confirm?.onConfirm();
        },

        cancelConfirm() {
            ctx.setState({dialog: {confirm: null}});
        },
    };

    return {key: 'dialog' as const, state, actions};
}
