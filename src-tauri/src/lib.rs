//! Tauri 适配层：**只做三件事**——建状态、暴露唯一入口命令、把事件接出去。
//!
//! 业务逻辑一律在 `gently-core`（不依赖 tauri，可 `cargo test` 快速迭代）。
//!
//! 关于「一个命令 vs 57 个命令」：Tauri 的命令名取自 Rust 函数名，
//! 无法表达契约里的 `plugin.import` 这种点号名字，而契约名是跨语言 ABI。
//! 因此这里只注册 `core_invoke`，由 core 按契约名路由（见 `core/src/commands.rs`）。

pub mod state;

use std::sync::Arc;

use gently_core::{logging, AppPaths, CoreContext, Store};
use tauri::Manager;

use crate::state::{AppState, TauriEventSink};

/// 唯一入口：`invoke('core_invoke', { command, params })`。
///
/// - 参数名用单词（`command` / `params`），避开 Tauri 的大小写转换规则；
/// - 处理放到阻塞线程池：core 里是同步的 SQLite/文件操作，不应占用异步运行时；
/// - 返回值始终是契约信封（`{ok,data|error,traceId}`），只有序列化失败才会 reject——
///   前端桥接层把 reject 归为 `common.internal`。
#[tauri::command]
async fn core_invoke(
    state: tauri::State<'_, AppState>,
    command: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let core = Arc::clone(&state.core);
    let params = params.unwrap_or_else(|| serde_json::Value::Object(Default::default()));

    let result = tauri::async_runtime::spawn_blocking(move || gently_core::dispatch(&core, &command, params))
        .await
        .map_err(|err| format!("命令执行被中止：{err}"))?;

    envelope_to_json(result)
}

/// 把 `CoreResult` 序列化成信封；序列化失败（理论上不会）兜底成 internal 错误。
fn envelope_to_json<T: serde::Serialize>(result: gently_core::CoreResult<T>) -> Result<serde_json::Value, String> {
    if let Ok(value) = serde_json::to_value(&result) {
        return Ok(value);
    }
    serde_json::to_value(gently_core::CoreResult::<()>::from_error(
        gently_core::CoreError::internal("信封序列化失败"),
    ))
    .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            logging::init(&std::env::var("GENTLY_LOG").unwrap_or_else(|_| "info".into())).ok();

            // 数据目录：拿不到就用临时目录兜底，保证应用能起来（诊断页会显示真实路径）
            let paths = match app.path().app_data_dir() {
                Ok(base) => AppPaths::resolve(base),
                Err(err) => {
                    tracing::error!(%err, "无法获取应用数据目录，回退到临时目录");
                    AppPaths::resolve(std::env::temp_dir().join("gently"))
                }
            };
            if let Err(err) = paths.ensure() {
                tracing::warn!(%err, dir = %paths.data.display(), "创建数据目录失败");
            }

            let sink = Arc::new(TauriEventSink::new(app.handle().clone()));
            let mut core = CoreContext::new(paths).with_events(sink);

            // 数据库打不开时不阻塞启动：核心能力降级，诊断页显示原因
            let db_path = core.paths.db.clone();
            core = match Store::open(&db_path) {
                Ok(store) => {
                    tracing::info!(db = %db_path.display(), version = store.schema_version(), "数据库就绪");
                    core.with_store(store)
                }
                Err(err) => {
                    tracing::error!(%err, db = %db_path.display(), "数据库打开失败，进入降级模式");
                    core.with_store_error(err.message)
                }
            };

            app.manage(AppState { core: Arc::new(core) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![core_invoke])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
