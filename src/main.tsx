import {StrictMode} from "react";
import ReactDOM from "react-dom/client";
import {RouterProvider} from 'react-router';
import './assets/css/main.css'
import './i18n'
import {router} from "./router";
import {applyInitialTheme, ThemeProvider} from "./theme";
import {DesktopLyricsApp} from "./widgets/desktop-lyrics";

/* 挂载前先注入主题变量，避免首屏闪烁 */
applyInitialTheme();

/**
 * 同一个前端产物服务两个窗口：
 * - 主窗口：完整应用（路由 + 外壳 + 播放条）；
 * - `desktop-lyrics` 窗口（tauri.conf.json）：只渲染桌面歌词，不挂路由。
 * 用 query 区分而不是第二个 HTML 入口：构建配置只有一份，窗口 URL 也更直观。
 */
const desktopLyricsMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('window') === 'desktop-lyrics';

/* 给歌词窗口打一个标记：整页要透明（见 assets/css/global.css），主窗口不受影响 */
if (desktopLyricsMode) {
    document.documentElement.dataset.window = 'desktop-lyrics';
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <ThemeProvider>
            {desktopLyricsMode ? <DesktopLyricsApp/> : <RouterProvider router={router}/>}
        </ThemeProvider>
    </StrictMode>
);
