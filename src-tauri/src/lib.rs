//! Tauri 适配层：**只做三件事**——建状态、暴露唯一入口命令、把事件接出去。
//!
//! 业务逻辑一律在核心 crate 里（都不依赖 tauri，可 `cargo test` 快速迭代）。
//! 现在有**两个引擎**（ADR 0010）：`gently-core`（音乐数据）与 `pet-core`（宠物），
//! 互不依赖；本层各暴露一个入口命令，UI 是可替换的宿主。
//!
//! 关于「一个命令 vs N 个命令」：Tauri 的命令名取自 Rust 函数名，
//! 无法表达契约里的 `plugin.import` 这种点号名字，而契约名是跨语言 ABI。
//! 因此每个引擎只注册**一个**入口命令，由核心按契约名路由：
//! `core_invoke` → `gently_core::dispatch`，`pet_invoke` → `pet_core::dispatch`。

pub mod importer;
pub mod pet_watch;
pub mod playback;
pub mod state;
pub mod web_login;

use std::sync::{Arc, Mutex};

use gently_core::{logging, CoreContext, Store};
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

/// 宠物域唯一入口：`invoke('pet_invoke', { command, params })`。
///
/// 与 `core_invoke` 并列，**不是**它的分支：两个引擎各自一个入口，
/// 路由都在各自的 crate 里（`pet_core::dispatch`）。时间在这里取（宿主职责），
/// 核心因此不需要读时钟——测试传固定值就能复现。
#[tauri::command]
async fn pet_invoke(
    state: tauri::State<'_, AppState>,
    command: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let pet = Arc::clone(&state.pet);
    let params = params.unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let now_ms = now_ms();

    tauri::async_runtime::spawn_blocking(move || {
        let mut engine = pet.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pet_envelope(pet_core::dispatch(&mut engine, &command, params, now_ms))
    })
    .await
    .map_err(|err| format!("宠物命令执行被中止：{err}"))
}

/// 宠物域信封（与音乐核心**同一形状**，但错误码是宠物域自己的 `pet.*`）。
fn pet_envelope(result: pet_core::PetResult<serde_json::Value>) -> serde_json::Value {
    let trace_id = format!("pet-{}", now_ms());
    match result {
        Ok(data) => serde_json::json!({ "ok": true, "data": data, "traceId": trace_id }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": { "code": error.code.as_str(), "message": error.message },
            "traceId": trace_id,
        }),
    }
}

/// 当前毫秒时间戳（宿主提供时间，核心不读时钟）。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
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

/// 宿主命令：**重启应用**（数据目录迁移后由设置页调用）。
///
/// 为什么必须在宿主侧：核心不认识「进程」，重启只能由 Tauri 发起；
/// `request_restart` 会走正常的退出流程（把库关好、日志 flush），比 `std::process::exit` 安全。
#[tauri::command]
fn app_restart(app: tauri::AppHandle) {
    app.request_restart();
}

/// 宿主命令：**同步播放通知 / 前台服务 / 通知栏歌词**（Android，P2 / P4）。
///
/// 前端只在「开始 / 暂停 / 换歌 / **换歌词行**」时调一次（`services/playbackBanner.service.ts`），
/// 不是每秒调用——播放位置不归 Kotlin 管，播放状态仍以前端 store 为唯一权威。
/// 桌面端与浏览器里这条命令要么不存在、要么是空操作，前端只在手机宿主上调用。
#[tauri::command]
fn playback_banner(
    active: bool,
    title: String,
    artist: String,
    playing: bool,
    line: String,
) -> Result<(), String> {
    playback::update(active, &title, &artist, playing, &line)
}

/// 宿主命令：**从手机导入音频**（Android，P3）。
///
/// 调 Kotlin 的 SAF 选择器，选中的文件被拷进应用私有目录，返回
/// `{imported, failed, cancelled, dir}`；前端拿到 `dir` 之后用核心的
/// `library.local.scan` 入库（核心只做「给目录、扫出入库」）。
/// 这是**用户动作**触发的：不点按钮不会弹任何系统界面。
#[tauri::command]
async fn import_audio() -> Result<importer::ImportOutcome, String> {
    importer::pick_audio().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        /* 播放通知插件：Android 注册 Kotlin 侧 PlaybackPlugin（前台服务保活），
           其它平台是空插件——桌面端因此不需要任何 cfg 分支 */
        .plugin(playback::plugin())
        /* 导入插件：Android 注册 Kotlin 侧 ImportPlugin（SAF 选文件），其它平台是空插件 */
        .plugin(importer::plugin())
        .setup(|app| {
            /* 数据目录：三种来源按优先级裁决（`paths::resolve_data_paths`）——
               环境变量 > 迁移指针 > 便携版（exe 同目录有 `portable.txt`）> 系统默认。
               拿不到默认位置就用临时目录兜底，保证应用能起来（诊断页会显示真实路径）。 */
            let default_base = match app.path().app_data_dir() {
                Ok(base) => base,
                Err(err) => {
                    // 日志还没初始化，只能先用 stderr
                    eprintln!("无法获取应用数据目录，回退到临时目录：{err}");
                    std::env::temp_dir().join("gently")
                }
            };
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()));
            let env_override = std::env::var("GENTLY_DATA_DIR").ok();
            let (paths, source) = gently_core::paths::resolve_data_paths(
                &default_base,
                exe_dir.as_deref(),
                env_override.as_deref(),
            );
            eprintln!("数据目录：{}（来源 {source:?}）", paths.data.display());
            if let Err(err) = paths.ensure() {
                eprintln!("创建数据目录失败：{err}");
            }

            // 日志：控制台 + 按天落盘（`<data>/logs/`，保留 7 天）。guard 必须活到进程结束，
            // 否则后台写线程会被提前丢弃——因此挂到 AppState 里。
            let log_guard =
                logging::init(&std::env::var("GENTLY_LOG").unwrap_or_else(|_| "info".into()), Some(&paths.logs))
                    .ok()
                    .flatten();
            if let Some(dir) = paths.logs.to_str() {
                tracing::debug!(dir, "日志已初始化");
            }

            let sink = Arc::new(TauriEventSink::new(app.handle().clone()));
            // 凭据落**系统凭据库**（Windows Credential Manager）；不可用时 `open_store()`
            // 会退回内存实现并留一条 warn——界面上的凭据提示据此说明「重启后是否还在」。
            // 宠物数据目录要在 `paths` 被移动进 CoreContext **之前**算出来
            let pet_dir = paths.data.join("pet");
            let mut core = CoreContext::new(paths)
                .with_events(sink)
                .with_credentials(gently_core::plugin::open_store());

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

            /* 宠物核心：**独立引擎、独立库**（`<data>/pet/pet.db`），与音乐核心互不依赖。
               打不开时不阻塞启动（宠物是可选扩展）：降级为内存引擎，界面诊断会显示真实路径。 */
            let pet = match pet_core::Engine::open(&pet_dir) {
                Ok(engine) => {
                    tracing::info!(dir = %pet_dir.display(), "宠物核心就绪");
                    engine
                }
                Err(err) => {
                    tracing::error!(code = err.code.as_str(), message = %err.message, "宠物库打开失败，降级为内存引擎");
                    pet_core::Engine::open_in_memory().unwrap_or_else(|_| {
                        // 理论上不会失败（内存库）；真失败也不想把整个应用带崩
                        unreachable!("内存宠物库初始化失败")
                    })
                }
            };

            app.manage(AppState {
                core: Arc::new(core),
                pet: Arc::new(Mutex::new(pet)),
                _log_guard: log_guard,
            });

            /* 宠物「看向鼠标」：宿主轮询全局光标（Windows），方向变了才发事件给宠物窗口。
               非 Windows 平台这里什么都不做（宠物退化成像素动画，不报错）。 */
            pet_watch::install(app.handle().clone());

            /* 主窗口关掉 = 应用退出。
               为什么需要特意接：桌面歌词窗口与宠物窗口是**在同一进程里的独立窗口**，
               Tauri 只在「所有窗口都关了」时才退出事件循环——主窗口一关，隐藏的歌词窗口
               和（可能正在显示的）宠物窗口还活着，进程就会变成一个点不到、也退不掉的幽灵。
               这里把「关主窗口」明确解释成「退出应用」，宠物窗口跟着一起收。 */
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        handle.exit(0);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_invoke,
            pet_invoke,
            app_restart,
            playback_banner,
            import_audio,
            web_login::web_login
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            /* 退出时把宠物资料写回：`tick` 是写后置的（每 200 帧一次），不 flush 会丢掉
               最近约 10 秒的游走状态。好感/饱食是交互即时写的，本来就不会丢——
               这里补的是「不让最后一小段白跑」。失败只记日志：退出路径不该被数据层拦住。 */
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    let pet = Arc::clone(&state.pet);
                    // 先把锁拿出来的结果放进变量：`if let Ok(..) = pet.lock()` 的临时值
                    // 会活到整段结束，`pet` 反而先被 drop（借用检查器会拦住）
                    let locked = pet.lock();
                    if let Ok(mut engine) = locked {
                        match engine.flush() {
                            Ok(()) => tracing::debug!("宠物资料已写回"),
                            Err(err) => {
                                tracing::warn!(code = err.code.as_str(), "退出前写回宠物资料失败")
                            }
                        }
                    }
                }
            }
        });
}


