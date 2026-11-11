import {StrictMode} from "react";
import ReactDOM from "react-dom/client";
import {RouterProvider} from 'react-router';
import './assets/css/main.css'
import './i18n'
import {router} from "./router";
import {applyInitialTheme, ThemeProvider} from "./theme";
import {DesktopLyricsApp} from "./widgets/desktop-lyrics";
import {PetWindowApp} from "./widgets/pet-window";
import {installErrorOverlay} from "./utils/errorOverlay";
import {installBlankScreenWatchdog} from "./utils/blankScreenWatchdog";
import {RootError} from "./components/ui/route-error";

/* 挂载前先注入主题变量，避免首屏闪烁 */
applyInitialTheme();
/* 未捕获错误 / 未处理的 Promise 拒绝：显示可读的面板，而不是白屏（R137） */
installErrorOverlay();
/**
 * 同一个前端产物服务三个窗口（`tauri.conf.json` 里各一个）：
 * - 主窗口：完整应用（路由 + 外壳 + 播放条）；
 * - `desktop-lyrics`：只渲染桌面歌词，不挂路由；
 * - `pet`：只渲染宠物（独立置顶小窗，主窗口最小化它也在）。
 * 用 query 区分而不是第二个 HTML 入口：构建配置只有一份，窗口 URL 也更直观。
 */
const windowMode =
    typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('window')
        : null;
const desktopLyricsMode = windowMode === 'desktop-lyrics';
const petWindowMode = windowMode === 'pet';

/* 给独立窗口打标记：整页要透明（见 assets/css/global.css），主窗口不受影响 */
if (desktopLyricsMode || petWindowMode) {
    document.documentElement.dataset.window = windowMode as string;
} else {
    /* 白屏看门狗只在主窗口装：歌词窗 / 宠物窗本来就是小块透明区域 */
    installBlankScreenWatchdog();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <RootError>
            <ThemeProvider>
                {desktopLyricsMode ? (
                    <DesktopLyricsApp/>
                ) : petWindowMode ? (
                    <PetWindowApp/>
                ) : (
                    <RouterProvider router={router}/>
                )}
            </ThemeProvider>
        </RootError>
    </StrictMode>
);

/**
 * 收掉品牌启动屏（index.html 里的 `#boot-splash`）。
 *
 * 双 rAF：`root.render` 在并发模式下是**调度**而不是同步提交，单帧就撤遮罩会露出白底；
 * 两帧之后外壳已经挂上，再淡出。歌词 / 宠物窗口的启动屏在 index.html 里已按 query 移除，
 * 这里找不到节点就什么都不做。
 */
function dismissBootSplash(): void {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            splash.classList.add('is-hidden');
            window.setTimeout(() => splash.remove(), 360);
        });
    });
}

dismissBootSplash();

/**
 * 安卓 `MainActivity.onResume` 的软通知（R139）：只强制一次重排/重绘，不 reload。
 *
 * 部分 WebView 在 `onPause → onResume` 后会保留一帧空白 surface；发一次 resize
 * 让布局层重新计算，同时把 data 标记改掉触发样式刷新。真正的播放恢复仍由
 * `useAudioEngine` 的 `visibilitychange` 负责（那里有超时与重新解析）。
 */
if (typeof window !== 'undefined') {
    window.addEventListener('gently:app:resume', () => {
        document.documentElement.dataset.resume = String(Date.now());
        window.dispatchEvent(new Event('resize'));
    });
}
