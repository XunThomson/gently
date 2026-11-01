import {StrictMode} from "react";
import ReactDOM from "react-dom/client";
import {RouterProvider} from 'react-router';
import './assets/css/main.css'
import './i18n'
import {router} from "./router";
import {applyInitialTheme, ThemeProvider} from "./theme";
import {DesktopLyricsApp} from "./widgets/desktop-lyrics";
import {PetWindowApp} from "./widgets/pet-window";

/* 挂载前先注入主题变量，避免首屏闪烁 */
applyInitialTheme();

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
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <ThemeProvider>
            {desktopLyricsMode ? (
                <DesktopLyricsApp/>
            ) : petWindowMode ? (
                <PetWindowApp/>
            ) : (
                <RouterProvider router={router}/>
            )}
        </ThemeProvider>
    </StrictMode>
);
