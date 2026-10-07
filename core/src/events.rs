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
pub mod events {
    pub const CATALOG_SEARCH_PARTIAL: &str = "catalog.search.partial";
    pub const CATALOG_SEARCH_DONE: &str = "catalog.search.done";
    pub const DOWNLOAD_PROGRESS: &str = "download.progress";
    pub const DOWNLOAD_DONE: &str = "download.done";
    pub const DOWNLOAD_ERROR: &str = "download.error";
    pub const PLUGIN_HEALTH: &str = "plugin.health";
    pub const PLUGIN_IMPORT_PROGRESS: &str = "plugin.import.progress";
    pub const LIBRARY_SCAN_PROGRESS: &str = "library.scan.progress";

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
    ];
}
