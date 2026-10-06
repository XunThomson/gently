/* ==================== hooks/useControllableValue.ts ==================== */
import { useCallback, useRef, useState } from 'react';

/**
 * 受控 / 非受控值统一管理
 * - 传了 value 走受控，内部不存状态
 * - 未传 value 用 defaultValue 初始化内部状态
 */
export function useControllableValue(
    valueProp: string | undefined,
    defaultValue: string,
    onChange?: (v: string) => void
) {
    const [inner, setInner] = useState(defaultValue);
    const isControlled = valueProp !== undefined;
    const value = isControlled ? valueProp : inner;

    // onChange 用 ref 持有，避免 setValue 依赖频繁变化
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const setValue = useCallback(
        (next: string) => {
            if (!isControlled) setInner(next);
            onChangeRef.current?.(next);
        },
        [isControlled]
    );

    return [value, setValue] as const;
}