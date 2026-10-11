//! 对外契约：信封、错误码、命令清单、DTO。
//!
//! 这里是 Rust 侧的**权威定义**，与 `docs/contracts/local-core-api.md` 保持一致；
//! 二者的一致性由 `scripts/check-commands.mjs`（命令清单）与
//! `tests/contract.rs`（错误码字符串）双向守卫。

mod commands;
mod error;
mod import;
mod result;
mod system;

pub use commands::{command_count, is_known_command, COMMAND_NAMES};
pub use error::{CoreError, ErrorCode};
pub use import::ImportSource;
pub use result::{new_trace_id, CoreResult};
pub use system::{SystemCounts, SystemPaths, SystemStatus};

/// 命令**实现**的返回类型：`Result` 可以直接用 `?`，
/// 由 [`dispatch`](crate::commands::dispatch) 在边界转成 [`CoreResult`] 信封。
pub type Fallible<T> = Result<T, CoreError>;
