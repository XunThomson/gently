//! 命令分发：契约里的命令名 → 处理器。
//!
//! **为什么用单一分发入口而不是 57 个 `#[tauri::command]`**：
//! Tauri 的命令名取自 Rust 函数名，无法表达 `plugin.import` 这种带点的名字，
//! 而契约里的名字是跨语言 ABI（前端、文档、测试都以它为准）。因此：
//!
//! - 对外只注册一个 Tauri 命令（`core_invoke`），参数是 `{command, params}`；
//! - core 内用 `match command` 路由，契约名**原样使用**，不做大小写/下划线转换；
//! - 「已登记但未实现」返回 `common.not_implemented`，与「名字未登记」的
//!   `common.not_found` 区分开——后者是 bug（前端打错或契约漏登记），
//!   `tests/dispatch.rs` 会遍历契约清单确保不会出现。
//!
//! 实现层统一返回 [`Fallible`]（`Result<_, CoreError>`，可直接 `?`），
//! 由 [`dispatch`] 在边界转成信封。
//!
//! M0 只有 system 域是真实实现，其余返回 `not_implemented`。

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::contract::{
    command_count, is_known_command, CoreError, CoreResult, ErrorCode, Fallible, SystemCounts,
    SystemStatus, COMMAND_NAMES,
};
use crate::events::{EventSink, NullEventSink};
use crate::paths::AppPaths;
use crate::store::Store;

/// 处理器运行时上下文（由 `src-tauri` 在启动时构造一次）。
pub struct CoreContext {
    pub paths: AppPaths,
    /// 数据库不可用时为 `None`：应用仍要能启动（诊断页会显示原因）。
    pub store: Option<Store>,
    pub store_error: Option<String>,
    /// 插件运行时名：M0 为 `none`，M1 接入 QuickJS 后为 `quickjs`。
    pub plugin_runtime: &'static str,
    pub events: Arc<dyn EventSink>,
}

impl CoreContext {
    pub fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            store: None,
            store_error: None,
            plugin_runtime: "none",
            events: Arc::new(NullEventSink),
        }
    }

    pub fn with_events(mut self, events: Arc<dyn EventSink>) -> Self {
        self.events = events;
        self
    }

    pub fn with_store(mut self, store: Store) -> Self {
        self.store = Some(store);
        self.store_error = None;
        self
    }

    pub fn with_store_error(mut self, error: impl Into<String>) -> Self {
        self.store = None;
        self.store_error = Some(error.into());
        self
    }
}

/// 路由一条命令。`params` 缺失时按空对象处理。
pub fn dispatch(
    ctx: &CoreContext,
    command: &str,
    params: serde_json::Value,
) -> CoreResult<serde_json::Value> {
    // 未登记的名字是 bug 而不是「未实现」，两者必须可区分
    if !is_known_command(command) {
        return CoreResult::from_error(
            CoreError::not_found(format!("命令未在契约中登记：{command}")).with_details(
                serde_json::json!({ "command": command, "knownCount": command_count() }),
            ),
        );
    }

    let outcome: Fallible<serde_json::Value> = match command {
        "system.status" => to_json(system_status(ctx)),
        "system.paths" => to_json(ctx.paths.to_dto()),
        "system.reveal" => reveal(ctx, params),
        // 其余命令：契约已登记，实现在后续里程碑接入
        other => Err(CoreError::not_implemented(other)),
    };

    CoreResult::from(outcome)
}

/// M0 已实现的命令（诊断用）。
const IMPLEMENTED: &[&str] = &["system.status", "system.paths", "system.reveal"];

/// 已实现命令数。
pub fn implemented_count() -> usize {
    COMMAND_NAMES.iter().filter(|name| IMPLEMENTED.contains(name)).count()
}

/// 该命令是否已实现（未实现时前端可隐藏入口）。
pub fn is_implemented(command: &str) -> bool {
    IMPLEMENTED.contains(&command)
}

// ---------------------------------------------------------------- system 域

#[derive(Debug, serde::Deserialize)]
struct RevealParams {
    path: String,
}

fn system_status(ctx: &CoreContext) -> SystemStatus {
    SystemStatus {
        version: crate::CORE_VERSION.to_string(),
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        db_path: slash(&ctx.paths.db),
        data_dir: slash(&ctx.paths.data),
        plugin_runtime: ctx.plugin_runtime.to_string(),
        db_ready: ctx.store.is_some(),
        db_error: ctx.store_error.clone(),
        counts: SystemCounts {
            // 插件数在 M1 由插件宿主提供；M0 没有宿主
            plugins: 0,
            favorites: ctx.store.as_ref().map_or(0, |s| s.count_or_zero("favorites")),
            tracks: ctx.store.as_ref().map_or(0, |s| s.count_or_zero("local_tracks")),
            downloads: ctx.store.as_ref().map_or(0, |s| s.count_or_zero("downloads_tasks")),
        },
    }
}

fn reveal(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: RevealParams = parse_params(params)?;
    reveal_in_file_manager(ctx, &params.path)?;
    Ok(serde_json::Value::Null)
}

/// 在系统文件管理器中定位/打开路径。
///
/// **安全约束**：只允许应用自己的受管目录，避免前端传入任意路径把它变成
/// 「打开任意文件」的入口（`AppPaths::is_managed` 已按规范化路径做前缀校验）。
fn reveal_in_file_manager(ctx: &CoreContext, raw: &str) -> Fallible<()> {
    let candidate = std::path::PathBuf::from(raw);
    if !ctx.paths.is_managed(&candidate) {
        return Err(CoreError::new(
            ErrorCode::InvalidArgument,
            "只允许打开应用自己的目录（data/cache/plugins/subscriptions/skins/downloads/logs）",
        )
        .with_details(serde_json::json!({ "path": raw })));
    }
    if !candidate.exists() {
        return Err(CoreError::not_found(format!("路径不存在：{raw}")));
    }

    platform_reveal(&candidate)
        .map_err(|err| CoreError::internal(format!("打开文件管理器失败：{err}")))
}

#[cfg(target_os = "windows")]
fn platform_reveal(path: &std::path::Path) -> std::io::Result<()> {
    use std::process::Command;
    // 目录直接打开；文件用 /select 在父目录里高亮
    if path.is_dir() {
        Command::new("explorer").arg(path).spawn()?;
    } else {
        Command::new("explorer").arg(format!("/select,{}", path.display())).spawn()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_reveal(path: &std::path::Path) -> std::io::Result<()> {
    use std::process::Command;
    Command::new("open").arg("-R").arg(path).spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_reveal(path: &std::path::Path) -> std::io::Result<()> {
    use std::process::Command;
    // xdg-open 只接受目录语义，落到父目录
    let target = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    Command::new("xdg-open").arg(target).spawn()?;
    Ok(())
}

// ---------------------------------------------------------------- 工具

/// 解析命令参数；失败时把 serde 的原因放进 `details`，便于前端定位字段。
pub fn parse_params<T: DeserializeOwned>(params: serde_json::Value) -> Fallible<T> {
    serde_json::from_value(params).map_err(|err| {
        CoreError::invalid_argument(format!("参数解析失败：{err}"))
            .with_details(serde_json::json!({ "reason": err.to_string() }))
    })
}

fn to_json<T: Serialize>(value: T) -> Fallible<serde_json::Value> {
    serde_json::to_value(value).map_err(|err| CoreError::internal(format!("序列化失败：{err}")))
}

fn slash(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
