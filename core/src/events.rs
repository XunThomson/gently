//! 事件通道抽象。
//!
//! core 不知道 Tauri 的存在，因此推送（下载进度、扫描进度、搜索结果流）
//! 通过这个 trait 出去；`src-tauri` 用 Tauri 的事件系统实现它，
//! 测试与无头场景用 [`NullEventSink`]。

/// 事件名与载荷（载荷为已序列化的 JSON，事件清单见契约 §3）。
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// 丢弃全部事件：用于单元测试与「未接入 UI」的场景。
pub struct NullEventSink;

impl EventSink for NullEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        tracing::debug!(event, payload = %payload, "事件（未接入 sink，已丢弃）");
    }
}

/// 契约中的事件名（避免各处硬编码字符串拼错）。
///
/// **为什么是冒号而不是点号**：事件要经过 Tauri 的事件系统送到前端，而 Tauri 的
/// 事件名校验只接受字母数字与 `-` `/` `:` `_`——带点号的名字 `emit` 会直接返回错误
/// （`only alphanumeric, '-', '/', ':', '_' permitted`），于是**所有事件在桌面上静默丢失**：
/// 流式搜索等不到 `catalog:search:done`（只能等超时），下载进度永远不动。
/// 这里让契约名与传输名保持**同一个字符串**，不引入「逻辑名 ↔ 传输名」的第二套映射；
/// [`names_are_transport_safe`] 把这个约束钉在测试里。
pub mod events {
    pub const CATALOG_SEARCH_PARTIAL: &str = "catalog:search:partial";
    pub const CATALOG_SEARCH_DONE: &str = "catalog:search:done";
    pub const DOWNLOAD_PROGRESS: &str = "download:progress";
    pub const DOWNLOAD_DONE: &str = "download:done";
    pub const DOWNLOAD_ERROR: &str = "download:error";
    pub const PLUGIN_HEALTH: &str = "plugin:health";
    pub const PLUGIN_IMPORT_PROGRESS: &str = "plugin:import:progress";
    pub const LIBRARY_SCAN_PROGRESS: &str = "library:scan:progress";
    /// 第三方授权状态变化（`auth.begin` 之后回调线程换到令牌 / 被取消 / 失败）
    pub const AUTH_CHANGED: &str = "auth:changed";

    /// 契约中声明的事件总数（与 `scripts/check-commands.mjs` 的文档比对一致）。
    pub const ALL: &[&str] = &[
        CATALOG_SEARCH_PARTIAL,
        CATALOG_SEARCH_DONE,
        DOWNLOAD_PROGRESS,
        DOWNLOAD_DONE,
        DOWNLOAD_ERROR,
        PLUGIN_HEALTH,
        PLUGIN_IMPORT_PROGRESS,
        LIBRARY_SCAN_PROGRESS,
        AUTH_CHANGED,
    ];
}

#[cfg(test)]
mod tests {
    use super::events;

    /// Tauri 的事件名白名单（`tauri::event::is_event_name_valid` 的字符集）。
    fn transport_safe(name: &str) -> bool {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
    }

    /// 事件名是**跨进程 ABI**：一旦用了 Tauri 不接受的字符，事件会被整条丢掉，
    /// 而命令返回值仍然正常——症状是「搜索转圈到超时」「下载进度不动」这种极难定位的活锁。
    #[test]
    fn names_are_transport_safe() {
        for name in events::ALL {
            assert!(
                transport_safe(name),
                "事件名 {name:?} 含传输层不接受的字符（点号是大坑），请用冒号分段"
            );
        }
    }

    /// 事件清单没有重复项（重复通常来自复制粘贴新事件时忘了改字符串）。
    #[test]
    fn names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for name in events::ALL {
            assert!(seen.insert(*name), "事件名重复：{name}");
        }
    }
}
