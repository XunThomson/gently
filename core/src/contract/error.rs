//! 错误码与错误体。
//!
//! 约定：**业务只产生 `CoreError`，前端按 `code` 分支、不解析 `message`**。
//! 码字符串是跨语言契约（TS 侧见 `src/api/index.ts` 的 `CORE_ERROR_CODES`），
//! 因此每个码都有测试锁定，改名等于破坏契约。

use serde::{Serialize, Serializer};
use thiserror::Error;

/// 机器可读错误码（契约 §1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Error)]
pub enum ErrorCode {
    // ---- 通用 ----
    #[error("参数非法")]
    InvalidArgument,
    #[error("资源不存在")]
    NotFound,
    #[error("并发写冲突")]
    Conflict,
    #[error("已取消")]
    Cancelled,
    #[error("当前平台不支持")]
    UnsupportedPlatform,
    #[error("尚未实现")]
    NotImplemented,
    #[error("内部错误")]
    Internal,

    // ---- 插件 ----
    #[error("插件源文件非法")]
    PluginInvalidSource,
    #[error("插件清单非法")]
    PluginInvalidManifest,
    #[error("插件 id 重复")]
    PluginDuplicateId,
    #[error("插件导入失败")]
    PluginImportFailed,
    #[error("插件请求了未声明的能力")]
    PluginPermissionDenied,
    #[error("缺少插件凭据")]
    PluginCredentialMissing,
    #[error("插件运行时错误")]
    PluginRuntimeError,

    // ---- 订阅 ----
    #[error("订阅索引拉取失败")]
    SubscriptionFetchFailed,
    #[error("订阅索引结构非法")]
    SubscriptionInvalidIndex,

    // ---- 音源 ----
    #[error("上游音源失败")]
    SourceUpstreamFailed,
    #[error("第三方登录态失效")]
    SourceAuthExpired,

    // ---- 播放与媒体 ----
    #[error("没有可用音源")]
    PlaybackNoSource,
    #[error("媒体代理失败")]
    MediaProxyFailed,
    #[error("媒体地址被拒绝")]
    MediaBlockedAddress,

    // ---- 本地库 / 下载 / 皮肤 ----
    #[error("本地读写失败")]
    LibraryIoError,
    #[error("扫描失败")]
    LibraryScanFailed,
    #[error("磁盘空间不足")]
    DownloadDiskFull,
    #[error("皮肤文档非法")]
    SkinInvalidDocument,
    #[error("皮肤包含未允许的令牌键名")]
    SkinTokenRejected,
}

impl ErrorCode {
    /// 契约字符串（**跨语言 ABI**，改动需同步 TS 与文档）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "common.invalid_argument",
            Self::NotFound => "common.not_found",
            Self::Conflict => "common.conflict",
            Self::Cancelled => "common.cancelled",
            Self::UnsupportedPlatform => "common.unsupported_platform",
            Self::NotImplemented => "common.not_implemented",
            Self::Internal => "common.internal",
            Self::PluginInvalidSource => "plugin.invalid_source",
            Self::PluginInvalidManifest => "plugin.invalid_manifest",
            Self::PluginDuplicateId => "plugin.duplicate_id",
            Self::PluginImportFailed => "plugin.import_failed",
            Self::PluginPermissionDenied => "plugin.permission_denied",
            Self::PluginCredentialMissing => "plugin.credential_missing",
            Self::PluginRuntimeError => "plugin.runtime_error",
            Self::SubscriptionFetchFailed => "subscription.fetch_failed",
            Self::SubscriptionInvalidIndex => "subscription.invalid_index",
            Self::SourceUpstreamFailed => "source.upstream_failed",
            Self::SourceAuthExpired => "source.auth_expired",
            Self::PlaybackNoSource => "playback.no_source",
            Self::MediaProxyFailed => "media.proxy_failed",
            Self::MediaBlockedAddress => "media.blocked_address",
            Self::LibraryIoError => "library.io_error",
            Self::LibraryScanFailed => "library.scan_failed",
            Self::DownloadDiskFull => "download.disk_full",
            Self::SkinInvalidDocument => "skin.invalid_document",
            Self::SkinTokenRejected => "skin.token_rejected",
        }
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// 结构化错误：`code` 决定前端行为，`message` 只给开发者看。
#[derive(Debug, Clone, Serialize, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: None }
    }

    /// 附带结构化细节（如校验 issues、被拒的令牌键名、插件权限清单）。
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// 契约已定、实现未接入：灰度期的标准响应。
    pub fn not_implemented(command: &str) -> Self {
        Self::new(
            ErrorCode::NotImplemented,
            format!("命令 {command} 已在契约中登记，业务实现尚未接入"),
        )
        .with_details(serde_json::json!({ "command": command }))
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn unsupported_platform(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UnsupportedPlatform, message)
    }
}

/// `rusqlite` 错误统一映射为 `library.io_error`（本地读写）并保留原因。
impl From<rusqlite::Error> for CoreError {
    fn from(err: rusqlite::Error) -> Self {
        Self::new(ErrorCode::LibraryIoError, format!("SQLite 错误：{err}"))
    }
}

/// 文件系统错误同样归入本地读写。
impl From<std::io::Error> for CoreError {
    fn from(err: std::io::Error) -> Self {
        Self::new(ErrorCode::LibraryIoError, format!("IO 错误：{err}"))
    }
}
