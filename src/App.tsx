import {useEffect, useState} from "react";
import {Outlet} from "react-router";
import {LMRLayout, TMBLayout} from "./components/layout";
import {BackgroundVideo} from "./components/shell/background";
import {MiniPlayer} from "./components/shell/mini-player";
import {ConfirmHost} from "./components/ui/dialog";
import {TitleBar} from "./components/shell/title-bar";
import {Sidebar} from "./components/shell/sidebar";
import {PlayerBar} from "./components/shell/player-bar";
import {PetHost} from "./pet";
import {appRoutes, buildMenuRoutes} from "./router/meta.tsx";
import {usePlayerEngine} from "./hooks/usePlayerEngine";
import {useAudioEngine} from "./hooks/useAudioEngine";
import {useDownloadEngine} from "./hooks/useDownloadEngine";
import {useDesktopLyricsBridge} from "./hooks/useDesktopLyricsBridge";
import {useShellMode} from "./hooks/useShellMode";
import {useActions} from "./store";
import {isTauri, probeCore, windowService} from "./services";
import {useTheme} from "./theme";
import './App.css';

/**
 * 应用外壳：动态背景 / 标题栏 / 侧边导航 + 路由内容 / 播放条。
 * 布局尺寸取自「主题配置 + 主题市场预设」解析后的结果，因此预设可以改变密度。
 *
 * 窗口尺寸决定外壳形态（`useShellMode`）：
 * - 完整界面 / 紧凑界面（侧栏收成图标栏）仍走同一套路由与播放条；
 * - 迷你播放器替换整个外壳，只保留封面、标题、控制、进度与歌词。
 *   在桌面端点「展开」会把窗口恢复成普通尺寸；浏览器预览里没有原生窗口，
 *   用一个本地开关回到完整界面（形态再次变化时重新按断点判定）。
 */
export default function App() {
    const {config} = useTheme();
    const {titleBar, sidebar, playerBar} = config.components;
    const {load: loadCollection} = useActions().collection;
    const {load: loadPlugins} = useActions().plugin;
    /* 下载任务也要在启动时加载：业务列表的「已下载」标记依赖它，不能等用户先点开下载页 */
    const {load: loadDownloads} = useActions().download;
    const mode = useShellMode();

    /* 浏览器预览没有原生窗口可 resize：展开后先用本地开关回到完整界面；
       形态变化（如再次跨过断点）才清除，避免每个像素的 resize 都重渲染外壳。 */
    const [forceRegular, setForceRegular] = useState(false);
    useEffect(() => {
        setForceRegular(false);
    }, [mode]);

    useAudioEngine();
    usePlayerEngine();
    useDownloadEngine();
    /* 主窗口 → 桌面歌词窗口的状态桥（仅 Tauri 宿主；浏览器下是空操作） */
    useDesktopLyricsBridge();

    /* 收藏/歌单与音源列表都是全局数据（侧边栏、音源筛选常驻），启动时各加载一次 */
    useEffect(() => {
        void loadCollection();
        void loadPlugins();
        void loadDownloads();
    }, [loadCollection, loadPlugins, loadDownloads]);

    /* 启动即探测本机核心：UI 据此判断是否运行在桌面宿主（浏览器预览时为不可用，退回 mock） */
    useEffect(() => {
        void probeCore();
    }, []);

    const restoreFull = () => {
        void windowService.restoreFromMini();
        if (!isTauri()) setForceRegular(true);
    };

    if (mode === "mini" && !forceRegular) {
        return (
            <div className="app" data-shell="mini">
                <BackgroundVideo/>
                <div className="app__content">
                    <MiniPlayer onExpand={restoreFull}/>
                </div>
                <ConfirmHost/>
            </div>
        );
    }

    const compact = mode === "compact";

    return (
        <div className="app" data-shell={mode}>
            <BackgroundVideo/>

            <div className="app__content">
                <TMBLayout
                    config={{
                        gap: 0,
                        top: {size: "fixed", value: titleBar.height, resizable: false, scroll: false},
                        main: {size: "ratio", value: 1, resizable: false},
                        bottom: {size: "fixed", value: playerBar.height, resizable: false, scroll: false},
                    }}
                    top={<TitleBar compact={compact}/>}
                    main={
                        <LMRLayout
                            config={{
                                gap: 0,
                                left: {
                                    size: "fixed",
                                    value: compact ? sidebar.compactWidth : sidebar.width,
                                    resizable: false,
                                    scroll: false,
                                },
                                main: {size: "ratio", value: 1, resizable: false},
                                right: {size: "hidden", resizable: false, scroll: false},
                            }}
                            left={
                                <Sidebar
                                    mainMenu={buildMenuRoutes(appRoutes)}
                                    compact={compact}
                                />
                            }
                            main={<Outlet/>}
                        />
                    }
                    bottom={<PlayerBar compact={compact}/>}
                />
            </div>

            {/* 全局二次确认（危险操作）：由 useConfirm() 触发 */}
            <ConfirmHost/>

            {/* 2.x 桌面宠物预留宿主：没有注册宠物时渲染 null */}
            <PetHost/>
        </div>
    );
}
