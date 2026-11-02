import {defineConfig, type Plugin} from "vite";
import tailwindcss from '@tailwindcss/vite'
import react from "@vitejs/plugin-react";
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import pkg from './package.json'

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * 移动端构建要不要带内置演示背景视频（`src/assets/bgc.mp4`，100 MB+ 的测试素材）。
 *
 * 桌面端当动态壁纸没问题；手机上一进应用就解码它纯属拖累（安装包、首装、首帧）。
 * 用 `define` 在构建期把它变成常量，让 Rollup 连资源引用一起摇掉
 * （R122 只做到「运行时不用」，R123 起改成「构建期不带」）。
 * 判据是 Tauri 给移动构建注入的 `TAURI_ENV_PLATFORM`；不是 android 就照旧带上，
 * 桌面与 `pnpm dev` 都不受影响。
 */
// @ts-expect-error process is a nodejs global
const bundledBackground = process.env.TAURI_ENV_PLATFORM !== 'android';

/**
 * 把内置演示背景视频做成**虚拟模块**：移动端构建里它根本不存在，资源也就不会被 emit。
 *
 * 为什么不用 `import.meta.glob` + 条件：glob 在 transform 阶段就把资源写进产物了，
 * 之后 Rollup 摇不摇得掉都不影响「已经 emit 了一份 110 MB 的 mp4」
 * （R123 实测：android 构建照样产出 `dist/assets/bgc-*.mp4`）。
 * 文件缺失时回 `null`，保持原来「素材不在也不影响构建」的降级。
 */
function bundledBackgroundPlugin(enabled: boolean): Plugin {
    const virtualId = 'virtual:gently-bundled-bg';
    const resolved = '\0' + virtualId;
    const assetPath = fileURLToPath(new URL('./src/assets/bgc.mp4', import.meta.url));
    return {
        name: 'gently-bundled-background',
        resolveId(id) {
            return id === virtualId ? resolved : null;
        },
        load(id) {
            if (id !== resolved) return null;
            if (!enabled || !existsSync(assetPath)) return 'export default null;';
            return 'import url from "/src/assets/bgc.mp4?url"; export default url;';
        },
    };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
    plugins: [react(), tailwindcss(), bundledBackgroundPlugin(bundledBackground)],

    // 应用版本单一来源：package.json
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __GENTLY_BUNDLED_BG__: JSON.stringify(bundledBackground),
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
