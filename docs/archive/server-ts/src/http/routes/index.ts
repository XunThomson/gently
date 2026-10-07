/**
 * 路由汇总：**注册顺序即 OpenAPI 中的分组顺序**。
 *
 * 每个域一个文件，文件内只做三件事：
 *  1. 声明 schema（校验 + 文档）；
 *  2. 挂鉴权 / 幂等守卫；
 *  3. 指向处理器（当前为 `notImplementedHandler`，业务接入时替换）。
 */
import type {GentlyInstance} from '../instance.js';
import {registerAuthRoutes} from './auth.routes.js';
import {registerCatalogRoutes} from './catalog.routes.js';
import {registerDownloadRoutes} from './download.routes.js';
import {registerHealthRoutes} from './health.routes.js';
import {registerLibraryRoutes} from './library.routes.js';
import {registerPlaybackRoutes} from './playback.routes.js';
import {registerPluginRoutes} from './plugin.routes.js';
import {registerRealtimeRoutes} from './realtime.routes.js';
import {registerRecommendRoutes} from './recommend.routes.js';
import {registerSkinRoutes} from './skin.routes.js';

export async function registerRoutes(app: GentlyInstance): Promise<void> {
    await app.register(registerHealthRoutes);
    await app.register(registerRealtimeRoutes);

    await app.register(registerAuthRoutes);
    await app.register(registerCatalogRoutes);
    await app.register(registerLibraryRoutes);
    await app.register(registerRecommendRoutes);
    await app.register(registerPlaybackRoutes);
    await app.register(registerPluginRoutes);
    await app.register(registerDownloadRoutes);
    await app.register(registerSkinRoutes);
}
