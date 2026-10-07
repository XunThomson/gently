/**
 * 应用装配（composition root）。
 *
 * 职责：创建基础设施 → 装饰到 `app.deps` → 注册路由 → 注册错误处理。
 * **只有这里知道具体实现**，路由通过 `app.deps` 取依赖，便于测试时整体替换。
 */
import type {preHandlerHookHandler} from 'fastify';
import {loadEnv, type AppEnv} from './config/env.js';
import {createAuth, type TokenService} from './http/auth.js';
import {registerErrorHandling} from './http/errors.js';
import type {GentlyInstance} from './http/instance.js';
import {
    createIdempotencyGuard,
    createMemoryIdempotencyStore,
    createRedisIdempotencyStore,
    type IdempotencyStore,
} from './http/idempotency.js';
import {registerRoutes} from './http/routes/index.js';
import {createServer} from './http/server.js';
import {createCache, type CacheClient} from './infra/cache/redis.js';
import {createDb, type DbClient} from './infra/db/client.js';
import {createPluginHost, type PluginHost} from './infra/plugins/registry.js';
import {createQueues, type QueueClient} from './infra/queue/queue.js';
import {createRealtimeHub, type RealtimeHub} from './infra/realtime/hub.js';

/** 注入到 fastify 实例的依赖集合：路由层的唯一入口 */
export interface AppDeps {
    env: AppEnv;
    tokens: TokenService;
    /** 端点清单中 `auth: true` 的路由统一挂它 */
    requireAuth: preHandlerHookHandler;
    /** 端点清单中 `idempotent: true` 的路由用它生成守卫（scope = 端点 id） */
    idempotencyGuard: (endpointId: string) => preHandlerHookHandler;
    idempotency: IdempotencyStore;
    db: DbClient;
    cache: CacheClient;
    queues: QueueClient;
    plugins: PluginHost;
    realtime: RealtimeHub;
    /** 进程启动时间（uptime 计算） */
    startedAt: number;
}

declare module 'fastify' {
    interface FastifyInstance {
        deps: AppDeps;
    }
}

export interface BuildAppOptions {
    /** 注入自定义环境（测试用）；缺省读取 process.env */
    env?: AppEnv;
    /** 是否注册路由；冒烟测试可只测中间件 */
    withRoutes?: boolean;
}

/**
 * 构建应用实例。
 *
 * 返回的实例已注册全部插件与路由但**未监听**，
 * 测试可直接 `app.inject()`，生产由 `main.ts` 调用 `listen()`。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<GentlyInstance> {
    const env = options.env ?? loadEnv();
    const app = await createServer(env);

    const db = createDb(env, app.log);
    const cache = createCache(env, app.log);
    const queues = createQueues(env, app.log);
    const plugins = createPluginHost(env, app.log);
    const realtime = createRealtimeHub(app.log);
    const {tokens, guard} = createAuth(env);

    const idempotency: IdempotencyStore =
        cache.redis !== undefined ? createRedisIdempotencyStore(cache.redis) : createMemoryIdempotencyStore();

    const deps: AppDeps = {
        env,
        tokens,
        requireAuth: guard,
        idempotencyGuard: (endpointId: string) => createIdempotencyGuard(idempotency, endpointId),
        idempotency,
        db,
        cache,
        queues,
        plugins,
        realtime,
        startedAt: Date.now(),
    };
    app.decorate('deps', deps);

    // 插件在启动阶段扫描一次；失败不阻塞服务（单个插件问题只影响该插件）
    await plugins.load();

    app.addHook('onClose', async () => {
        realtime.close();
        await Promise.allSettled([db.close(), cache.close(), queues.close(), plugins.close()]);
    });

    // 必须在注册路由**之前**设置错误处理：fastify 的错误处理器不回溯作用于已注册的路由
    registerErrorHandling(app, env.isProduction);

    if (options.withRoutes !== false) {
        await registerRoutes(app);
    }

    return app;
}
