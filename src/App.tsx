import {useEffect, useState} from "react";
import {Outlet, useLocation} from "react-router";
import {LMRLayout, TMBLayout} from "./components/layout";
import {BackgroundVideo} from "./components/shell/background";
import {MiniPlayer} from "./components/shell/mini-player";
import {MobileShell} from "./components/shell/mobile";
import {ConfirmHost} from "./components/ui/dialog";
import {RouteError} from "./components/ui/route-error";
import {TitleBar} from "./components/shell/title-bar";
import {Sidebar} from "./components/shell/sidebar";
import {PlayerBar} from "./components/shell/player-bar";
import {PetHost} from "./pet";
import {appRoutes, buildMenuRoutes} from "./router/meta.tsx";
import {usePlayerEngine} from "./hooks/usePlayerEngine";
import {useAudioEngine} from "./hooks/useAudioEngine";
import {useDownloadEngine} from "./hooks/useDownloadEngine";
import {useDesktopLyricsBridge} from "./hooks/useDesktopLyricsBridge";
import {usePetWindowBridge} from "./hooks/usePetWindowBridge";
import {useSleepTimer} from "./hooks/useSleepTimer";
import {useShellMode} from "./hooks/useShellMode";
import {useClampedShell} from "./hooks/useClampedShell";
import {useActions, useSelect} from "./store";
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
    /* 换页时复位路由错误边界（R137）：某一页渲染抛错不该连累之后打开的页面 */
    const location = useLocation();
    /* 外壳本身永远不该被滚动：被浏览器滚走就是「白屏 + 回不来」（R137，见 hook 注释） */
    const shellRef = useClampedShell();

    /* 首次成功挂载后打标记（R139）：白屏看门狗据此区分「启动中」与「真的白屏」。
       之前看门狗在启动空档里也可能判定，退后台回来时更容易误报。 */
    useEffect(() => {
        document.documentElement.dataset.ready = '1';
    }, []);

    /* 浏览器预览没有原生窗口可 resize：展开后先用本地开关回到完整界面；
       形态变化（如再次跨过断点）才清除，避免每个像素的 resize 都重渲染外壳。 */
    const [forceRegular, setForceRegular] = useState(false);
    useEffect(() => {
        setForceRegular(false);
    }, [mode]);

    useAudioEngine();
    usePlayerEngine();
    useDownloadEngine();
    /* 定时关闭引擎：监测计时状态，到点暂停播放 */
    useSleepTimer();
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

    /**
     * 宠物（实验，默认关）。
     *
     * 宠物住在**独立窗口**（`tauri.conf.json` 的 `pet`）里，而不是主窗口的一块浮层：
     * 这样主窗口最小化/被盖住时宠物还在，位置也不再受主窗口边界限制。
     * 主窗口这边只负责两件事：
     *   1. 开关 ↔ 窗口可见性对齐（打开就显示、关掉就隐藏）；
     *   2. 把只读播放快照 + 宠物 revision 推给宠物窗口（那个 WebView 没有 store）。
     *
     * 关着的时候**什么都不做**：窗口是隐藏的，不 tick、不占电。
     */
    const petEnabled = useSelect((s) => s.ui.petEnabled);
    /** 设置页改过宠物（安装/切换/卸载）后 +1 → 宠物窗口据此重挂渲染器 */
    const petRevision = useSelect((s) => s.ui.petRevision);
    /* 手机端没有「独立宠物窗口」这种东西（P4 才谈替代方案），所以桥直接不启用 */
    usePetWindowBridge(petEnabled && mode !== "mobile", petRevision);

    const restoreFull = () => {
        void windowService.restoreFromMini();
        if (!isTauri()) setForceRegular(true);
    };

    if (mode === "mobile") {
        /* 手机外壳：导航换成底部 tab，路由 / store / 服务层与桌面完全共用 */
        return (
            <div className="app" data-shell="mobile" ref={shellRef}>
                <BackgroundVideo/>
                <div className="app__content">
                    <MobileShell/>
                </div>
                <ConfirmHost/>
            </div>
        );
    }

    if (mode === "mini" && !forceRegular) {
        return (
            <div className="app" data-shell="mini" ref={shellRef}>
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
        <div className="app" data-shell={mode} ref={shellRef}>
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
                            main={<RouteError key={location.pathname}><Outlet/></RouteError>}
                        />
                    }
                    bottom={<PlayerBar compact={compact}/>}
                />
            </div>

            {/* 全局二次确认（危险操作）：由 useConfirm() 触发 */}
            <ConfirmHost/>

            {/* 宠物宿主：内置宠物住在独立窗口（`pet`），主窗口这里默认什么都不注册，
                所以渲染 null；保留它是给「第三方宠物定义想画在应用里」留的口子 */}
            <PetHost/>
        </div>
    );
}
