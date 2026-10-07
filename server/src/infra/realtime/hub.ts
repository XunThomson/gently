/**
 * 实时通道（WebSocket）广播中枢。
 *
 * 事件模型与 REST DTO 共用（`RealtimeEventDto`），避免两套模型漂移。
 * 连接按 userId 分组：下载进度、插件健康变化只推给相关用户。
 *
 * 断线重连、Last-Event-Id 续传由客户端负责（见 `docs/contracts/backend-api.md` §7）；
 * 服务端提供 `subscribe` 返回的 `since` 序号，便于客户端判断是否漏事件。
 */
import type {FastifyBaseLogger} from 'fastify';
import type {RealtimeEventDto} from '../../contracts/models.js';

/** 只依赖用到的最小 socket 形状，避免把 ws 的类型泄漏到业务层 */
export interface RealtimeSocket {
    readyState: number;
    send(payload: string): void;
    close(code?: number, reason?: string): void;
    ping?(): void;
}

export interface RealtimeHub {
    /** 订阅用户事件流；返回退订函数 */
    subscribe(userId: string, socket: unknown): () => void;
    /** 推送给某个用户的全部连接；返回实际送达数 */
    publish(userId: string, event: RealtimeEventDto): number;
    /** 广播给所有连接（运维公告类） */
    broadcast(event: RealtimeEventDto): number;
    /** 心跳：对全部连接发 ping，返回存活连接数 */
    heartbeat(): number;
    /** 当前连接数（供 /ready 观测） */
    readonly connections: number;
    close(): void;
}

/** WebSocket.OPEN */
const OPEN = 1;

export function createRealtimeHub(logger?: FastifyBaseLogger): RealtimeHub {
    const byUser = new Map<string, Set<RealtimeSocket>>();
    let sequence = 0;

    const send = (socket: RealtimeSocket, event: RealtimeEventDto, userId: string): boolean => {
        if (socket.readyState !== OPEN) return false;
        try {
            // seq 让客户端能判断是否漏事件（重连后可据此决定是否全量刷新）
            socket.send(JSON.stringify({seq: ++sequence, ...event}));
            return true;
        } catch (err) {
            logger?.warn({err, userId}, 'realtime 推送失败，移除连接');
            remove(userId, socket);
            return false;
        }
    };

    const remove = (userId: string, socket: RealtimeSocket): void => {
        const set = byUser.get(userId);
        if (!set) return;
        set.delete(socket);
        if (set.size === 0) byUser.delete(userId);
    };

    const collect = (): RealtimeSocket[] => [...byUser.values()].flatMap((set) => [...set]);

    return {
        get connections() {
            return collect().length;
        },

        subscribe(userId, socket) {
            const s = socket as RealtimeSocket;
            const set = byUser.get(userId) ?? new Set<RealtimeSocket>();
            set.add(s);
            byUser.set(userId, set);
            logger?.debug({userId, connections: set.size}, 'realtime 连接建立');
            return () => remove(userId, s);
        },

        publish(userId, event) {
            const set = byUser.get(userId);
            if (!set) return 0;
            let delivered = 0;
            for (const socket of set) {
                if (send(socket, event, userId)) delivered += 1;
            }
            return delivered;
        },

        broadcast(event) {
            let delivered = 0;
            for (const [userId, set] of byUser) {
                for (const socket of set) {
                    if (send(socket, event, userId)) delivered += 1;
                }
            }
            return delivered;
        },

        heartbeat() {
            let alive = 0;
            for (const socket of collect()) {
                if (socket.readyState !== OPEN) continue;
                socket.ping?.();
                alive += 1;
            }
            return alive;
        },

        close() {
            for (const socket of collect()) {
                if (socket.readyState === OPEN) socket.close(1001, 'server shutting down');
            }
            byUser.clear();
        },
    };
}
