/**
 * 鉴权基础设施：口令散列、令牌签发/校验、请求守卫。
 *
 * 这一层**不含业务**（没有用户表、没有登录流程），只提供：
 *  - `TokenService`：HS256 访问令牌 + 刷新令牌；
 *  - `password`：Argon2id 散列（参数集中在此，便于统一调参）；
 *  - `authGuard`：按端点清单的 `auth` 标记保护路由。
 *
 * 业务接入时只需实现「用哪个用户表查口令」，其余不用改。
 */
import {hash as argonHash, verify as argonVerify} from '@node-rs/argon2';
import type {FastifyReply, FastifyRequest, preHandlerHookHandler} from 'fastify';
import {SignJWT, jwtVerify, type JWTPayload} from 'jose';
import type {AppEnv} from '../config/env.js';
import {ApiError} from './errors.js';

/* ============================== 主体 ============================== */

export interface Principal {
    userId: string;
    nickname: string;
    level?: number;
}

declare module 'fastify' {
    interface FastifyRequest {
        /** 由 authGuard 注入；未鉴权时为 undefined */
        principal?: Principal;
    }
}

/* ============================== 口令 ============================== */

/**
 * Argon2id 参数（OWASP 建议：19 MiB 内存 / 2 迭代 / 1 并行）。
 * 统一封装，避免各处自定义强度导致校验行为不一致。
 */
const ARGON_OPTIONS = {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
} as const;

export const password = {
    hash: (plain: string): Promise<string> => argonHash(plain, ARGON_OPTIONS),
    /** 校验失败返回 false，不抛异常（避免把「口令错误」写成 500） */
    async verify(hashed: string, plain: string): Promise<boolean> {
        try {
            return await argonVerify(hashed, plain, ARGON_OPTIONS);
        } catch {
            return false;
        }
    },
};

/* ============================== 令牌 ============================== */

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
    expiresInSec: number;
}

export class TokenService {
    private readonly key: Uint8Array;

    constructor(
        secret: string,
        readonly accessTtlSec: number,
        readonly refreshTtlSec: number,
    ) {
        this.key = new TextEncoder().encode(secret);
    }

    private async sign(principal: Principal, ttlSec: number, typ: 'access' | 'refresh'): Promise<string> {
        return new SignJWT({nickname: principal.nickname, level: principal.level, typ})
            .setProtectedHeader({alg: 'HS256', typ: 'JWT'})
            .setSubject(principal.userId)
            .setIssuedAt()
            .setIssuer('gently')
            .setAudience('gently-client')
            .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
            .sign(this.key);
    }

    async issue(principal: Principal): Promise<TokenPair> {
        const [accessToken, refreshToken] = await Promise.all([
            this.sign(principal, this.accessTtlSec, 'access'),
            this.sign(principal, this.refreshTtlSec, 'refresh'),
        ]);
        return {accessToken, refreshToken, expiresInSec: this.accessTtlSec};
    }

    private async verify(token: string, typ: 'access' | 'refresh'): Promise<Principal> {
        let payload: JWTPayload;
        try {
            ({payload} = await jwtVerify(token, this.key, {
                algorithms: ['HS256'],
                issuer: 'gently',
                audience: 'gently-client',
            }));
        } catch (err) {
            if ((err as {code?: string}).code === 'ERR_JWT_EXPIRED') {
                throw ApiError.tokenExpired();
            }
            throw ApiError.unauthorized('令牌无效');
        }
        if (payload.typ !== typ || typeof payload.sub !== 'string') {
            throw ApiError.unauthorized('令牌类型不正确');
        }
        return {
            userId: payload.sub,
            nickname: typeof payload.nickname === 'string' ? payload.nickname : payload.sub,
            ...(typeof payload.level === 'number' ? {level: payload.level} : {}),
        };
    }

    verifyAccess = (token: string): Promise<Principal> => this.verify(token, 'access');

    verifyRefresh = (token: string): Promise<Principal> => this.verify(token, 'refresh');
}

/* ============================== 请求守卫 ============================== */

const BEARER = /^Bearer\s+(.+)$/i;

/** 从 Authorization 头取令牌 */
export function bearerToken(request: FastifyRequest): string | null {
    const raw = request.headers.authorization;
    if (typeof raw !== 'string') return null;
    return BEARER.exec(raw)?.[1]?.trim() ?? null;
}

export interface AuthGuardDeps {
    tokens: TokenService;
    /** 关闭时（开发/测试）注入虚拟主体，便于在没有登录实现时联调 */
    required: boolean;
    /** 开发虚拟主体 */
    devPrincipal?: Principal;
}

const DEFAULT_DEV_PRINCIPAL: Principal = {userId: 'dev-user', nickname: '开发者', level: 0};

/**
 * 鉴权中间件：
 *  - 带令牌：校验并注入 `request.principal`；令牌过期返回 `auth.token_expired`（前端据此静默刷新）；
 *  - 无令牌：`required` 为真时返回 `auth.unauthorized`，否则注入开发主体并继续。
 */
export function createAuthGuard({tokens, required, devPrincipal}: AuthGuardDeps): preHandlerHookHandler {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
        const token = bearerToken(request);
        if (!token) {
            if (required) throw ApiError.unauthorized('缺少访问令牌');
            request.principal = devPrincipal ?? DEFAULT_DEV_PRINCIPAL;
            return;
        }
        request.principal = await tokens.verifyAccess(token);
    };
}

/** 取当前主体；缺失说明路由忘了挂 authGuard，属于编码错误 */
export function requirePrincipal(request: FastifyRequest): Principal {
    const principal = request.principal;
    if (!principal) throw ApiError.unauthorized('该接口需要登录');
    return principal;
}

export function createAuth(env: AppEnv) {
    const tokens = new TokenService(env.jwtSecret, env.ACCESS_TOKEN_TTL_SEC, env.REFRESH_TOKEN_TTL_SEC);
    const guard = createAuthGuard({tokens, required: env.authRequired});
    return {tokens, guard};
}
