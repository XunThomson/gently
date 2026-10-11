/**
 * 插件域的**管理面**门面：配置 / 凭据 / 订阅 / 更新检查 / 订阅内条目。
 *
 * 与 `core.bridge.ts` 里的 `corePlugin`（安装、启停、卸载、兼容收敛）是同一套约定：
 * - **读**：无核心（浏览器）或核心报错 → `null`，调用方退回 mock 或空态；
 * - **写**：一律返回 `CoreResult`，让界面能处理 `common.conflict`（配置并发）与
 *   `common.invalid_argument`（凭据键未声明）这类**需要用户看到细节**的失败。
 *
 * 凭据只读写插件**清单声明过**的键，落点在核心的 `CredentialStore`（当前是内存实现 →
 * 重启失效，见契约 §2「已知缺口」），前端拿不到值，只有 `present`。
 */

import type {
    CatalogEntry,
    CoreResult,
    PluginCredentialStatus,
    PluginUpdateCheck,
    Subscription,
} from '../api';
import {coreAvailable, invokeCore} from './core.bridge';

/** 读包装：无核心或失败都当作「没有数据」。 */
async function read<T>(command: string, params: Record<string, unknown> = {}): Promise<T | null> {
    if (!coreAvailable()) return null;
    const result = await invokeCore<T>(command, params);
    return result.ok ? result.data : null;
}

/* ------------------------------ 更新检查 ------------------------------ */

/**
 * 与来源比对版本/校验和；**只检查，不自动更新**。
 *
 * `null` 表示「无从比对」：本地文件/目录/粘贴导入的插件，应用不知道用户手上有没有新版；
 * 订阅来源的索引还没缓存时核心会报 `subscription.fetch_failed`，界面应提示先刷新订阅。
 */
export function corePluginCheckUpdate(id: string): Promise<PluginUpdateCheck | null> {
    return read<PluginUpdateCheck>('plugin.checkUpdate', {id});
}

/* ------------------------------ 配置 ------------------------------ */

export function corePluginConfigGet(
    id: string,
): Promise<{values: Record<string, unknown>; revision: number} | null> {
    return read('plugin.config.get', {id});
}

/**
 * 写入配置。`revision` 不匹配 → `common.conflict`，`details.current` 给出当前值：
 * 界面据此提示「配置已在别处改动」并让用户决定是否覆盖重试。
 */
export function corePluginConfigPut(
    id: string,
    values: Record<string, unknown>,
    revision: number,
): Promise<CoreResult<{revision: number}>> {
    return invokeCore<{revision: number}>('plugin.config.put', {id, values, revision});
}

/* ------------------------------ 凭据 ------------------------------ */

/** 写入一项凭据（键必须已在清单里声明）。 */
export function corePluginCredentialSet(id: string, key: string, value: string): Promise<CoreResult<null>> {
    return invokeCore<null>('plugin.credentials.set', {id, key, value});
}

/** 清除一项凭据；不给 `key` 表示清空该插件的全部凭据。 */
export function corePluginCredentialClear(id: string, key?: string): Promise<CoreResult<null>> {
    return invokeCore<null>('plugin.credentials.clear', {id, ...(key ? {key} : {})});
}

/** 只回「是否已配置」+ 界面展示用的标签/敏感标记，**永不返回值**。 */
export function corePluginCredentialStatus(id: string): Promise<PluginCredentialStatus[] | null> {
    return read<PluginCredentialStatus[]>('plugin.credentials.status', {id});
}

/* ------------------------------ 订阅 ------------------------------ */

/** 订阅源列表（名称、URL、最近成功刷新时间、条目数、最近失败原因）。 */
export function corePluginSubscriptions(): Promise<Subscription[] | null> {
    return read<Subscription[]>('plugin.subscriptions.list');
}

/** 添加订阅：核心登记后**立即尝试拉一次索引**，失败不算添加失败（列表里带 error 提示）。 */
export function corePluginAddSubscription(url: string, name?: string): Promise<CoreResult<Subscription>> {
    return invokeCore<Subscription>('plugin.subscriptions.add', {
        url,
        ...(name && name.trim() ? {name} : {}),
    });
}

/** 移除订阅；已安装的插件不受影响。 */
export function corePluginRemoveSubscription(id: string): Promise<CoreResult<null>> {
    return invokeCore<null>('plugin.subscriptions.remove', {id});
}

/** 重新拉取索引并本地缓存；失败保留旧索引（`subscription.fetch_failed`）。 */
export function corePluginRefreshSubscription(id: string): Promise<CoreResult<Subscription>> {
    return invokeCore<Subscription>('plugin.subscriptions.refresh', {id});
}

/** 订阅内可安装条目（带 `installed` / `updateAvailable`）；未刷新过的订阅没有条目。 */
export function corePluginCatalog(query?: {
    subscriptionId?: string;
    query?: string;
    tags?: string[];
}): Promise<CatalogEntry[] | null> {
    return read<CatalogEntry[]>('plugin.catalog.list', {
        ...(query?.subscriptionId ? {subscriptionId: query.subscriptionId} : {}),
        ...(query?.query ? {query: query.query} : {}),
        ...(query?.tags && query.tags.length > 0 ? {tags: query.tags} : {}),
    });
}
