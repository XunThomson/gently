/**
 * 本机核心桥接：**全应用唯一允许调用 Tauri IPC 的地方**（AGENTS 约束 13）。
 *
 * 职责：
 * - 用唯一的入口命令 `core_invoke` 承载契约里的 57 条命令（Tauri 命令名无法表达
 *   `plugin.import` 这种点号名，因此核心侧做了统一分发，见 `core/src/commands.rs`）；
 * - 把「永不抛异常」的信封语义落到前端：调用方永远拿到 `CoreResult<T>`，
 *   IPC reject（版本不匹配、反序列化失败）统一归为 `common.internal`；
 * - 浏览器（`pnpm dev` 无 Tauri）下返回 `available: false` 的事实，
 *   由 `services/**` 退回 mock —— **前端必须始终能在浏览器里跑**。
 *
 * UI / store 不得直接 `invoke`，一律经此层或基于它的 service。
 */

import type {
    CoreError,
    CoreErrorCode,
    CoreResult,
    ImportSource,
    PluginImportPreview,
    PluginImportResult,
    PluginSummary,
    SystemPathsDto,
    SystemStatusDto,
} from '../api';
import {isTauri} from './window.service';

/** Tauri 侧唯一注册的命令名 */
const ENTRY = 'core_invoke';

/** 是否运行在 Tauri 宿主里（浏览器为 false，此时所有命令都不可用）。 */
export const coreAvailable = (): boolean => isTauri();

function fail(code: CoreErrorCode, message: string, traceId = 'client'): CoreResult<never> {
    return {ok: false, error: {code, message}, traceId};
}

/**
 * 调用一条契约命令。
 *
 * @param command 契约名，如 `system.status`（见 `docs/contracts/local-core-api.md`）
 * @param params 命令参数对象（缺省为空对象）
 */
export async function invokeCore<T>(
    command: string,
    params: Record<string, unknown> = {},
): Promise<CoreResult<T>> {
    if (!coreAvailable()) {
        return fail('common.unsupported_platform', '当前不在桌面宿主中，浏览器预览使用 mock 数据');
    }

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const result = await invoke<CoreResult<T>>(ENTRY, {command, params});

        // 核心保证返回信封；这里再挡一次，避免调用方拿到 undefined 才炸（版本不匹配时会发生）
        if (result && typeof result === 'object' && 'ok' in result) {
            return result;
        }
        return fail('common.internal', `命令 ${command} 未返回契约信封`);
    } catch (err) {
        return fail('common.internal', err instanceof Error ? err.message : String(err));
    }
}

/**
 * M0 已实现的 system 域。
 *
 * 其余域（catalog / library / plugin / …）在对应里程碑接入时在此追加，
 * 保持「一个域一个命名空间」与契约分组一致。
 */
export const coreSystem = {
    status: () => invokeCore<SystemStatusDto>('system.status'),
    paths: () => invokeCore<SystemPathsDto>('system.paths'),
    reveal: (path: string) => invokeCore<null>('system.reveal', {path}),
};

let probed: Promise<CoreResult<SystemStatusDto>> | null = null;

/**
 * 启动时探测一次本机核心，结果**进程内缓存**。
 *
 * 用途：UI 需要尽早知道「这是桌面宿主还是浏览器预览」——决定是否显示依赖核心的能力
 * （插件导入、本地库、下载等），诊断页也直接复用这次结果，避免打开设置时再等一次往返。
 * 探测失败不抛异常（信封语义），调用方按 `ok` 分支即可。
 */
export function probeCore(): Promise<CoreResult<SystemStatusDto>> {
    probed ??= coreSystem.status();
    return probed;
}

/**
 * 插件域（M1 已接入的部分）。
 *
 * 注意：**安装必须带 consent: true**，核心用它当硬门槛；界面因此一定要先 preview
 * 把权限与凭据需求展示给用户，拿到显式勾选后再调用 install。
 */
export const corePlugin = {
    list: () => invokeCore<PluginSummary[]>('plugin.list'),
    /** 只读检查：读取并解析插件，展示权限/凭据/警告，**不落盘** */
    preview: (from: ImportSource) => invokeCore<PluginImportPreview>('plugin.preview', {from}),
    /** 落盘安装；consent: true 表示用户已确认权限 */
    install: (from: ImportSource) => invokeCore<PluginImportResult>('plugin.import', {from, consent: true}),
    /** 建立运行时并重新探测能力（安装只落盘，真正可用发生在这里） */
    reload: (id: string) => invokeCore<PluginSummary>('plugin.reload', {id}),
    setEnabled: (id: string, enabled: boolean) =>
        invokeCore<PluginSummary>('plugin.setEnabled', {id, enabled}),
    /** 回退优先级：数值越小越优先（决定播放候选顺序） */
    setPriority: (id: string, priority: number) => invokeCore<null>('plugin.setPriority', {id, priority}),
    /** 卸载；`deleteFiles` 缺省为 true（核心侧默认连文件一起删） */
    remove: (id: string, deleteFiles = true) => invokeCore<null>('plugin.remove', {id, deleteFiles}),
};

/** 供设置页展示的错误文案（不再区分错误码，直接给开发者说明）。 */
export const describeError = (error: CoreError): string => error.message;
