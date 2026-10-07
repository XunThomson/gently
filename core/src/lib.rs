//! gently 本机核心。
//!
//! 这里的代码**不依赖 tauri**，因此可以用 `cargo test -p gently-core` 快速迭代；
//! `src-tauri` 只负责把这些能力暴露成 Tauri 命令与事件。
//!
//! 模块边界：
//! - [`contract`]：对外契约（信封、错误码、命令清单、DTO）——与
//!   `docs/contracts/local-core-api.md` 一一对应；
//! - [`commands`]：命令分发（契约名 → 处理器）；M0 只有 system 域实现；
//! - [`events`]：事件通道抽象（Tauri 实现在 `src-tauri`）；
//! - [`paths`]：本机数据目录布局；
//! - [`store`]：SQLite 访问层与迁移（ADR-0004）；
//! - [`logging`]：tracing 初始化。

pub mod commands;
pub mod contract;
pub mod events;
pub mod logging;
pub mod paths;
pub mod store;

pub use commands::{dispatch, CoreContext};
pub use contract::{CoreError, CoreResult, ErrorCode};
pub use paths::AppPaths;
pub use store::Store;

/// 核心版本（与 Cargo.toml 一致）。
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
