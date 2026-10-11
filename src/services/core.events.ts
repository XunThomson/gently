/**
 * 核心事件名（契约 §3）的**运行时常量表**。
 *
 * 契约里的对象是 `src/api/index.ts` 的 `CoreEventMap`（只有类型，运行时没有值），
 * 而订阅事件要传字符串；把字符串散在 `listen(...)` 的调用点上，拼错不会有任何编译错误，
 * 只会表现为「事件永远不来」。这个表让事件名有唯一定义处。
 *
 * **为什么事件名用冒号分段**：事件经过 Tauri 的事件系统送到前端，Tauri 只接受
 * 字母数字与 `-` `/` `:` `_`——点号会让 `emit`/`listen` 直接报错
 * （`only alphanumeric, '-', '/', ':', '_' permitted`），于是事件在桌面上整条丢失：
 * 流式搜索等不到 `catalog:search:done`（只能等超时）、下载进度永远不动。
 * 契约名与传输名保持同一字符串，避免「逻辑名 ↔ 传输名」的第二套映射。
 *
 * `satisfies` 是**完整性检查**：契约里新增/改名一个事件而这里没跟上，`tsc` 直接失败。
 */
import type {CoreEventName} from '../api';

export const CORE_EVENTS = {
    'catalog:search:partial': 'catalog:search:partial',
    'catalog:search:done': 'catalog:search:done',
    'download:progress': 'download:progress',
    'download:done': 'download:done',
    'download:error': 'download:error',
    'plugin:health': 'plugin:health',
    'plugin:import:progress': 'plugin:import:progress',
    'library:scan:progress': 'library:scan:progress',
} as const satisfies Record<CoreEventName, CoreEventName>;

/** 事件名允许的字符集（与 Tauri 的事件名校验、`core/src/events.rs` 的测试一致）。 */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9\-/:_]+$/;
