//! 宠物核心的错误与码表。
//!
//! **不复用**音乐核心的 `ErrorCode`：那是它自己的跨语言 ABI（`common.*` / `plugin.*` / …）。
//! 宠物是另一套领域，码表也应该是自己的（`pet.*`）；宿主把两边都映射成同一个信封形状
//! （`{ok, data|error, traceId}`）即可，前端不需要为宠物再写一套错误处理分支。

use serde::Serialize;

/// 宠物域错误码（跨语言契约，改动等于破坏兼容）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, thiserror::Error)]
pub enum PetErrorCode {
    #[error("参数非法")]
    #[serde(rename = "pet.invalid_argument")]
    InvalidArgument,
    #[error("找不到这个宠物")]
    #[serde(rename = "pet.not_found")]
    NotFound,
    #[error("宠物包非法")]
    #[serde(rename = "pet.invalid_package")]
    InvalidPackage,
    /// 包与当前核心不兼容（例如它要求更新的宠物核心）
    #[error("宠物包与当前核心不兼容")]
    #[serde(rename = "pet.incompatible")]
    Incompatible,
    #[error("超出限制")]
    #[serde(rename = "pet.limit_exceeded")]
    LimitExceeded,
    #[error("本地读写失败")]
    #[serde(rename = "pet.io_error")]
    IoError,
    #[error("内部错误")]
    #[serde(rename = "pet.internal")]
    Internal,
}

impl PetErrorCode {
    /// 契约字符串（跨语言 ABI）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "pet.invalid_argument",
            Self::NotFound => "pet.not_found",
            Self::InvalidPackage => "pet.invalid_package",
            Self::Incompatible => "pet.incompatible",
            Self::LimitExceeded => "pet.limit_exceeded",
            Self::IoError => "pet.io_error",
            Self::Internal => "pet.internal",
        }
    }
}

/// 结构化错误：`code` 决定调用方行为，`message` 只给开发者看。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct PetError {
    pub code: PetErrorCode,
    pub message: String,
}

impl PetError {
    pub fn new(code: PetErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::InvalidArgument, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::NotFound, message)
    }

    pub fn invalid_package(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::InvalidPackage, message)
    }

    pub fn incompatible(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::Incompatible, message)
    }

    pub fn limit_exceeded(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::LimitExceeded, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::Internal, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(PetErrorCode::IoError, message)
    }
}

impl From<std::io::Error> for PetError {
    fn from(err: std::io::Error) -> Self {
        PetError::io(format!("IO 错误：{err}"))
    }
}

impl From<rusqlite::Error> for PetError {
    fn from(err: rusqlite::Error) -> Self {
        PetError::new(PetErrorCode::IoError, format!("SQLite 错误：{err}"))
    }
}

impl From<serde_json::Error> for PetError {
    fn from(err: serde_json::Error) -> Self {
        PetError::new(PetErrorCode::InvalidPackage, format!("JSON 解析失败：{err}"))
    }
}

/// 宠物域的返回类型（M1 的宿主适配层把它包成信封）。
pub type PetResult<T> = Result<T, PetError>;


