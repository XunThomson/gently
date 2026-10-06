import {useEffect} from "react";
import {Outlet} from "react-router";
import {LMRLayout, TMBLayout} from "./components/layout";
import {TitleBar} from "./components/shell/title-bar";
import {Sidebar} from "./components/shell/sidebar";
import {PlayerBar} from "./components/shell/player-bar";
import {appRoutes, buildMenuRoutes} from "./router/meta.tsx";
import {usePlayerEngine} from "./hooks/usePlayerEngine";
import {useDownloadEngine} from "./hooks/useDownloadEngine";
import {useActions} from "./store";
import {themeConfig} from "./theme";
import './App.css';

/**
 * 应用外壳：标题栏 / 侧边导航 + 路由内容 / 播放条。
 * 布局尺寸全部来自 theme.config.json，不在此硬编码。
 */
export default function App() {
    const {titleBar, sidebar, playerBar} = themeConfig.components;
    const {load: loadCollection} = useActions().collection;

    usePlayerEngine();
    useDownloadEngine();

    /* 收藏与歌单是全局数据（侧边栏常驻），启动时加载一次 */
    useEffect(() => {
        void loadCollection();
    }, [loadCollection]);

    return (
        <div className="app">
            <TMBLayout
                config={{
                    gap: 0,
                    top: {size: "fixed", value: titleBar.height, resizable: false, scroll: false},
                    main: {size: "ratio", value: 1, resizable: false},
                    bottom: {size: "fixed", value: playerBar.height, resizable: false, scroll: false},
                }}
                top={<TitleBar/>}
                main={
                    <LMRLayout
                        config={{
                            gap: 0,
                            left: {size: "fixed", value: sidebar.width, resizable: false, scroll: false},
                            main: {size: "ratio", value: 1, resizable: false},
                            right: {size: "hidden", resizable: false, scroll: false},
                        }}
                        left={<Sidebar mainMenu={buildMenuRoutes(appRoutes)}/>}
                        main={<Outlet/>}
                    />
                }
                bottom={<PlayerBar/>}
            />
        </div>
    );
}
