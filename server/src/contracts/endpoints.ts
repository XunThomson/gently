/**
 * 接口清单（Interface Manifest）——后端对外契约的**唯一目录**。
 *
 * 每个端点必须在此登记：
 *  - 路由注册时按 `path` + `method` 实现，未实现的返回 501（而不是 404），
 *    这样客户端能区分「后端没这个接口」与「后端还没做」；
 *  - `test/endpoints.test.ts` 会遍历本清单，断言每个端点都已注册且鉴权行为正确；
 *  - OpenAPI 的 operationId 直接取 `id`，客户端可按 id 生成调用代码。
 */
import {ERROR_CODES} from './primitives.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointSpec {
    /** 唯一操作 id，同时作为 OpenAPI operationId */
    id: string;
    method: HttpMethod;
    /** fastify 路径（参数用 `:name`，OpenAPI 会自动转成 `{name}`） */
    path: string;
    /** OpenAPI 分组，等于业务域 */
    tag: string;
    auth: boolean;
    summary: string;
    /** 基础设施端点（健康检查等）为 true；业务端点当前一律 false，返回 501 */
    implemented: boolean;
    /** 需要 `Idempotency-Key` 请求头；重放返回首次结果 */
    idempotent?: boolean;
}

export const REALTIME_PATH = '/v1/realtime';

export const ENDPOINTS: readonly EndpointSpec[] = [
    /* ---------- 探针（真实实现，基础设施） ---------- */
    {
        id: 'health.check',
        method: 'GET',
        path: '/health',
        tag: 'health',
        auth: false,
        summary: '存活探针：进程与版本',
        implemented: true,
    },
    {
        id: 'health.ready',
        method: 'GET',
        path: '/ready',
        tag: 'health',
        auth: false,
        summary: '就绪探针：数据库 / 缓存 / 队列连通性（未配置时标记为 degraded）',
        implemented: true,
    },

    /* ---------- 认证 ---------- */
    {
        id: 'auth.login',
        method: 'POST',
        path: '/v1/auth/login',
        tag: 'auth',
        auth: false,
        summary: '登录，返回 access + refresh 令牌',
        implemented: false,
    },
    {
        id: 'auth.refresh',
        method: 'POST',
        path: '/v1/auth/refresh',
        tag: 'auth',
        auth: false,
        summary: '轮换刷新令牌',
        implemented: false,
    },
    {
        id: 'auth.logout',
        method: 'POST',
        path: '/v1/auth/logout',
        tag: 'auth',
        auth: true,
        summary: '登出并吊销当前会话',
        implemented: false,
    },
    {
        id: 'auth.profile',
        method: 'GET',
        path: '/v1/auth/profile',
        tag: 'auth',
        auth: true,
        summary: '当前用户资料',
        implemented: false,
    },

    /* ---------- 曲库 ---------- */
    {
        id: 'catalog.search',
        method: 'GET',
        path: '/v1/search',
        tag: 'catalog',
        auth: true,
        summary: '跨源检索；后端负责去重与候选音源排序',
        implemented: false,
    },
    {
        id: 'catalog.charts',
        method: 'GET',
        path: '/v1/charts',
        tag: 'catalog',
        auth: true,
        summary: '榜单（类型 + 周期 + 日期）',
        implemented: false,
    },
    {
        id: 'catalog.track',
        method: 'GET',
        path: '/v1/tracks/:ref',
        tag: 'catalog',
        auth: true,
        summary: '曲目详情（含全部候选音源）',
        implemented: false,
    },
    {
        id: 'catalog.album',
        method: 'GET',
        path: '/v1/albums/:id',
        tag: 'catalog',
        auth: true,
        summary: '专辑详情',
        implemented: false,
    },
    {
        id: 'catalog.curated',
        method: 'GET',
        path: '/v1/curated/:id',
        tag: 'catalog',
        auth: true,
        summary: '编辑精选歌单详情',
        implemented: false,
    },
    {
        id: 'catalog.lyrics',
        method: 'GET',
        path: '/v1/lyrics',
        tag: 'catalog',
        auth: true,
        summary: '歌词（按曲目引用查询）',
        implemented: false,
    },

    /* ---------- 用户数据 ---------- */
    {
        id: 'library.favorites.list',
        method: 'GET',
        path: '/v1/me/favorites',
        tag: 'library',
        auth: true,
        summary: '收藏分页',
        implemented: false,
    },
    {
        id: 'library.favorites.sync',
        method: 'POST',
        path: '/v1/me/favorites/sync',
        tag: 'library',
        auth: true,
        summary: '收藏增量同步（幂等）',
        implemented: false,
        idempotent: true,
    },
    {
        id: 'library.playlists.list',
        method: 'GET',
        path: '/v1/me/playlists',
        tag: 'library',
        auth: true,
        summary: '歌单列表',
        implemented: false,
    },
    {
        id: 'library.playlists.create',
        method: 'POST',
        path: '/v1/me/playlists',
        tag: 'library',
        auth: true,
        summary: '创建 / 覆盖歌单（幂等）',
        implemented: false,
        idempotent: true,
    },
    {
        id: 'library.playlists.delete',
        method: 'DELETE',
        path: '/v1/me/playlists/:id',
        tag: 'library',
        auth: true,
        summary: '删除歌单',
        implemented: false,
    },
    {
        id: 'library.history.list',
        method: 'GET',
        path: '/v1/me/history',
        tag: 'library',
        auth: true,
        summary: '最近播放分页',
        implemented: false,
    },
    {
        id: 'library.history.push',
        method: 'POST',
        path: '/v1/me/history',
        tag: 'library',
        auth: true,
        summary: '上报播放记录（幂等）',
        implemented: false,
        idempotent: true,
    },

    /* ---------- 推荐 ---------- */
    {
        id: 'recommend.home',
        method: 'GET',
        path: '/v1/recommend/home',
        tag: 'recommend',
        auth: true,
        summary: '首页推荐（单曲 + 专辑 + 歌单 + 画像）',
        implemented: false,
    },
    {
        id: 'recommend.similar',
        method: 'GET',
        path: '/v1/recommend/similar',
        tag: 'recommend',
        auth: true,
        summary: '相似曲目',
        implemented: false,
    },
    {
        id: 'recommend.feedback',
        method: 'POST',
        path: '/v1/recommend/feedback',
        tag: 'recommend',
        auth: true,
        summary: '推荐反馈（播放 / 跳过 / 喜欢），驱动画像更新',
        implemented: false,
        idempotent: true,
    },

    /* ---------- 播放 ---------- */
    {
        id: 'playback.resolve',
        method: 'POST',
        path: '/v1/playback/resolve',
        tag: 'playback',
        auth: true,
        summary: '解析播放地址；全部音源失败时返回 data: null（不是错误）',
        implemented: false,
    },
    {
        id: 'playback.report',
        method: 'POST',
        path: '/v1/playback/report',
        tag: 'playback',
        auth: true,
        summary: '播放完成度上报',
        implemented: false,
        idempotent: true,
    },

    /* ---------- 音源插件 ---------- */
    {
        id: 'plugin.list',
        method: 'GET',
        path: '/v1/plugins',
        tag: 'plugin',
        auth: true,
        summary: '插件市场列表（含健康状态）',
        implemented: false,
    },
    {
        id: 'plugin.install',
        method: 'POST',
        path: '/v1/plugins/install',
        tag: 'plugin',
        auth: true,
        summary: '安装插件（需显式确认）',
        implemented: false,
        idempotent: true,
    },
    {
        id: 'plugin.uninstall',
        method: 'POST',
        path: '/v1/plugins/uninstall',
        tag: 'plugin',
        auth: true,
        summary: '卸载插件',
        implemented: false,
        idempotent: true,
    },
    {
        id: 'plugin.checkUpdates',
        method: 'POST',
        path: '/v1/plugins/check-updates',
        tag: 'plugin',
        auth: true,
        summary: '检查插件更新',
        implemented: false,
    },
    {
        id: 'plugin.config.get',
        method: 'GET',
        path: '/v1/plugins/:id/config',
        tag: 'plugin',
        auth: true,
        summary: '读取插件配置（含 revision）',
        implemented: false,
    },
    {
        id: 'plugin.config.put',
        method: 'POST',
        path: '/v1/plugins/:id/config',
        tag: 'plugin',
        auth: true,
        summary: '写入插件配置（乐观并发）',
        implemented: false,
        idempotent: true,
    },

    /* ---------- 下载 ---------- */
    {
        id: 'download.list',
        method: 'GET',
        path: '/v1/downloads',
        tag: 'download',
        auth: true,
        summary: '下载任务分页',
        implemented: false,
    },
    {
        id: 'download.create',
        method: 'POST',
        path: '/v1/downloads',
        tag: 'download',
        auth: true,
        summary: '创建下载任务（幂等）',
        implemented: false,
        idempotent: true,
    },
    {
        id: 'download.pause',
        method: 'POST',
        path: '/v1/downloads/:id/pause',
        tag: 'download',
        auth: true,
        summary: '暂停下载',
        implemented: false,
    },
    {
        id: 'download.resume',
        method: 'POST',
        path: '/v1/downloads/:id/resume',
        tag: 'download',
        auth: true,
        summary: '恢复下载',
        implemented: false,
    },
    {
        id: 'download.remove',
        method: 'DELETE',
        path: '/v1/downloads/:id',
        tag: 'download',
        auth: true,
        summary: '删除下载任务',
        implemented: false,
    },
    {
        id: 'download.clearFinished',
        method: 'POST',
        path: '/v1/downloads/clear-finished',
        tag: 'download',
        auth: true,
        summary: '清空已完成任务',
        implemented: false,
        idempotent: true,
    },

    /* ---------- 皮肤 ---------- */
    {
        id: 'skin.list',
        method: 'GET',
        path: '/v1/skins',
        tag: 'skin',
        auth: true,
        summary: '皮肤市场分页',
        implemented: false,
    },
    {
        id: 'skin.detail',
        method: 'GET',
        path: '/v1/skins/:id',
        tag: 'skin',
        auth: true,
        summary: '皮肤详情',
        implemented: false,
    },
    {
        id: 'skin.publish',
        method: 'POST',
        path: '/v1/skins',
        tag: 'skin',
        auth: true,
        summary: '发布皮肤（幂等）',
        implemented: false,
        idempotent: true,
    },
    {
        id: 'skin.mine',
        method: 'GET',
        path: '/v1/me/skins',
        tag: 'skin',
        auth: true,
        summary: '我的皮肤（离线副本对账用）',
        implemented: false,
    },
    {
        id: 'skin.sync',
        method: 'POST',
        path: '/v1/me/skins/sync',
        tag: 'skin',
        auth: true,
        summary: '皮肤安装状态同步（幂等）',
        implemented: false,
        idempotent: true,
    },
];

/** 按 id 取端点，路由与测试共用 */
export const endpointById = (id: string): EndpointSpec | undefined => ENDPOINTS.find((e) => e.id === id);

/** 全部业务域（用于 OpenAPI tag 排序与文档生成） */
export const TAGS = [...new Set(ENDPOINTS.map((e) => e.tag))];

/** 统一提供给客户端的「未实现」错误，便于前端在联调期识别 */
export const NOT_IMPLEMENTED = {
    code: ERROR_CODES.notImplemented,
    message: '该接口已在契约中定义，但业务实现尚未接入。',
} as const;
