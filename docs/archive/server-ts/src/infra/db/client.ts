/**
 * Postgres 连接（Drizzle）。
 *
 * 设计取舍：**连接是惰性的**——未配置 `DATABASE_URL` 时返回 `kind: 'none'` 的空实现，
 * 服务照常启动（契约骨架阶段不需要数据库），`/ready` 会标记为 degraded。
 * 业务接入后把 `db` 换成真实实例即可，调用方签名不变。
 */
import {drizzle, type NodePgDatabase} from 'drizzle-orm/node-postgres';
import type {FastifyBaseLogger} from 'fastify';
import {Pool} from 'pg';
import type {AppEnv} from '../../config/env.js';

export interface DbClient {
    /** 存储实现名，`none` 表示未配置（降级） */
    readonly kind: 'postgres' | 'none';
    /** Drizzle 实例；未配置时为 undefined */
    readonly db: NodePgDatabase<Record<string, never>> | undefined;
    /** 探针用：一次 `select 1` */
    healthy(): Promise<boolean>;
    close(): Promise<void>;
}

const NONE: DbClient = {
    kind: 'none',
    db: undefined,
    healthy: async () => false,
    close: async () => undefined,
};

export function createDb(env: AppEnv, logger?: FastifyBaseLogger): DbClient {
    if (!env.hasDatabase || !env.DATABASE_URL) {
        logger?.warn('未配置 DATABASE_URL：数据库能力降级（接口仍可访问）');
        return NONE;
    }

    const pool = new Pool({
        connectionString: env.DATABASE_URL,
        // 单机桌面后端：连接池保持小而稳，避免占满 Postgres 默认上限
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: 'gently-server',
    });

    // 连接池错误必须有人监听，否则会以未捕获异常形式退出进程
    pool.on('error', (err) => logger?.error({err}, 'postgres pool error'));

    return {
        kind: 'postgres',
        db: drizzle(pool),
        async healthy() {
            try {
                await pool.query('select 1');
                return true;
            } catch {
                return false;
            }
        },
        async close() {
            await pool.end();
        },
    };
}
