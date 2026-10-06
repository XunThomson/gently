import {useEffect} from "react";
import {Outlet} from "react-router";
import {LMRLayout, TMBLayout} from "./components/layout";
import {BackgroundVideo} from "./components/shell/background";
import {TitleBar} from "./components/shell/title-bar";
import {Sidebar} from "./components/shell/sidebar";
import {PlayerBar} from "./components/shell/player-bar";
import {appRoutes, buildMenuRoutes} from "./router/meta.tsx";
import {usePlayerEngine} from "./hooks/usePlayerEngine";
import {useAudioEngine} from "./hooks/useAudioEngine";
import {useDownloadEngine} from "./hooks/useDownloadEngine";
import {useActions} from "./store";
import {useTheme} from "./theme";
import './App.css';

/**
 * 应用外壳：动态背景 / 标题栏 / 侧边导航 + 路由内容 / 播放条。
 * 布局尺寸取自「主题配置 + 主题市场预设」解析后的结果，因此预设可以改变密度。
 */
export default function App() {
    const {config} = useTheme();
    const {titleBar, sidebar, playerBar} = config.components;
    const {load: loadCollection} = useActions().collection;
    const {load: loadPlugins} = useActions().plugin;

    useAudioEngine();
    usePlayerEngine();
    useDownloadEngine();

    /* 收藏/歌单与音源列表都是全局数据（侧边栏、音源筛选常驻），启动时各加载一次 */
    useEffect(() => {
        void loadCollection();
        void loadPlugins();
    }, [loadCollection, loadPlugins]);

    return (
        <div className="app">
            <BackgroundVideo/>

            <div className="app__content">
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
        </div>
    );
}
