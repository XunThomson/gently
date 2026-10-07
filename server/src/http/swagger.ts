/**
 * OpenAPI 文档装配。
 *
 * 文档由**路由上的 Zod schema**自动生成，不存在手写文档漂移的问题；
 * `/docs` 是联调与自测入口（生产部署若不需要，在网关层屏蔽该前缀即可）。
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {jsonSchemaTransform} from 'fastify-type-provider-zod';
import type {AppEnv} from '../config/env.js';
import {REALTIME_PATH, TAGS} from '../contracts/endpoints.js';
import type {GentlyInstance} from './instance.js';

export const API_VERSION = '1.0.0';

const TAG_DESCRIPTIONS: Record<string, string> = {
    health: '探针与运维端点',
    auth: '登录、令牌轮换与当前用户',
    catalog: '曲库检索、榜单、专辑、精选歌单与歌词',
    library: '收藏、歌单、最近播放等用户数据同步（写操作幂等）',
    recommend: '个性化推荐与反馈回路',
    playback: '播放地址解析与播放上报',
    plugin: '音源插件市场与配置',
    download: '下载任务管理',
    skin: '主题皮肤市场与同步',
};

export async function registerDocs(app: GentlyInstance, env: AppEnv): Promise<void> {
    await app.register(swagger, {
        openapi: {
            openapi: '3.0.3',
            info: {
                title: 'gently API',
                description: [
                    '桌面音乐播放器 `gently` 的后端接口。',
                    '',
                    `- 统一信封：\`{ ok, data | error, requestId }\`；`,
                    '- 分页：游标式，游标对客户端不透明；',
                    `- 实时通道：\`${REALTIME_PATH}\`（WebSocket）；`,
                    '- 未接入业务的端点返回 `501 common.not_implemented`（而非 404）。',
                    '',
                    '规范正文见仓库 `docs/contracts/backend-api.md`。',
                ].join('\n'),
                version: API_VERSION,
            },
            servers: [{url: env.baseUrl, description: '当前实例'}],
            tags: TAGS.map((name) => ({name, description: TAG_DESCRIPTIONS[name] ?? name})),
            components: {
                securitySchemes: {
                    bearerAuth: {type: 'http', scheme: 'bearer', bearerFormat: 'JWT'},
                },
            },
        },
        transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
        routePrefix: '/docs',
        // 文档页是自测工具，不是产品界面：不额外加 CSP（helmet 侧已关闭 CSP）
        staticCSP: false,
        uiConfig: {docExpansion: 'list', deepLinking: true, persistAuthorization: true},
    });
}
