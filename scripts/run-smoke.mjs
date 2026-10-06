/**
 * 运行冒烟测试：
 *   1. 用 Vite（项目已有依赖，无需新增）把 scripts/smoke.tsx 打包成临时 CJS
 *   2. 在 Node 中执行，退出码即测试结果
 *
 * 用法：pnpm smoke
 */
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'vite';

const outDir = mkdtempSync(path.join(tmpdir(), 'gently-smoke-'));

await build({
    configFile: false,
    logLevel: 'error',
    // 把依赖一并打包，避免 node 直接 require 纯 ESM 包
    ssr: {noExternal: true, target: 'node'},
    build: {
        ssr: 'scripts/smoke.tsx',
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
            output: {format: 'cjs', entryFileNames: 'smoke.cjs'},
        },
    },
});

await import(pathToFileURL(path.join(outDir, 'smoke.cjs')).href);
