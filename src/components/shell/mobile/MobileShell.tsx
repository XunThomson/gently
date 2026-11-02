import {useEffect, useRef, useState} from 'react';
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
 */
export function MobileShell() {
    const {t} = useTranslation();
    const location = useLocation();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const contentRef = useRef<HTMLElement>(null);
    const onSearch = location.pathname === '/search' || location.pathname.startsWith('/search/');

    /* 换页回到顶部（R123）：`.content` 是滚动容器，不重置的话从长列表点进另一页
       会停在上一页的滚动位置，看起来像「页面没换」。 */
    useEffect(() => {
        contentRef.current?.scrollTo({top: 0});
    }, [location.pathname]);

    /**
     * 横滑打开抽屉（R137 用户反馈「滑动打开抽屉」）。
     *
     * 三条约束都是真机踩出来的：
     * 1. **不从最左侧起手**：手势导航把屏幕左边缘当「返回」，从那儿横滑会把应用送回桌面
     *    （R124 的负结果）。所以起手点要离开边缘 `ignoreEdgePx`——用户从内容区任何位置往右划都行；
     * 2. **只认横向**：位移要够长、且明显大于纵向，否则那是在滚列表（`slopeRatio`）；
     * 3. **不抢别的控件**：播放条上的进度条本身就是横向拖动，那里标了 `data-drawer-swipe="off"`，
     *    手势直接跳过；滑动成功后还会**吃掉这一次 click**，免得顺手把手指下的行点了。
     *
     * 不用 `setPointerCapture`：只要 pointermove 的就近语义就够了，捕获反而会打断列表滚动。
     */
    const swipe = useRef<{x: number; y: number; pointerId: number} | null>(null);
    /** 横滑打开抽屉的时刻：只吃掉「紧接着那一下」的 click，不能把之后的正常点击一起吞了 */
    const swallowClickAt = useRef(0);

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drawerOpen || event.pointerType === 'mouse') return;
        if (event.clientX < appConfig.mobile.drawerSwipe.ignoreEdgePx) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-drawer-swipe="off"]')) return;
        swipe.current = {x: event.clientX, y: event.clientY, pointerId: event.pointerId};
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const start = swipe.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const {distancePx, slopeRatio} = appConfig.mobile.drawerSwipe;
        if (dx < distancePx || Math.abs(dx) < Math.abs(dy) * slopeRatio) return;
        swipe.current = null;
        swallowClickAt.current = Date.now();
        setDrawerOpen(true);
    };

    const endSwipe = () => {
        swipe.current = null;
    };

    /* 横滑打开抽屉后，手指抬起时浏览器仍可能补一次 click（落在下面的行上）。
       capture 阶段吃掉它——**只吃 300ms 内那一下**：抽屉里紧接着的点击（导航项 / 关闭）
       不能被一起吞掉（R137 真机踩到：滑动开抽屉后第一次点导航项没反应）。 */
    const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
        if (Date.now() - swallowClickAt.current > 300) return;
        swallowClickAt.current = 0;
        event.preventDefault();
        event.stopPropagation();
    };

    return (
        /* 行操作的底部面板宿主：列表行尾的 ⋯ 从这里弹面板（见 components/ui/row-actions）。
           宿主放在 `.shell` **外面一层**：面板要盖住整个屏幕（含常驻播放条），
           放进 shell 里会被它的 `overflow: hidden` 裁掉。 */
        <RowActionsProvider>
            <div
                className={styles.shell}
                /* 安卓是 edge-to-edge：webview 铺到状态栏下面，顶部要自己让出状态栏高度
                   （值来自 app.config 的 mobile.statusBarInset，不写死在 CSS 里） */
                style={{paddingTop: appConfig.mobile.statusBarInset}}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endSwipe}
                onPointerCancel={endSwipe}
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
                    {/* 换页过渡：key 换掉就重新播一次淡入（见 .pageFade）。
                        错误边界也挂在这里：某一页渲染抛错时只坏内容区，导航与播放条继续可用（R137） */}
                    <div className={styles.pageFade} key={location.key}>
                        <RouteError key={location.pathname}>
                            <Outlet/>
                        </RouteError>
                    </div>
                </main>

                <MobilePlayerBar/>

                <MobileNavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}/>
            </div>
        </RowActionsProvider>
    );
}

export default MobileShell;
