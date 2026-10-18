import {useEffect} from "react";
import {Outlet} from "react-router";
import {LMRLayout, TMBLayout} from "./components/layout";
import {BackgroundVideo} from "./components/shell/background";
import {ConfirmHost} from "./components/ui/dialog";
import {TitleBar} from "./components/shell/title-bar";
import {Sidebar} from "./components/shell/sidebar";
import {PlayerBar} from "./components/shell/player-bar";
import {appRoutes, buildMenuRoutes} from "./router/meta.tsx";
import {usePlayerEngine} from "./hooks/usePlayerEngine";
import {useAudioEngine} from "./hooks/useAudioEngine";
import {useDownloadEngine} from "./hooks/useDownloadEngine";
import {useDesktopLyricsBridge} from "./hooks/useDesktopLyricsBridge";
import {useActions} from "./store";
import {probeCore} from "./services";
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
    /* 主窗口 → 桌面歌词窗口的状态桥（仅 Tauri 宿主；浏览器下是空操作） */
    useDesktopLyricsBridge();

    /* 收藏/歌单与音源列表都是全局数据（侧边栏、音源筛选常驻），启动时各加载一次 */
    useEffect(() => {
        void loadCollection();
        void loadPlugins();
    }, [loadCollection, loadPlugins]);

    /* 启动即探测本机核心：UI 据此判断是否运行在桌面宿主（浏览器预览时为不可用，退回 mock） */
    useEffect(() => {
        void probeCore();
    }, []);

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

            {/* 全局二次确认（危险操作）：由 useConfirm() 触发 */}
            <ConfirmHost/>
        </div>
    );
}
