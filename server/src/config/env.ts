/**
 * 环境配置：**唯一**的配置入口。
 *
 * 规则：
 *  - 所有配置项在此用 Zod 校验，缺失/非法在启动期就失败（而不是运行期 500）；
 *  - 外部依赖（Postgres / Redis）为**可选**：未配置时服务仍可启动，
 *    相关能力降级为内存实现并在 `/ready` 中标记为 degraded；
 *  - 业务参数（超时、分页上限等）放这里，不散落在各模块。
 */
import 'dotenv/config';
import {z} from 'zod';

/** 逗号分隔字符串 → 数组（空值 → 空数组） */
const csv = z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string()));

const booleanish = z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOST: z.string().default('127.0.0.1'),
    PUBLIC_BASE_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    CORS_ORIGINS: csv.default('tauri://localhost,http://localhost:1420'),

    /** 生产必须提供；开发缺省时使用固定的开发密钥并告警 */
    JWT_SECRET: z.string().min(32).optional(),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(2_592_000),
    /** 是否强制鉴权；缺省在 production 下为 true，其它环境为 false（便于联调） */
    AUTH_REQUIRED: booleanish.optional(),

    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().optional(),

    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    PLUGIN_DIR: z.string().default('plugins'),
    PLUGIN_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
});

export type RawEnv = z.infer<typeof schema>;

export interface AppEnv extends RawEnv {
    isProduction: boolean;
    isTest: boolean;
    /** 有效鉴权开关 */
    authRequired: boolean;
    /** 令牌签名密钥（开发环境的兜底值不应用于生产） */
    jwtSecret: string;
    /** 是否使用开发兜底密钥 */
    usingDevSecret: boolean;
    baseUrl: string;
    /** Postgres 可用 */
    hasDatabase: boolean;
    /** Redis 可用 */
    hasRedis: boolean;
}

const DEV_SECRET = 'gently-development-only-secret-do-not-use-in-production';

/** 解析并校验配置；`overrides` 供测试注入 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        throw new Error(`环境配置校验失败：\n${detail}\n请参考 server/.env.example`);
    }

    const raw = parsed.data;
    const isProduction = raw.NODE_ENV === 'production';
    const isTest = raw.NODE_ENV === 'test';
    const usingDevSecret = raw.JWT_SECRET === undefined;

    if (isProduction && usingDevSecret) {
        throw new Error('生产环境必须设置 JWT_SECRET（至少 32 字符）：openssl rand -base64 48');
    }

    return {
        ...raw,
        isProduction,
        isTest,
        authRequired: raw.AUTH_REQUIRED ?? isProduction,
        jwtSecret: raw.JWT_SECRET ?? DEV_SECRET,
        usingDevSecret,
        baseUrl: raw.PUBLIC_BASE_URL ?? `http://${raw.HOST}:${raw.PORT}`,
        hasDatabase: raw.DATABASE_URL !== undefined,
        hasRedis: raw.REDIS_URL !== undefined,
    };
}

/** 进程级单例；测试请直接调用 loadEnv 以获得隔离实例 */
export const env = loadEnv();
