//! 命令清单（契约 §2）——Rust 侧的权威列表。
//!
//! 为什么要有这份常量：Tauri 的 `generate_handler!` 是宏，无法从中反查注册了哪些命令。
//! 把清单固定在这里，就能做两级守卫：
//!  1. `scripts/check-commands.mjs` 比对**本文档 ↔ 本清单**；
//!  2. `src-tauri` 的测试比对**本清单 ↔ 实际注册表**。
//! 任何一侧漏登记都会让 CI 失败，而不是等到前端调用时才发现。

/// 契约中的全部命令名（`域.动作[.子动作]`）。
pub const COMMAND_NAMES: &[&str] = &[
    // system（3）——M0 真实实现
    "system.status",
    "system.paths",
    "system.reveal",
    // plugin：管理（13）
    "plugin.list",
    "plugin.preview",
    "plugin.import",
    "plugin.remove",
    "plugin.setEnabled",
    "plugin.setPriority",
    "plugin.reload",
    "plugin.checkUpdate",
    "plugin.config.get",
    "plugin.config.put",
    "plugin.credentials.set",
    "plugin.credentials.clear",
    "plugin.credentials.status",
    // plugin：兼容模式收敛（2）
    // 兼容插件没有域名声明，只能靠观测；确认后固化为 hosts 白名单并关掉兼容模式（ADR-0006）
    "plugin.compat.observed",
    "plugin.compat.confirm",
    // plugin：订阅与仓库（5）
    "plugin.subscriptions.list",
    "plugin.subscriptions.add",
    "plugin.subscriptions.remove",
    "plugin.subscriptions.refresh",
    "plugin.catalog.list",
    // catalog（9）
    "catalog.search",
    "catalog.searchCancel",
    "catalog.track",
    "catalog.album",
    "catalog.playlist",
    "catalog.topLists",
    "catalog.topList",
    "catalog.recommend",
    "catalog.lyrics",
    // library（10）
    "library.favorites.list",
    "library.favorites.set",
    "library.playlists.list",
    "library.playlists.save",
    "library.playlists.delete",
    "library.history.list",
    "library.history.push",
    "library.history.clear",
    "library.local.scan",
    "library.local.list",
    "library.local.remove",
    // recommend（3）
    "recommend.home",
    "recommend.similar",
    "recommend.feedback",
    // playback（2）
    "playback.resolve",
    "playback.report",
    // download（6）
    "download.list",
    "download.create",
    "download.pause",
    "download.resume",
    "download.remove",
    "download.clearFinished",
    // skin（6）
    "skin.list",
    "skin.preview",
    "skin.install",
    "skin.remove",
    "skin.setActive",
    "skin.export",
];

/// 契约中声明的命令总数（契约文档里写「约 57 条」，这里是精确值）。
pub const fn command_count() -> usize {
    COMMAND_NAMES.len()
}

/// 是否为契约内的命令；用于避免前端调用未登记的命令名。
pub fn is_known_command(name: &str) -> bool {
    COMMAND_NAMES.contains(&name)
}
