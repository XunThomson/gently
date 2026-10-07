/**
 * Vitest 配置。
 *
 * 刻意保持最小：本仓库的测试只依赖 Node 内置能力和 fastify 的 `inject()`，
 * 不需要 jsdom / 覆盖率插件等额外依赖，避免测试环境与运行环境漂移。
 * `hookTimeout` / `testTimeout` 放宽到 20s：每个用例都要 `buildApp()` 装配
 * 完整基础设施（含插件扫描），机器负载高时默认 5s 会偶发超时。
 */
import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        hookTimeout: 20_000,
        testTimeout: 20_000,
    },
});
