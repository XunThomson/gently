//! system 域的 DTO。
//!
//! 字段名用 camelCase（与 TS 契约一致）；数值型计数在 M0 恒为 0——
//! 业务表随 M3 落地，这里不假装有数据。

use serde::Serialize;

/// `system.status` 的返回体。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    /// 核心版本（crate 版本号）
    pub version: String,
    /// 运行平台，如 `windows-x86_64`
    pub platform: String,
    /// SQLite 文件路径（打不开时为空串）
    pub db_path: String,
    /// 数据根目录
    pub data_dir: String,
    /// 插件运行时：M0 为 `none`，M1 接入 QuickJS 后为 `quickjs`
    pub plugin_runtime: String,
    /// 数据库是否可用（打不开时前端显示降级提示）
    pub db_ready: bool,
    /// 数据库不可用时的原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_error: Option<String>,
    /// 第三方凭据的落点：`windows-credential-manager` / `memory`（降级）。
    /// 界面据此说明「重启后是否还要重新填写」——不猜，如实报。
    pub credentials_backend: String,
    pub counts: SystemCounts,
}

/// 各域条目数（M0 恒为 0：业务表尚未落地）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCounts {
    pub plugins: i64,
    pub favorites: i64,
    pub tracks: i64,
    pub downloads: i64,
}

/// `system.paths` 的返回体：设置页「诊断」用于展示与一键打开目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPaths {
    pub data: String,
    pub cache: String,
    pub plugins: String,
    pub subscriptions: String,
    pub skins: String,
    pub downloads: String,
    pub logs: String,
}
