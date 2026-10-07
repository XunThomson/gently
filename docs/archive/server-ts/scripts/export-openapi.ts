/**
 * 导出 OpenAPI 文档到 `server/openapi.json`。
 *
 * 文档由路由上的 Zod schema 生成（`jsonSchemaTransform`），因此这个脚本
 * 等价于「把运行期契约落盘」：前端调用代码生成与契约评审都以此文件为准。
 *
 * 必须 `await app.ready()`：@fastify/swagger 在 ready 阶段才把所有路由的
 * schema 汇总进 `app.swagger()`，未 ready 会拿到缺路径的文档。
 */
import {writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';

async function exportOpenApi(): Promise<void> {
    const app = await buildApp();
    try {
        await app.ready();
        const spec = app.swagger();
        // 输出位置固定在 server/ 根目录，与仓库约定一致（不依赖 cwd）
        const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');
        // 缩进 2 空格：该文件会进版本库，diff 必须可读
        await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

        const pathCount = Object.keys(spec.paths ?? {}).length;
        console.log(`OpenAPI 已写入：${outPath}`);
        console.log(`路径数量：${pathCount}`);
    } finally {
        await app.close();
    }
}

await exportOpenApi();
