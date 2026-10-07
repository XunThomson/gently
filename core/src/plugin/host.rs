//! 插件宿主：内嵌 QuickJS 的沙箱执行环境。
//!
//! # 架构
//!
//! **每个插件一个专用线程，线程内持有它自己的 QuickJS 运行时。**
//! QuickJS 是单线程的；专用线程既满足类型约束，又天然把插件之间的故障隔离开
//! （一个插件卡死不影响另一个）。宿主本身是 `Send + Sync` 的：外部只拿到「句柄 = 通道」。
//!
//! **执行模型是同步的**：宿主 `fetch` 是阻塞调用，因此插件里 `await fetch(...)` 拿到的是
//! 已 resolve 的 Promise。插件作者仍可以写 `async function`——宿主用
//! `Ctx::execute_pending_job()` 手动排空微任务队列直到结果落地（不需要 async 运行时，
//! 也就避免了跨线程 Send 的约束）。
//!
//! # 沙箱给了什么
//!
//! 插件运行在一个**空白全局对象**上，只有 bootstrap 显式安装的能力：
//! - `fetch`：同步（宿主侧阻塞）→ 只能 HTTPS、只能命中清单 `@hosts`、有超时与体积上限；
//! - `console`：转发到核心日志（带插件 id 前缀）；
//! - `storage`：插件私有 kv（`plugins/.kv/<id>.json`，卸载时清理）；
//! - `credentials.get`：只读、只对该插件、需要 `credentials` 权限；
//! - bootstrap 结束后**删除所有 `__host*` 原始入口**，插件无法绕过封装。
//!
//! 没有 `fs` / `process` / `require` / 定时器无限循环的逃生口：执行有内存上限与
//! 截止时间中断（`set_interrupt_handler`），超时 → `plugin.runtime_error`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rquickjs::{Context, Function, Runtime, Value};

use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::paths::AppPaths;

use super::credentials::CredentialStore;
use super::manifest::{PluginCapability, PluginManifest, PluginPermission};
use super::transport::{host_allowed, host_of, HttpRequest, HttpTransport};

/// 运行时限制。
#[derive(Debug, Clone, Copy)]
pub struct HostLimits {
    /// 单次插件调用上限（契约：8s）
    pub call_timeout: Duration,
    /// JS 内存上限
    pub memory_bytes: usize,
    /// JS 栈上限
    pub stack_bytes: usize,
}

impl Default for HostLimits {
    fn default() -> Self {
        Self {
            call_timeout: Duration::from_secs(8),
            memory_bytes: 64 * 1024 * 1024,
            stack_bytes: 1024 * 1024,
        }
    }
}

const CAPABILITY_NAMES: [(&str, PluginCapability); 9] = [
    ("search", PluginCapability::Search),
    ("getMediaSource", PluginCapability::GetMediaSource),
    ("getTrackInfo", PluginCapability::GetTrackInfo),
    ("getAlbumInfo", PluginCapability::GetAlbumInfo),
    ("getPlaylistInfo", PluginCapability::GetPlaylistInfo),
    ("getLyric", PluginCapability::GetLyric),
    ("getTopLists", PluginCapability::GetTopLists),
    ("getTopList", PluginCapability::GetTopList),
    ("getRecommend", PluginCapability::GetRecommend),
];

/// 已加载插件：外部只见句柄（清单 + 能力 + 与插件线程通信的通道）。
pub struct PluginHandle {
    pub manifest: PluginManifest,
    pub capabilities: Vec<PluginCapability>,
    tx: Sender<Job>,
}

impl PluginHandle {
    pub fn has(&self, capability: PluginCapability) -> bool {
        self.capabilities.contains(&capability)
    }
}

struct Job {
    name: String,
    args_json: String,
    reply: Sender<Fallible<String>>,
}

pub struct PluginHost {
    handles: Mutex<HashMap<String, PluginHandle>>,
    transport: Arc<dyn HttpTransport>,
    credentials: Arc<dyn CredentialStore>,
    limits: HostLimits,
    paths: AppPaths,
}

impl PluginHost {
    pub fn new(
        paths: AppPaths,
        transport: Arc<dyn HttpTransport>,
        credentials: Arc<dyn CredentialStore>,
        limits: HostLimits,
    ) -> Self {
        Self { handles: Mutex::new(HashMap::new()), transport, credentials, limits, paths }
    }

    /// 加载（或重新加载）一个插件：读取源码 → 建运行时 → 探测能力。
    ///
    /// 返回**真实探测**到的能力（覆盖清单里的静态预扫描结果）。
    pub fn load(&self, manifest: PluginManifest) -> Fallible<Vec<PluginCapability>> {
        let entry = super::install::entry_path(&self.paths, &manifest);
        let source = std::fs::read_to_string(&entry).map_err(|err| {
            CoreError::new(ErrorCode::PluginImportFailed, format!("读取插件入口失败：{err}"))
                .with_details(serde_json::json!({ "entry": entry.to_string_lossy() }))
        })?;

        let id = manifest.id.clone();
        let limits = self.limits;
        let transport = Arc::clone(&self.transport);
        let credentials = Arc::clone(&self.credentials);
        let kv_path = kv_path(&self.paths, &id);

        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<Fallible<Vec<PluginCapability>>>();
        let thread_manifest = manifest.clone();

        thread::Builder::new()
            .name(format!("gently-plugin-{id}"))
            .spawn(move || {
                runtime_thread(thread_manifest, source, limits, transport, credentials, kv_path, rx, ready_tx);
            })
            .map_err(|err| CoreError::internal(format!("创建插件线程失败：{err}")))?;

        // 首次加载必须等到「运行时就绪 + 能力探测完成」；语法错误等在这里被报出来
        let capabilities = match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(result) => result?,
            Err(RecvTimeoutError::Timeout) => {
                return Err(CoreError::new(ErrorCode::PluginRuntimeError, "插件初始化超时"))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CoreError::new(ErrorCode::PluginRuntimeError, "插件线程提前退出"))
            }
        };

        self.handles
            .lock()
            .map_err(|_| CoreError::internal("插件表锁已中毒"))?
            .insert(id, PluginHandle { manifest, capabilities: capabilities.clone(), tx });

        Ok(capabilities)
    }

    pub fn unload(&self, id: &str) {
        if let Ok(mut handles) = self.handles.lock() {
            // 丢弃句柄 → 通道关闭 → 插件线程自行退出
            handles.remove(id);
        }
    }

    pub fn loaded_ids(&self) -> Vec<String> {
        self.handles.lock().map(|map| map.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn capabilities(&self, id: &str) -> Option<Vec<PluginCapability>> {
        self.handles.lock().ok()?.get(id).map(|handle| handle.capabilities.clone())
    }

    /// 已加载插件的清单（`plugin.reload` 用它刷新能力列表）。
    pub fn manifest_of(&self, id: &str) -> Option<PluginManifest> {
        self.handles.lock().ok()?.get(id).map(|handle| handle.manifest.clone())
    }

    /// 调用插件里的一个函数。`args_json` 是调用参数的 JSON 数组。
    ///
    /// 返回值的 JSON 文本；错误按语义区分：
    /// - 未实现该能力 → `common.not_implemented`（UI 隐藏入口）
    /// - 越权（未声明的域名/权限）→ `plugin.permission_denied`
    /// - 抛错/超时 → `plugin.runtime_error`
    /// - 未加载 → `plugin.not_found`（契约里对应 `common.not_found` 语义）
    pub fn call(&self, id: &str, function: &str, args_json: &str) -> Fallible<String> {
        let (tx, capability) = {
            let handles = self.handles.lock().map_err(|_| CoreError::internal("插件表锁已中毒"))?;
            let handle = handles
                .get(id)
                .ok_or_else(|| CoreError::not_found(format!("插件未加载：{id}")))?;
            let capability = CAPABILITY_NAMES
                .iter()
                .find(|(name, _)| *name == function)
                .map(|(_, capability)| *capability);
            (handle.tx.clone(), capability)
        };

        if let Some(capability) = capability {
            let handles = self.handles.lock().map_err(|_| CoreError::internal("插件表锁已中毒"))?;
            if let Some(handle) = handles.get(id) {
                if !handle.has(capability) {
                    return Err(CoreError::not_implemented(&format!("{id}.{function}")));
                }
            }
        }

        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(Job { name: function.to_string(), args_json: args_json.to_string(), reply: reply_tx })
            .map_err(|_| CoreError::new(ErrorCode::PluginRuntimeError, "插件线程已退出，请重新加载"))?;

        // 多等 500ms：留给插件线程自己触发中断并回报「超时」，错误信息更准确
        match reply_rx.recv_timeout(self.limits.call_timeout + Duration::from_millis(500)) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(CoreError::new(
                ErrorCode::PluginRuntimeError,
                format!("插件调用超时（>{}ms），线程可能卡死，建议 reload", self.limits.call_timeout.as_millis()),
            )
            .with_details(serde_json::json!({ "plugin": id, "function": function }))),
            Err(RecvTimeoutError::Disconnected) => {
                Err(CoreError::new(ErrorCode::PluginRuntimeError, "插件线程已退出"))
            }
        }
    }
}

// ---------------------------------------------------------------- 插件线程

#[allow(clippy::too_many_arguments)]
fn runtime_thread(
    manifest: PluginManifest,
    source: String,
    limits: HostLimits,
    transport: Arc<dyn HttpTransport>,
    credentials: Arc<dyn CredentialStore>,
    kv_path: PathBuf,
    jobs: mpsc::Receiver<Job>,
    ready: Sender<Fallible<Vec<PluginCapability>>>,
) {
    let id = manifest.id.clone();
    let deadline = Arc::new(AtomicU64::new(0));

    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => {
            let _ = ready.send(Err(CoreError::new(
                ErrorCode::PluginRuntimeError,
                format!("创建 JS 运行时失败：{err}"),
            )));
            return;
        }
    };
    runtime.set_memory_limit(limits.memory_bytes);
    runtime.set_max_stack_size(limits.stack_bytes);
    {
        let deadline = Arc::clone(&deadline);
        // 截止时间到了就中断 JS 执行（QuickJS 会在安全检查点返回中断错误）
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let value = deadline.load(Ordering::Relaxed);
            value != 0 && now_millis() >= value
        })));
    }

    let context = match Context::full(&runtime) {
        Ok(context) => context,
        Err(err) => {
            let _ = ready.send(Err(CoreError::new(
                ErrorCode::PluginRuntimeError,
                format!("创建 JS 上下文失败：{err}"),
            )));
            return;
        }
    };

    // 1) 安装 bootstrap 与宿主能力
    // 同步上下文：宿主函数与 eval 都是普通调用
    let setup = context.with(|ctx| {
        install_host_functions(&ctx, &manifest, Arc::clone(&transport), Arc::clone(&credentials), kv_path)?;
        ctx.eval::<(), _>(BOOTSTRAP).map_err(|err| describe_js_error(&err, "bootstrap 执行失败"))
    });
    if let Err(err) = setup {
        let _ = ready.send(Err(err));
        return;
    }

    // 2) 执行插件源码
    let evaluated = context.with(|ctx| {
        ctx.eval::<(), _>(source.as_bytes())
            .map_err(|err| describe_js_error(&err, "插件加载失败（语法或顶层执行错误）"))
    });
    if let Err(err) = evaluated {
        let _ = ready.send(Err(err));
        return;
    }

    // 3) 真实能力探测：先让 JS 侧把函数收集到 exports，再读回名字。
    //    `function search(){}`、`const search = async () => {}`、`globalThis.search = ...`
    //    三种写法都能认出来（词法作用域里的声明不在 globalThis 上）。
    let capabilities = match collect_capabilities(&context) {
        Ok(capabilities) => capabilities,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    tracing::info!(plugin = %id, capabilities = ?capabilities, "插件已加载");
    let _ = ready.send(Ok(capabilities));

    // 4) 顺序处理调用（QuickJS 单线程；一个插件同时只有一个调用在跑）
    while let Ok(job) = jobs.recv() {
        let started = now_millis();
        let deadline_at = started + limits.call_timeout.as_millis() as u64;
        deadline.store(deadline_at, Ordering::Relaxed);

        // 同步执行：shim 把结果/错误写进两个全局槽位，这里排空微任务队列直到结果落地。
        // 插件作者可以写 `async function`——`fetch` 是同步宿主调用，Promise 会立即落地。
        let outcome: Fallible<String> = context.with(|ctx| -> Fallible<String> {
            ctx.eval::<(), _>(
                "globalThis.__gentlyResult = undefined; globalThis.__gentlyError = undefined;",
            )
            .map_err(|err| describe_js_error(&err, "重置调用槽位失败"))?;

            let invoke: Function = ctx
                .globals()
                .get("__invoke")
                .map_err(|err| CoreError::internal(format!("宿主 shim 丢失：{err}")))?;
            invoke
                .call::<_, Value>((job.name.clone(), job.args_json.clone()))
                .map_err(|err| describe_js_error(&err, "调用失败"))?;

            // 排空作业队列；带截止时间保护（中断处理器也会在 JS 内部生效）
            loop {
                let settled: bool = ctx
                    .eval(
                        "globalThis.__gentlyResult !== undefined || globalThis.__gentlyError !== undefined",
                    )
                    .map_err(|err| describe_js_error(&err, "读取调用结果失败"))?;
                if settled || now_millis() >= deadline_at {
                    break;
                }
                if !ctx.execute_pending_job() {
                    break;
                }
            }

            let error: Option<String> = ctx.eval("globalThis.__gentlyError").unwrap_or(None);
            if let Some(message) = error {
                return Err(describe_js_message(&message));
            }
            match ctx.eval::<Option<String>, _>("globalThis.__gentlyResult").unwrap_or(None) {
                Some(json) => Ok(json),
                None => Err(CoreError::new(
                    ErrorCode::PluginRuntimeError,
                    format!("插件未返回结果：{}", job.name),
                )),
            }
        });

        deadline.store(0, Ordering::Relaxed);

        let result = match outcome {
            Ok(json) => Ok(json),
            Err(err) => {
                // 中断触发说明是超时（QuickJS 的中断错误没有独立类型）
                if now_millis() >= started + limits.call_timeout.as_millis() as u64 {
                    Err(CoreError::new(
                        ErrorCode::PluginRuntimeError,
                        format!(
                            "插件调用超时（{}ms）：{}",
                            limits.call_timeout.as_millis(),
                            job.name
                        ),
                    )
                    .with_details(serde_json::json!({ "plugin": id, "function": job.name })))
                } else {
                    Err(err)
                }
            }
        };

        let _ = job.reply.send(result);
    }

    tracing::debug!(plugin = %id, "插件线程退出");
}

/// 安装宿主函数并注入 bootstrap 之前的原始入口。
fn install_host_functions(
    ctx: &rquickjs::Ctx<'_>,
    manifest: &PluginManifest,
    transport: Arc<dyn HttpTransport>,
    credentials: Arc<dyn CredentialStore>,
    kv_path: PathBuf,
) -> Fallible<()> {
    let globals = ctx.globals();
    let plugin_id = manifest.id.clone();

    // ---- 日志 ----
    {
        let plugin_id = plugin_id.clone();
        globals
            .set(
                "__hostLog",
                Function::new(ctx.clone(), move |level: String, message: String| {
                    match level.as_str() {
                        "error" => tracing::error!(plugin = %plugin_id, "{message}"),
                        "warn" => tracing::warn!(plugin = %plugin_id, "{message}"),
                        "debug" => tracing::debug!(plugin = %plugin_id, "{message}"),
                        _ => tracing::info!(plugin = %plugin_id, "{message}"),
                    }
                }),
            )
            .map_err(host_setup_error)?;
    }

    // ---- 出网（权限 + 白名单 + 仅 HTTPS） ----
    {
        let permissions = manifest.permissions.clone();
        let hosts = manifest.hosts.clone();
        globals
            .set(
                "__hostFetch",
                Function::new(ctx.clone(), move |url: String, options_json: String| -> rquickjs::Result<String> {
                    if !permissions.contains(&PluginPermission::Network) {
                        return Err(js_error("GENTLY_PERMISSION_DENIED", "插件未声明网络权限"));
                    }
                    if !url.starts_with("https://") {
                        return Err(js_error("GENTLY_PERMISSION_DENIED", "插件出网只允许 HTTPS"));
                    }
                    let host = host_of(&url)
                        .ok_or_else(|| js_error("GENTLY_PLUGIN_ERROR", "无法解析请求 URL"))?;
                    if !host_allowed(&hosts, &host) {
                        return Err(js_error(
                            "GENTLY_PERMISSION_DENIED",
                            &format!("域名不在清单 @hosts 白名单内：{host}"),
                        ));
                    }

                    let options: serde_json::Value = serde_json::from_str(&options_json)
                        .unwrap_or(serde_json::Value::Null);
                    let request = HttpRequest {
                        method: options
                            .get("method")
                            .and_then(|v| v.as_str())
                            .unwrap_or("GET")
                            .to_ascii_uppercase(),
                        url: url.clone(),
                        headers: options
                            .get("headers")
                            .and_then(|v| v.as_object())
                            .map(|map| {
                                map.iter()
                                    .filter_map(|(key, value)| {
                                        value.as_str().map(|text| (key.clone(), text.to_string()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        body: options.get("body").and_then(|v| v.as_str()).map(str::to_string),
                    };

                    let response = transport
                        .send(&request)
                        .map_err(|err| js_error("GENTLY_PLUGIN_ERROR", &err.message))?;
                    serde_json::to_string(&response)
                        .map_err(|err| js_error("GENTLY_PLUGIN_ERROR", &err.to_string()))
                }),
            )
            .map_err(host_setup_error)?;
    }

    // ---- 插件私有 kv（每次读打开文件：简单、无跨线程状态；写时原子落盘） ----
    {
        let path = kv_path.clone();
        globals
            .set(
                "__hostStorageGet",
                Function::new(ctx.clone(), move |key: String| -> Option<String> {
                    KvStore::open(path.clone()).get(&key)
                }),
            )
            .map_err(host_setup_error)?;
    }
    {
        let path = kv_path.clone();
        globals
            .set(
                "__hostStorageSet",
                Function::new(ctx.clone(), move |key: String, value: String| {
                    let mut store = KvStore::open(path.clone());
                    store.set(&key, &value);
                }),
            )
            .map_err(host_setup_error)?;
    }
    {
        let path = kv_path;
        globals
            .set(
                "__hostStorageDelete",
                Function::new(ctx.clone(), move |key: String| {
                    let mut store = KvStore::open(path.clone());
                    store.delete(&key);
                }),
            )
            .map_err(host_setup_error)?;
    }

    // ---- 凭据（只读；未声明权限则一律返回空） ----
    {
        let plugin_id = plugin_id.clone();
        let allowed = manifest.permissions.contains(&PluginPermission::Credentials);
        globals
            .set(
                "__hostCredentialGet",
                Function::new(ctx.clone(), move |key: String| -> Option<String> {
                    if !allowed {
                        return None;
                    }
                    credentials.get(&plugin_id, &key)
                }),
            )
            .map_err(host_setup_error)?;
    }

    Ok(())
}

fn host_setup_error(err: rquickjs::Error) -> CoreError {
    CoreError::new(ErrorCode::PluginRuntimeError, format!("安装宿主能力失败：{err}"))
}

/// 构造一个带标记的 JS 错误：宿主侧据此把错误归类到正确错误码。
fn js_error(marker: &'static str, message: &str) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("host", marker, format!("{marker}: {message}"))
}

/// 让 JS 侧收集插件导出的函数并映射成能力列表。
///
/// 必须在**源码 eval 之后**调用：`const`/`let` 声明的函数存在于全局词法环境，
/// 不在 `globalThis` 上，只有回到 JS 里用 `eval(name)` 才能看到。
fn collect_capabilities(context: &Context) -> Fallible<Vec<PluginCapability>> {
    context.with(|ctx| {
        let names: Vec<String> = ctx
            .eval("__collect()")
            .map_err(|err| describe_js_error(&err, "能力探测失败"))?;
        Ok(names
            .iter()
            .filter_map(|name| {
                CAPABILITY_NAMES
                    .iter()
                    .find(|(candidate, _)| candidate == name)
                    .map(|(_, capability)| *capability)
            })
            .collect())
    })
}
/// 把 JS 异常翻译成契约错误码。
fn describe_js_error(err: &rquickjs::Error, context: &str) -> CoreError {
    let described = describe_js_message(&err.to_string());
    CoreError::new(described.code, format!("{context}：{}", described.message))
}

/// 按 shim 写入的标记归类错误（权限 / 能力缺失 / 插件自身抛错）。
fn describe_js_message(message: &str) -> CoreError {
    let code = if message.contains("GENTLY_PERMISSION_DENIED") {
        ErrorCode::PluginPermissionDenied
    } else if message.contains("GENTLY_CAPABILITY_MISSING") {
        ErrorCode::NotImplemented
    } else {
        ErrorCode::PluginRuntimeError
    };
    let text = message.replace("GENTLY_PLUGIN_ERROR: ", "").trim().to_string();
    CoreError::new(code, if text.is_empty() { message.to_string() } else { text })
}

/// 插件私有 kv：内存视图 + 原子落盘。
struct KvStore {
    path: PathBuf,
    values: HashMap<String, String>,
}

impl KvStore {
    fn open(path: PathBuf) -> Self {
        let values = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<HashMap<String, String>>(&text).ok())
            .unwrap_or_default();
        Self { path, values }
    }

    fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    fn set(&mut self, key: &str, value: &str) {
        self.values.insert(key.to_string(), value.to_string());
        self.flush();
    }

    fn delete(&mut self, key: &str) {
        self.values.remove(key);
        self.flush();
    }

    /// 原子写：先写临时文件再 rename，避免插件读到半截 JSON。
    fn flush(&self) {
        if let Some(parent) = self.path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        let Ok(text) = serde_json::to_string(&self.values) else { return };
        let temp = self.path.with_extension("tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, &self.path);
        }
    }
}

/// 插件 kv 文件位置：放在 plugins 目录下的隐藏子目录，卸载时一并清理。
pub fn kv_path(paths: &AppPaths, id: &str) -> PathBuf {
    paths.plugins.join(".kv").join(format!("{id}.json"))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// bootstrap：把原始宿主入口包装成插件友好的 API，然后**删除原始入口**。
const BOOTSTRAP: &str = r#"
(function () {
    const hostFetch = globalThis.__hostFetch;
    const hostLog = globalThis.__hostLog;
    const hostStorageGet = globalThis.__hostStorageGet;
    const hostStorageSet = globalThis.__hostStorageSet;
    const hostStorageDelete = globalThis.__hostStorageDelete;
    const hostCredentialGet = globalThis.__hostCredentialGet;

    const flat = (args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

    globalThis.console = {
        log: (...a) => hostLog('info', flat(a)),
        info: (...a) => hostLog('info', flat(a)),
        warn: (...a) => hostLog('warn', flat(a)),
        error: (...a) => hostLog('error', flat(a)),
    };

    // fetch 是同步宿主调用，但对外暴露为 Promise（作者可以自由使用 await）
    globalThis.fetch = function (url, options) {
        const res = JSON.parse(hostFetch(String(url), JSON.stringify(options || {})));
        return Promise.resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            headers: res.headers || [],
            text: () => Promise.resolve(res.body),
            json: () => Promise.resolve(JSON.parse(res.body)),
        });
    };

    globalThis.storage = {
        get(key) {
            const raw = hostStorageGet(String(key));
            return raw === null || raw === undefined ? undefined : JSON.parse(raw);
        },
        set(key, value) {
            hostStorageSet(String(key), JSON.stringify(value === undefined ? null : value));
        },
        delete(key) {
            hostStorageDelete(String(key));
        },
    };

    globalThis.credentials = {
        get(key) {
            const value = hostCredentialGet(String(key));
            return value === null || value === undefined ? undefined : value;
        },
    };

    // 统一入口：核心只通过它调用插件（能力缺失在这里就被挡住）。
    // 结果写进全局槽位，宿主排空微任务队列后读取——这样插件可以自由地写 async 函数。
    // 收集插件导出的函数：顶层 const/let 声明不在 globalThis 上，只有回到 JS 里
    // 用 eval(name) 才能看到（宿主据此做能力探测）。
    globalThis.__collect = function () {
        const names = ['search', 'getMediaSource', 'getTrackInfo', 'getAlbumInfo',
                       'getPlaylistInfo', 'getLyric', 'getTopLists', 'getTopList', 'getRecommend'];
        const out = {};
        for (let i = 0; i < names.length; i++) {
            let fn;
            try { fn = eval(names[i]); } catch (err) { fn = undefined; }
            if (typeof fn === 'function') { out[names[i]] = fn; }
        }
        globalThis.__plugin_exports = out;
        return Object.keys(out);
    };

    globalThis.__invoke = function (name, argsJson) {
        const exports = globalThis.__plugin_exports || {};
        const fn = exports[name];
        if (typeof fn !== 'function') {
            globalThis.__gentlyError = 'GENTLY_CAPABILITY_MISSING: ' + name;
            return;
        }
        let args;
        try {
            args = JSON.parse(argsJson || '[]');
        } catch (err) {
            globalThis.__gentlyError = 'GENTLY_PLUGIN_ERROR: 调用参数不是合法 JSON';
            return;
        }
        const fail = (err) => {
            globalThis.__gentlyError = 'GENTLY_PLUGIN_ERROR: ' + (err && err.message ? err.message : String(err));
        };
        try {
            Promise.resolve(fn.apply(null, args)).then(
                (value) => {
                    globalThis.__gentlyResult = JSON.stringify(value === undefined ? null : value);
                },
                fail
            );
        } catch (err) {
            fail(err);
        }
    };

    // 抹掉原始入口：插件只能用上面这些受控封装
    delete globalThis.__hostFetch;
    delete globalThis.__hostLog;
    delete globalThis.__hostStorageGet;
    delete globalThis.__hostStorageSet;
    delete globalThis.__hostStorageDelete;
    delete globalThis.__hostCredentialGet;
})();
"#;
