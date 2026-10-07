/**
 * 实时通道：`GET /v1/realtime`（WebSocket 升级）。
 *
 * 鉴权：复用与 REST 相同的守卫（`Authorization: Bearer`）。浏览器 WebSocket
 * 无法自定义请求头，因此也接受 `?token=` 查询参数——仅此一处允许，其余接口不接受。
 *
 * 协议：
 *  - 服务端 → 客户端：`{ seq, type, payload }`（`RealtimeEventDto` + 序号）；
 *  - 客户端 → 服务端：`{ type: 'ping' }` 心跳，服务端回 `{ type: 'pong' }`；
 *  - 客户端按指数退避重连（上限 30s），`seq` 用于判断是否漏事件（漏则全量刷新）。
 */
import type {FastifyRequest, preHandlerHookHandler} from 'fastify';
import {z} from 'zod';
import {REALTIME_PATH} from '../../contracts/endpoints.js';
import {bearerToken} from '../auth.js';
import type {GentlyInstance} from '../instance.js';

interface ClientMessage {
    type?: string;
}

/** 把 `?token=` 提升为 Authorization 头（仅 WebSocket 握手场景） */
const tokenFromQuery: preHandlerHookHandler = async (request: FastifyRequest) => {
    if (bearerToken(request)) return;
    const query = request.query as {token?: unknown} | undefined;
    if (query && typeof query.token === 'string') {
        request.headers.authorization = `Bearer ${query.token}`;
    }
};

export async function registerRealtimeRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        REALTIME_PATH,
        {
            websocket: true,
            schema: {
                operationId: 'realtime.connect',
                tags: ['health'],
                summary: '实时事件通道（WebSocket）：下载进度、插件健康、会话吊销',
                querystring: z.object({token: z.string().optional().describe('无法设置请求头时使用')}),
            },
            // 顺序：先归一化令牌来源，再执行统一鉴权守卫
            preHandler: [tokenFromQuery, app.deps.requireAuth],
        },
        (socket, request) => {
            // 守卫已在 preHandler 中执行并注入 principal
            const userId = request.principal?.userId ?? 'anonymous';
            const unsubscribe = app.deps.realtime.subscribe(userId, socket);

            const heartbeat = setInterval(() => app.deps.realtime.heartbeat(), 30_000);
            heartbeat.unref();

            socket.send(
                JSON.stringify({type: 'session.ready', payload: {userId, serverTime: new Date().toISOString()}}),
            );

            socket.on('message', (raw: Buffer) => {
                let message: ClientMessage;
                try {
                    message = JSON.parse(raw.toString()) as ClientMessage;
                } catch {
                    return; // 非法消息直接忽略，不断连接（避免客户端 bug 造成重连风暴）
                }
                if (message.type === 'ping') {
                    socket.send(JSON.stringify({type: 'pong'}));
                }
            });

            socket.on('close', () => {
                clearInterval(heartbeat);
                unsubscribe();
            });
        },
    );
}
