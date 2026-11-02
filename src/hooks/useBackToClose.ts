import {useEffect, useRef} from 'react';

/**
 * 「返回键 / 系统返回手势」关掉浮层（安卓的主流习惯，R121 用户反馈）。
 *
 * 做法：浮层打开时往历史里压一条**同 URL** 的标记 entry。安卓的系统返回在 WebView 里
 * 就是 `history.back()`，所以它会先 pop 掉这条标记并触发 `popstate`——我们据此关浮层，
 * 而不是把用户退回上一页。
 *
 * 主动关闭（点空白 / 选了某项 / 点了动作）时必须把那条 entry 收掉，否则用户的「返回」
 * 会被白白吃掉一次（下次按返回没反应，要按两下）。
 *
 * `onClose` 用 ref 存最新值：调用方通常传内联箭头函数，若进依赖会让 effect 反复重跑、
 * 一路 pushState，历史里堆一串标记。
 */
export function useBackToClose(open: boolean, onClose: () => void): void {
    const latest = useRef(onClose);
    latest.current = onClose;

    useEffect(() => {
        if (!open || typeof window === 'undefined') return;

        /* 浮层打开期间给根节点打标记：底层的按压态/过渡要能据此让位（R133，#5 穿模） */
        document.documentElement.dataset.overlay = 'open';
        const onPop = () => latest.current();
        window.addEventListener('popstate', onPop);
        /* 同 URL 的 entry：路由不变，只当「关掉浮层」的令牌 */
        history.pushState({...history.state, gentlyOverlay: true}, '');

        return () => {
            window.removeEventListener('popstate', onPop);
            delete document.documentElement.dataset.overlay;
            const state = history.state as {gentlyOverlay?: boolean} | null;
            if (state?.gentlyOverlay) history.back();
        };
    }, [open]);
}
