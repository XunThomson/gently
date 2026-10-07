/**
 * 日志：pino 配置。
 *
 *  - 开发/测试用 pino-pretty 便于阅读，生产输出 JSON（可被采集器直接消费）；
 *  - `requestId` 由 fastify 生成并贯穿一次请求的全部日志；
 *  - 敏感字段（Authorization / token / password）统一脱敏，避免日志泄漏。
 */
import type {FastifyBaseLogger} from 'fastify';
import {pino, type LoggerOptions} from 'pino';
import type {AppEnv} from '../config/env.js';

/** 需要脱敏的字段路径 */
const REDACT = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["idempotency-key"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.token',
    '*.refreshToken',
    '*.accessToken',
    '*.secret',
];

/**
 * 返回 fastify 的日志接口类型而非 pino 的具体类型：
 * 这样各模块传递实例时不会因为 pino 的内部字段差异而不兼容。
 */
export function createLogger(env: AppEnv): FastifyBaseLogger {
    const options: LoggerOptions = {
        level: env.isTest ? 'silent' : env.LOG_LEVEL,
        redact: {paths: REDACT, censor: '[redacted]'},
        base: {service: 'gently-server', env: env.NODE_ENV},
        timestamp: pino.stdTimeFunctions.isoTime,
    };

    if (env.isProduction) {
        return pino(options);
    }

    return pino({
        ...options,
        transport: {
            target: 'pino-pretty',
            options: {colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env'},
        },
    });
}
