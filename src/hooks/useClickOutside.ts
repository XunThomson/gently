import {useEffect, type RefObject} from 'react';

/**
 * 点击元素外部时触发回调。
 * 使用 pointerdown，比 click 更早、覆盖触屏。
 */
export function useClickOutside<T extends HTMLElement>(
    ref: RefObject<T | null>,
    handler: (e: PointerEvent) => void,
    enabled = true,
) {
    useEffect(() => {
        if (!enabled) return;

        const listener = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) handler(e);
        };

        document.addEventListener('pointerdown', listener);
        return () => document.removeEventListener('pointerdown', listener);
    }, [ref, handler, enabled]);
}
