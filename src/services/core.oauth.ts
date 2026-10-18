/**
 * 第三方授权门面（契约 §2 的 `auth.*`）。
 *
 * 三条约定：
 * - **端点来自插件**：`auth.begin` 返回的 `authorizeUrl` 是插件清单里声明的地址，
 *   应用不内置任何第三方地址（ADR-0005）；
 * - **令牌不出核心**：这里拿不到令牌，也不该拿——插件通过沙箱里的
 *   `oauth.getAccessToken()` 使用它，界面只看得到「已授权 / 未授权 / 过期时间」；
 * - 授权页用**系统浏览器**打开（`fileService.openExternal`）：应用内不嵌 WebView，
 *   用户能在地址栏确认真实域名。
 */

import type {CoreResult, OAuthBeginResult, OAuthStatus} from '../api';
import {coreAvailable, invokeCore} from './core.bridge';
import {CORE_EVENTS} from './core.events';
import {fileService} from './file.service';

/** `auth:changed` 的载荷（契约 §3）。 */
export interface OAuthChangedPayload {
    pluginId: string;
    authorized: boolean;
    expiresAt?: number | null;
}

/**
 * 订阅授权状态变化；返回退订函数。
 *
 * 无核心时返回空操作（浏览器预览里没有授权这回事）。
 * 有了它就不需要轮询：回调线程换到令牌后立刻推一条。
 */
export async function oauthListen(
    handler: (payload: OAuthChangedPayload) => void,
): Promise<() => void> {
    if (!coreAvailable()) return () => undefined;
    const {listen} = await import('@tauri-apps/api/event');
    return listen<OAuthChangedPayload>(CORE_EVENTS['auth:changed'], (message) =>
        handler(message.payload),
    );
}

/** 读：无核心或失败都当作「不知道」（界面显示未授权，并说明需要桌面端）。 */
export async function oauthStatus(pluginId: string): Promise<OAuthStatus | null> {
    if (!coreAvailable()) return null;
    const result = await invokeCore<OAuthStatus>('auth.status', {pluginId});
    return result.ok ? result.data : null;
}

/**
 * 发起授权并把授权地址交给系统浏览器。
 *
 * 浏览器打开失败时**取消**这一轮：否则回调监听会白等到超时（180s），
 * 期间界面一直显示「等待授权」。
 */
export async function oauthBegin(pluginId: string): Promise<CoreResult<OAuthBeginResult>> {
    const result = await invokeCore<OAuthBeginResult>('auth.begin', {pluginId});
    if (!result.ok) return result;

    const opened = await fileService.openExternal(result.data.authorizeUrl);
    if (!opened) {
        await oauthCancel(pluginId);
        // 与 `core.bridge` 的失败信封同形（`traceId: 'client'` = 前端本地失败，没有核心 trace）
        return {
            ok: false,
            error: {
                code: 'common.unsupported_platform',
                message: '无法打开系统浏览器，已取消本轮授权',
            },
            traceId: 'client',
        };
    }
    return result;
}

/** 放弃等待中的授权（关掉回调监听）。 */
export function oauthCancel(pluginId: string): Promise<CoreResult<void>> {
    return invokeCore<void>('auth.cancel', {pluginId});
}

/** 退出登录：删掉凭据库里的令牌。 */
export function oauthSignOut(pluginId: string): Promise<CoreResult<void>> {
    return invokeCore<void>('auth.signOut', {pluginId});
}
