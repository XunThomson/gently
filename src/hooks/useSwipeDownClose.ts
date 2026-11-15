import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject} from 'react';

/**
 * 底部面板「下拉关闭」手势（R145）。
 *
 * 只绑在抓手 / 标题这类**没有滚动语义**的区域：动作列表和输入框要能正常触摸，
 * 整块面板捕获指针会把滚动和点击一起吃掉（R139 的教训）。
 *
 * 用法：
 * ```tsx
 * const {dragY, dragging, bind} = useSwipeDownClose(onClose);
 * <div {...bind} className={styles.grabber} />
 * <div className={styles.sheet} data-dragging={dragging}
 *      style={dragY > 0 ? {transform: `translateY(${dragY}px)`} : undefined}>
 * ```
 */
export function useSwipeDownClose(
    onClose: () => void,
    threshold = 80,
    sheetRef?: RefObject<HTMLElement | null>,
    enabled = true,
) {
    const [dragY, setDragY] = useState(0);
    const [dragging, setDragging] = useState(false);
    const state = useRef<{id: number; startY: number; active: boolean} | null>(null);

    const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (!event.isPrimary) return;
        const target = event.target as HTMLElement | null;
        /* 按钮 / 输入 / 滑杆上不抢手势：点关闭、切 tab、拖进度都要照常 */
        if (target?.closest('button, input, textarea, [role="slider"]')) return;
        state.current = {id: event.pointerId, startY: event.clientY, active: false};
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        const start = state.current;
        if (!start || start.id !== event.pointerId) return;
        const dy = event.clientY - start.startY;
        if (!start.active && dy > 4) {
            start.active = true;
            setDragging(true);
        }
        if (start.active) setDragY(Math.max(0, dy));
    };

    const finish = (event: ReactPointerEvent<HTMLElement>) => {
        const start = state.current;
        if (!start || start.id !== event.pointerId) return;
        const dy = Math.max(0, event.clientY - start.startY);
        state.current = null;
        setDragging(false);
        setDragY(0);
        if (start.active && dy >= threshold) onClose();
    };

    /**
     * 触摸下滑（R145）：除了抓手，也允许从面板内容区下滑。
     * 只有内容已经滚到顶部时才接管，否则让列表正常滚动；按钮/输入/滑杆不抢。
     * 用原生 touch 事件而不是 pointer：Android WebView 在滚动开始后会 cancel pointer。
     */
    const dragYRef = useRef(0);
    dragYRef.current = dragY;
    useEffect(() => {
        const root = sheetRef?.current;
        if (!root || !enabled) return;
        let startY = 0;
        let active = false;
        let tracking = false;

        const atTop = (target: EventTarget | null): boolean => {
            let element = target as HTMLElement | null;
            while (element && element !== root) {
                if (element.scrollHeight > element.clientHeight + 1) {
                    return element.scrollTop <= 0;
                }
                element = element.parentElement;
            }
            return true;
        };

        const onTouchStart = (event: TouchEvent) => {
            if (event.touches.length !== 1) return;
            const target = event.target as HTMLElement | null;
            /* 触屏上按在按钮上也算起点：只有真正拖动 >8px 才接管，
               轻点仍然会正常触发按钮。输入框 / 滑杆则完全排除。 */
            if (target?.closest('input, textarea, [role="slider"], [role="radio"]')) return;
            if (!atTop(target)) return;
            tracking = true;
            active = false;
            startY = event.touches[0].clientY;
        };

        const onTouchMove = (event: TouchEvent) => {
            if (!tracking || event.touches.length !== 1) return;
            const dy = event.touches[0].clientY - startY;
            if (dy <= 0) {
                active = false;
                setDragY(0);
                return;
            }
            if (!active && dy > 8) {
                if (!atTop(event.target)) {
                    tracking = false;
                    return;
                }
                active = true;
                setDragging(true);
            }
            if (!active) return;
            event.preventDefault();
            setDragY(dy);
        };

        const onTouchEnd = () => {
            if (!tracking) return;
            tracking = false;
            setDragging(false);
            setDragY(0);
            if (active && dragYRef.current >= threshold) onClose();
            active = false;
        };

        root.addEventListener('touchstart', onTouchStart, {passive: true});
        root.addEventListener('touchmove', onTouchMove, {passive: false});
        root.addEventListener('touchend', onTouchEnd);
        root.addEventListener('touchcancel', onTouchEnd);
        return () => {
            root.removeEventListener('touchstart', onTouchStart);
            root.removeEventListener('touchmove', onTouchMove);
            root.removeEventListener('touchend', onTouchEnd);
            root.removeEventListener('touchcancel', onTouchEnd);
        };
    }, [enabled, onClose, sheetRef, threshold]);

    return {
        dragY,
        dragging,
        bind: {
            onPointerDown,
            onPointerMove,
            onPointerUp: finish,
            onPointerCancel: finish,
        },
    };
}

export default useSwipeDownClose;
