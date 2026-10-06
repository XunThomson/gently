import {StrictMode} from "react";
import ReactDOM from "react-dom/client";
import {RouterProvider} from 'react-router';
import './assets/css/main.css'
import './i18n'
import {router} from "./router";
import {applyInitialTheme, ThemeProvider} from "./theme";

/* 挂载前先注入主题变量，避免首屏闪烁 */
applyInitialTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <ThemeProvider>
            <RouterProvider router={router}/>
        </ThemeProvider>
    </StrictMode>
);
