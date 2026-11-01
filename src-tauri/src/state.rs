//! 应用状态与事件出口。
//!
//! `AppState` 持有两个**互不依赖**的引擎句柄（ADR 0010）：
//! - `core`：音乐数据处理引擎（`gently-core`）；
//! - `pet`：宠物核心引擎（`pet-core`，自己的库、自己的命令入口）。
//!
//! 命令处理被 `spawn_blocking` 移到阻塞线程池（两边都是同步的 SQLite/文件操作），
//! 因此需要可 `'static` 移动的句柄；宠物引擎用 `Mutex` 串行化（`tick` 是有状态的）。

use std::sync::{Arc, Mutex};

use gently_core::commands::CoreContext;
use gently_core::events::EventSink;
use pet_core::Engine as PetEngine;

/// 把 core 的事件转发到前端（事件清单见契约 §3）。
pub struct TauriEventSink {
    app: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        // 事件失败不影响命令结果：UI 只依赖事件做增量更新，丢一次会由后续请求补齐
        if let Err(err) = self.app.emit(event, payload) {
            tracing::warn!(event, %err, "事件推送失败");
        }
    }
}

pub struct AppState {
    pub core: Arc<CoreContext>,
    /// 宠物核心：独立引擎、独立库（`<data>/pet/pet.db`），不经过音乐核心
    pub pet: Arc<Mutex<PetEngine>>,
    /// 日志写线程的 guard：**必须活到进程结束**（drop 时会把队列里剩下的日志刷完）。
    /// 不放进这里的话它在 `setup` 结束时就被丢掉了，日志文件会停在启动那一刻。
    pub _log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}
