import {defineConfig} from "vite";
import tailwindcss from '@tailwindcss/vite'
import react from "@vitejs/plugin-react";
import pkg from './package.json'

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
    plugins: [react(), tailwindcss()],

    // 应用版本单一来源：package.json
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },

    // .m4s 不在 Vite 默认资源类型里，需要显式声明为静态资源
    assetsInclude: ['**/*.m4s'],

    build: {
        rollupOptions: {
            output: {
                // 依赖分包：主包更小，且依赖可长期缓存
                manualChunks: {
                    react: ['react', 'react-dom'],
                    router: ['react-router'],
                    i18n: ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
                },
            },
        },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
            }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },
}));
