/**
 * 插件宿主：扫描插件目录、校验清单、维护健康状态。
 *
 * 本阶段只做**声明式**插件（读 `plugin.json`），不执行第三方代码：
 * 这样契约骨架可跑通，而代码沙箱（isolated-vm / worker 隔离）在业务阶段再接入，
 * 接入点就是 `loadEntryPoint()`。
 */
import {readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import type {FastifyBaseLogger} from 'fastify';
import type {AppEnv} from '../../config/env.js';
import type {PluginSummaryDto} from '../../contracts/models.js';
import {PLUGIN_MANIFEST_FILE, parseManifest, type LoadedPlugin} from './manifest.js';

export interface PluginHost {
    /** 扫描插件目录（启动时调用一次；可重复调用以热重载） */
    load(): Promise<number>;
    list(): PluginSummaryDto[];
    get(id: string): PluginSummaryDto | undefined;
    /** 探测结果回写（由 plugin-probe 队列任务调用） */
    markHealth(id: string, healthy: boolean, detail?: string): void;
    /** 已加载的插件数 */
    readonly size: number;
    /** 单次音源请求超时（毫秒）：业务调用插件时必须用这个值，避免各调用点自定义 */
    readonly requestTimeoutMs: number;
    close(): Promise<void>;
}

function toSummary(plugin: LoadedPlugin): PluginSummaryDto {
    const {manifest, healthy} = plugin;
    return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        ...(manifest.homepage ? {homepage: manifest.homepage} : {}),
        builtin: manifest.builtin,
        qualities: manifest.qualities,
        ...(healthy === undefined ? {} : {healthy}),
    };
}

export function createPluginHost(env: AppEnv, logger?: FastifyBaseLogger): PluginHost {
    const loaded = new Map<string, LoadedPlugin>();
    const rootDir = isAbsolute(env.PLUGIN_DIR) ? env.PLUGIN_DIR : resolve(process.cwd(), env.PLUGIN_DIR);

    return {
        get size() {
            return loaded.size;
        },

        requestTimeoutMs: env.PLUGIN_REQUEST_TIMEOUT_MS,

        async load() {
            loaded.clear();
            if (!existsSync(rootDir)) {
                logger?.info({dir: rootDir}, '插件目录不存在，跳过加载（可后续放入插件）');
                return 0;
            }

            const entries = await readdir(rootDir, {withFileTypes: true});
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const dir = join(rootDir, entry.name);
                const manifestPath = join(dir, PLUGIN_MANIFEST_FILE);
                if (!existsSync(manifestPath)) {
                    logger?.warn({dir}, '插件目录缺少 plugin.json，已跳过');
                    continue;
                }
                try {
                    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
                    const manifest = parseManifest(raw, manifestPath);
                    if (loaded.has(manifest.id)) {
                        logger?.warn({id: manifest.id, dir}, '插件 id 重复，保留先加载的一个');
                        continue;
                    }
                    loaded.set(manifest.id, {manifest, dir});
                } catch (err) {
                    // 单个插件失败不影响其它插件与服务启动
                    logger?.error({err, dir}, '插件加载失败');
                }
            }
            logger?.info({count: loaded.size, dir: rootDir}, '插件加载完成');
            return loaded.size;
        },

        list() {
            return [...loaded.values()]
                .map(toSummary)
                .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
        },

        get(id) {
            const plugin = loaded.get(id);
            return plugin ? toSummary(plugin) : undefined;
        },

        markHealth(id, healthy, detail) {
            const plugin = loaded.get(id);
            if (!plugin) return;
            plugin.healthy = healthy;
            if (detail === undefined) delete plugin.healthDetail;
            else plugin.healthDetail = detail;
        },

        async close() {
            loaded.clear();
        },
    };
}

/**
 * 入口加载占位：业务阶段在此接入沙箱执行。
 * 当前实现直接拒绝，避免出现「看似加载了插件但没有隔离」的隐患。
 */
export function loadEntryPoint(plugin: LoadedPlugin): never {
    throw new Error(`插件 ${plugin.manifest.id} 声明了入口 ${plugin.manifest.entry ?? '(未指定)'}，但代码沙箱尚未接入`);
}
