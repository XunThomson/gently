import {useCallback} from 'react';
import {useTranslation} from 'react-i18next';

import {useActions, useDialogState} from '../../../store';
import {ConfirmDialog} from './ConfirmDialog';

/**
 * 二次确认的宿主：挂在应用根部（`App.tsx`）一次即可。
 *
 * 职责边界：
 * - 从 store 读取当前的确认请求，并负责 i18n 解析与 action 绑定；
 * - 没有请求时渲染 `null`；
 * - 视图不直接使用本组件，而是通过 `useConfirm()` 发起请求。
 */
export function ConfirmHost() {
    const {confirm} = useDialogState();
    const {resolveConfirm, cancelConfirm} = useActions().dialog;
    const {t} = useTranslation();

    const handleCancel = useCallback(() => {
        cancelConfirm();
    }, [cancelConfirm]);

    /* 确认动作由 store 承担：先清空请求，再执行该请求的 onConfirm */
    const handleConfirm = useCallback(() => {
        resolveConfirm();
    }, [resolveConfirm]);

    if (!confirm) return null;

    return (
        <ConfirmDialog
            title={t(confirm.titleKey)}
            description={confirm.descKey ? t(confirm.descKey, confirm.descParams) : undefined}
            tone={confirm.tone ?? 'default'}
            cancelLabel={t('common.cancel')}
            confirmLabel={t('common.confirm')}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
        />
    );
}

export default ConfirmHost;
