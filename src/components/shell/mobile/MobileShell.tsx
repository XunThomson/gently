import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Outlet, useLocation} from 'react-router';
import {appConfig} from '../../../config/app.config';
import {IconList} from '../../ui/icon';
import {RowActionsProvider} from '../../ui/row-actions';
import {RouteError} from '../../ui/route-error';
import {MobileNavDrawer} from './MobileNavDrawer';
import {MobilePlayerBar} from './MobilePlayerBar';
import {MobileSearchBar} from './MobileSearchBar';
import styles from './MobileShell.module.css';

/**
 * 手机外壳：顶部「抽屉 + 标题」/ 单栏内容 / 常驻播放条。
 *
 * 导航形态是**左侧抽屉**（用户 2026-11-01 决定）：手机上把宽度让给列表，
 * 底部只留播放条；8 个入口（搜索/本地/下载/最近/收藏/插件/主题/设置）都收进抽屉。
 * 搜索是 home（根路径重定向到 `/search`，见 `router/index.tsx`）。
 *
 * 与桌面外壳的关系：**同一个 `App`** 按 `useShellMode()` 分叉——
 * `mobile` 只换外壳（导航与播放条的排布），路由、store、服务层完全共用，
 * 所以不会出现「桌面能做的事手机上另一套实现」。
 *
 * **抽屉跟手交互**（R138，QQ 风格）：
 * - 用户从内容区向右拖动时，抽屉跟着手指实时移动（不是阈值触发）
 * - 松手时按位置（>40% 宽度）或速度（快速轻扫）决定打开还是弹回
 * - 抽屉打开后，向左拖动同样跟手关闭
 */
export function MobileShell() {
    const {t} = useTranslation();
    const location = useLocation();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const contentRef = useRef<HTMLElement>(null);
    const onSearch = location.pathname === '/search' || location.pathname.startsWith('/search/');

    /* 换页回到顶部（R123） */
    useEffect(() => {
        contentRef.current?.scrollTo({top: 0, left: 0});
    }, [location.pathname]);

    /* 横向滚动的兜底钳制（R137） */
    useEffect(() => {
        const element = contentRef.current;
        if (!element) return;
        const clamp = () => {
            if (element.scrollLeft !== 0) element.scrollLeft = 0;
        };
        element.addEventListener('scroll', clamp, {passive: true});
        return () => element.removeEventListener('scroll', clamp);
    }, []);

    /* ---------- 跟手拖动的状态 ---------- */
    const [dragOffset, setDragOffset] = useState<number | null>(null);
    const dragState = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        lastX: number;
        lastTime: number;
        phase: 'idle' | 'pending' | 'dragging';
        direction: 'open' | 'close' | null;
        offset: number;
    }>({
        pointerId: -1,
        startX: 0,
        startY: 0,
        lastX: 0,
        lastTime: 0,
        phase: 'idle',
        direction: null,
        offset: 0,
    });

    /* 真横滑之后，浏览器还会补一次 click（落在手指下的行上）。
       **只吞这一次、且只吞真正横滑过的那一下**：垂直滚动列表后紧接着点歌必须正常——
       上一版在「任何 pointermove 都把 dragOffset 从 null 改掉」之后无差别吞 300ms，
       正是用户报的「概率性点击没反应」（R139）。 */
    const swallowClickAt = useRef(0);

    /* 抽屉宽度（用于计算百分比阈值） */
    const [drawerWidth, setDrawerWidth] = useState(280);
    useEffect(() => {
        const cssWidth = getComputedStyle(document.documentElement)
            .getPropertyValue('--mobile-drawer-width')
            .trim();
        if (cssWidth) {
            const parsed = parseFloat(cssWidth);
            if (!Number.isNaN(parsed)) setDrawerWidth(parsed);
        }
    }, []);

    /**
     * 开始拖动：记录起点，判断是否满足打开/关闭条件。
     *
     * 约束（与旧版一致）：
     * 1. 不从最左侧起手（系统返回手势区）
     * 2. 只认触摸（不认鼠标）
     * 3. 不抢别的控件（data-drawer-swipe="off"）
     */
    const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse') return;
        const state = dragState.current;
        if (state.phase !== 'idle') return;

        const target = event.target as HTMLElement | null;
        /* 表单控件 / 滑块自己就是横向拖动：抽屉手势必须让路（R139）。
           手机上「背景设置里的水平/垂直/缩放滑杆」一拖就开抽屉，就是这个原因。 */
        if (
            target?.closest(
                'input, textarea, select, [contenteditable="true"], [role="slider"], [data-drawer-swipe="off"]',
            )
        ) {
            return;
        }

        const x = event.clientX;
        const isOnDrawer = drawerOpen && target?.closest('[data-drawer-panel]');

        /* 打开手势：必须从 ignoreEdgePx 右侧起手 */
        if (!drawerOpen && x < appConfig.mobile.drawerSwipe.ignoreEdgePx) return;

        /* 关闭手势：必须在抽屉面板或遮罩上起手 */
        if (drawerOpen && !isOnDrawer) {
            if (!target?.closest('[data-drawer-scrim]')) return;
        }

        state.pointerId = event.pointerId;
        state.startX = x;
        state.startY = event.clientY;
        state.lastX = x;
        state.lastTime = Date.now();
        /* 先「待定」：此时还不知道用户要横滑还是纵滚，绝不能改 dragOffset，
           否则一次普通滚动也会让抽屉进入渲染、并在抬手后吞掉下一次点击（R139）。 */
        state.phase = 'pending';
        state.direction = drawerOpen ? 'close' : 'open';
        state.offset = drawerOpen ? 0 : -drawerWidth;
    }, [drawerOpen, drawerWidth]);

    /**
     * 拖动中：实时更新抽屉位置。
     */
    const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const state = dragState.current;
        if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;

        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        const {slopeRatio} = appConfig.mobile.drawerSwipe;

        /* 还没决定方向：先判定是横滑还是纵滚。
           纵滚（或方向相反）就彻底放弃这次手势——绝不动抽屉，也绝不影响点击。 */
        if (state.phase === 'pending') {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            const horizontal = Math.abs(dx) >= Math.abs(dy) * slopeRatio;
            const correctDirection = state.direction === 'open' ? dx > 0 : dx < 0;
            if (!horizontal || !correctDirection) {
                state.phase = 'idle';
                state.direction = null;
                return;
            }
            state.phase = 'dragging';
        }
        if (state.phase !== 'dragging' || state.direction === null) return;

        /* 计算偏移量 */
        let offset: number;
        if (state.direction === 'open') {
            offset = Math.max(-drawerWidth, Math.min(0, -drawerWidth + dx));
        } else {
            offset = Math.max(-drawerWidth, Math.min(0, dx));
        }

        state.offset = offset;
        state.lastX = event.clientX;
        state.lastTime = Date.now();

        setDragOffset(offset);
    }, [drawerWidth]);

    /**
     * 结束拖动：按位置或速度决定最终状态。
     */
    const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const state = dragState.current;
        if (state.pointerId !== event.pointerId) return;

        if (state.phase === 'dragging' && state.direction !== null) {
            const now = Date.now();
            const dt = Math.max(1, now - state.lastTime);
            const velocity = (event.clientX - state.lastX) / dt;
            const {snapThreshold, flickVelocityPxMs} = appConfig.mobile.drawerSwipe;

            const progress =
                state.direction === 'open'
                    ? (state.offset + drawerWidth) / drawerWidth
                    : Math.abs(state.offset) / drawerWidth;
            const flicked =
                state.direction === 'open'
                    ? velocity >= flickVelocityPxMs
                    : velocity <= -flickVelocityPxMs;
            const shouldCommit = progress >= snapThreshold || flicked;

            setDrawerOpen(state.direction === 'open' ? shouldCommit : !shouldCommit);
            /* 只有**真的横滑过**才吞紧随其后的合成 click；纵滚到这里 phase 已经是 idle */
            swallowClickAt.current = Date.now();
        }

        setDragOffset(null);
        state.phase = 'idle';
        state.direction = null;
    }, [drawerWidth]);

    const onPointerCancel = useCallback(() => {
        setDragOffset(null);
        dragState.current.phase = 'idle';
        dragState.current.direction = null;
    }, []);

    const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (Date.now() - swallowClickAt.current > 300) return;
        swallowClickAt.current = 0;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const handleDrawerClose = useCallback(() => {
        setDrawerOpen(false);
        setDragOffset(null);
    }, []);

    return (
        <RowActionsProvider>
            <div
                className={styles.shell}
                /* 安卓是 edge-to-edge：webview 铺到状态栏/导航栏下面，安全区由 CSS 变量接管
                   （--mobile-safe-top = max(env(safe-area-inset-top), app.config 的兜底值)，
                   见 MobileShell.module.css；兜底值仍来自 app.config，不写死在样式里） */
                style={{'--mobile-status-inset': `${appConfig.mobile.statusBarInset}px`} as React.CSSProperties}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onClickCapture={onClickCapture}
            >
                <header className={styles.header}>
                    <button
                        type="button"
                        className={styles.headerAction}
                        aria-label={t('mobile.menu')}
                        onClick={() => setDrawerOpen(true)}
                    >
                        <IconList size={18}/>
                    </button>
                    <span className={styles.brand}>{t('app.title')}</span>
                </header>

                {onSearch && <MobileSearchBar/>}

                <main className={styles.content} ref={contentRef}>
                    <div className={styles.pageFade} key={location.key}>
                        <RouteError key={location.pathname}>
                            <Outlet/>
                        </RouteError>
                    </div>
                </main>

                <MobilePlayerBar/>

                <MobileNavDrawer
                    open={drawerOpen}
                    dragOffset={dragOffset}
                    drawerWidth={drawerWidth}
                    onClose={handleDrawerClose}
                />
            </div>
        </RowActionsProvider>
    );
}

export default MobileShell;
