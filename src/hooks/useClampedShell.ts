import {useCallback, useEffect, useRef} from 'react';

/**
 * 让应用外壳**永远不要被滚动**（R137）。
 *
 * 现象：设置页点「列表展示方式」的选项后整页变白，DOM 还在、也没有报错。
 * 真机量出来是 `.app` 自己被滚了：`overflow: hidden` 只表示「不显示滚动条/不接受用户滚动」，
 * **它仍然是可编程滚动的容器**——`scrollIntoView` / 点击聚焦隐藏的 `radio` 都会让浏览器
 * 把容器横向或纵向滚过去。滚走之后露出的是一片空白（白屏），而用户**没法滚回来**
 * （hidden 不接受手指滚动），于是看起来就是「白屏且卡死」。
 *
 * 做法：外壳一旦被滚动，立刻归零（两个方向都归零）。真正的滚动只发生在内容区
 * （`.content` / 桌面各页自己的滚动容器），外壳本来就不该动。
 *
 * 另外补一个捕捉阶段的 `focusin`：聚焦引起的滚动常常发生在同一拍里，
 * 只听 `scroll` 有时会漏（滚动事件被合并）；聚焦后再归零一次最稳。
 */
export function useClampedShell(): (node: HTMLDivElement | null) => void {
    const cleanup = useRef<(() => void) | null>(null);

    const ref = useCallback((node: HTMLDivElement | null) => {
        cleanup.current?.();
        cleanup.current = null;
        if (!node) return;

        const clamp = () => {
            if (node.scrollTop !== 0) node.scrollTop = 0;
            if (node.scrollLeft !== 0) node.scrollLeft = 0;
            /* 直接子层 `.app__content` 也可能被滚（overflow: visible 时一样能滚） */
            const inner = node.firstElementChild as HTMLElement | null;
            if (inner) {
                if (inner.scrollTop !== 0) inner.scrollTop = 0;
                if (inner.scrollLeft !== 0) inner.scrollLeft = 0;
            }
        };

        node.addEventListener('scroll', clamp, {passive: true});
        document.addEventListener('focusin', clamp, true);
        cleanup.current = () => {
            node.removeEventListener('scroll', clamp);
            document.removeEventListener('focusin', clamp, true);
        };
    }, []);

    useEffect(() => () => cleanup.current?.(), []);

    return ref;
}
