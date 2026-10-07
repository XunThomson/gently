/**
 * 进程入口：启动、就绪日志、优雅退出。
 *
 * 优雅退出顺序：停止接收新请求（close）→ 关闭连接池/队列 → 退出。
 * 超时兜底 10s，避免挂住的连接让容器无法停止。
 */
import {buildApp} from './app.js';
import {loadEnv} from './config/env.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
    const env = loadEnv();
    const app = await buildApp({env});

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            app.log.info({signal}, '收到退出信号，开始优雅关闭');
            const timer = setTimeout(() => {
                app.log.error('优雅关闭超时，强制退出');
                process.exit(1);
            }, SHUTDOWN_TIMEOUT_MS);
            timer.unref();

            void app
                .close()
                .then(() => {
                    app.log.info('已关闭');
                    process.exit(0);
                })
                .catch((err: unknown) => {
                    app.log.error({err}, '关闭过程出错');
                    process.exit(1);
                });
        });
    }

    // 未捕获异常必须记录后再退出：静默退出会让线上问题无从查起
    process.on('unhandledRejection', (reason) => {
        app.log.error({err: reason}, 'unhandled rejection');
    });
    process.on('uncaughtException', (err) => {
        app.log.fatal({err}, 'uncaught exception，进程退出');
        process.exit(1);
    });

    await app.listen({port: env.PORT, host: env.HOST});
    app.log.info(
        {
            url: env.baseUrl,
            docs: `${env.baseUrl}/docs`,
            auth: env.authRequired ? 'required' : 'dev-bypass',
            db: app.deps.db.kind,
            cache: app.deps.cache.kind,
            plugins: app.deps.plugins.size,
        },
        'gently server 已启动',
    );
    if (env.usingDevSecret) {
        app.log.warn('使用开发兜底 JWT_SECRET：仅限本机联调，部署前必须配置');
    }
}

await main();
