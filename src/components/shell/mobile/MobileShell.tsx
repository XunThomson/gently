import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Outlet, useLocation} from 'react-router';
import {appConfig} from '../../../config/app.config';
import {IconList} from '../../ui/icon';
import {RowActionsProvider} from '../../ui/row-actions';
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
    const onSearch = location.pathname === '/search' || location.pathname.startsWith('/search/');

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

                <main className={styles.content}>
                    <Outlet/>
                </main>

                <MobilePlayerBar/>

                <MobileNavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}/>
            </div>
        </RowActionsProvider>
    );
}

export default MobileShell;
