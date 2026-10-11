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
//! - `fetch`：同步（宿主侧阻塞）→ 只能 HTTPS、只能命中清单 `@hosts`（兼容模式例外，
//!   见 ADR-0006）、有超时与体积上限；
//! - `console`：转发到核心日志（带插件 id 前缀）；
//! - `storage`：插件私有 kv（`plugins/.kv/<id>.json`，卸载时清理）；
//! - `credentials.get`：只读、只对该插件、需要 `credentials` 权限；
//! - `module` / `exports` / `require`：CommonJS 最小环境 + **固定、可审计的模块清单**
//!   （`he` / `axios` / `dayjs` / `crypto-js` 子集，见 `sandbox/compat.js`）；
//!   `fetch` 之外的一切仍受同一套权限与白名单约束，垫片只是「形状翻译」，不新增能力；
//! - bootstrap 结束后**删除所有 `__host*` 原始入口**，插件无法绕过封装。
//!
//! 没有 `fs` / `process` / 原生模块 / 定时器无限循环的逃生口：执行有内存上限与
//! 截止时间中断（`set_interrupt_handler`），超时 → `plugin.runtime_error`。
//!
//! 沙箱代码（bootstrap 与 require 垫片）是纯 JS，放在 `sandbox/` 下用 `include_str!`
//! 编进二进制——它们改起来比 Rust 字符串字面量安全得多（语法高亮 + 不转义）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rquickjs::{Context, Function, Runtime, Value};

use md5::Md5;
use sha2::{Digest, Sha256};

use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::paths::AppPaths;

use super::credentials::CredentialStore;
use super::hosts::{HostLedger, HostUse};
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
    /// 兼容模式下实际访问过的域名（TOFU 收敛的依据，ADR-0006）
    ledger: Arc<HostLedger>,
}

impl PluginHost {
    pub fn new(
        paths: AppPaths,
        transport: Arc<dyn HttpTransport>,
        credentials: Arc<dyn CredentialStore>,
        limits: HostLimits,
    ) -> Self {
        // 台账放在 plugins 目录下的隐藏子目录：卸载插件时一并清掉
        let ledger = Arc::new(HostLedger::new(paths.plugins.join(".hosts")));
        Self { handles: Mutex::new(HashMap::new()), transport, credentials, limits, paths, ledger }
    }

    /// 凭据读写句柄（命令层用）。
    ///
    /// 插件自己**只能**通过沙箱里的 `credentials.get` 只读访问；写入只发生在用户显式操作时。
    pub fn credentials(&self) -> &Arc<dyn CredentialStore> {
        &self.credentials
    }

    /// 该插件在兼容模式下访问过的域名（按首次出现顺序）。
    pub fn observed_hosts(&self, id: &str) -> Vec<HostUse> {
        self.ledger.observed(id)
    }

    /// 收敛（固化白名单）后清掉观测记录。
    pub fn clear_observed_hosts(&self, id: &str) {
        self.ledger.clear(id);
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
        let ledger = Arc::clone(&self.ledger);

        thread::Builder::new()
            .name(format!("gently-plugin-{id}"))
            .spawn(move || {
                runtime_thread(thread_manifest, source, limits, transport, credentials, kv_path, ledger, rx, ready_tx);
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
    ledger: Arc<HostLedger>,
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
        install_host_functions(
            &ctx,
            &manifest,
            Arc::clone(&transport),
            Arc::clone(&credentials),
            kv_path,
            Some(Arc::clone(&ledger)),
        )?;
        ctx.eval::<(), _>(BOOTSTRAP).map_err(|err| describe_js_error(&err, "bootstrap 执行失败"))
    });
    if let Err(err) = setup {
        let _ = ready.send(Err(err));
        return;
    }

    // 2) 执行插件源码
    let evaluated = context.with(|ctx| {
        ctx.eval::<(), _>(source.as_bytes())
            .map_err(|err| eval_failure(&ctx, &err, "插件加载失败（语法或顶层执行错误）"))
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
    ledger: Option<Arc<HostLedger>>,
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
        let compat = manifest.compat;
        let plugin_id_for_net = manifest.id.clone();
        let ledger = ledger.clone();
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

                    // 本机/内网地址永远拒绝：兼容模式放宽的是「哪些公网域名」，
                    // 不是「能不能打本机」——SSRF 防线不因兼容模式而退让。
                    if crate::plugin::is_private_host(&host) {
                        return Err(js_error(
                            "GENTLY_PERMISSION_DENIED",
                            &format!("拒绝访问本机/内网地址：{host}"),
                        ));
                    }

                    if compat {
                        // 兼容模式：允许任意公网 HTTPS，并把实际域名记进日志与**观测台账**——
                        // 台账是「把用到的域名固化为白名单」这条 TOFU 收敛路径的唯一依据。
                        tracing::info!(plugin = %plugin_id_for_net, host = %host, "兼容模式放行出网域名");
                        if let Some(ledger) = &ledger {
                            ledger.observe(&plugin_id_for_net, &host);
                        }
                    } else if !host_allowed(&hosts, &host) {
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
        let store = Arc::clone(&credentials);
        globals
            .set(
                "__hostCredentialGet",
                Function::new(ctx.clone(), move |key: String| -> Option<String> {
                    if !allowed {
                        return None;
                    }
                    store.get(&plugin_id, &key)
                }),
            )
            .map_err(host_setup_error)?;
    }

    // ---- 用户变量（MusicFree 的 `env.getUserVariables()`） ----
    // 只回**清单声明过**的键：清单是用户同意时看到的那份，不允许插件偷偷多读。
    // 没有凭据权限时返回空对象（与 `credentials.get` 同一道门）。
    {
        let plugin_id = plugin_id.clone();
        let allowed = manifest.permissions.contains(&PluginPermission::Credentials);
        let declared: Vec<String> = manifest.credentials.iter().map(|field| field.key.clone()).collect();
        let store = Arc::clone(&credentials);
        globals
            .set(
                "__hostUserVariables",
                Function::new(ctx.clone(), move || -> String {
                    if !allowed {
                        return "{}".to_string();
                    }
                    let mut map = serde_json::Map::new();
                    for key in &declared {
                        if let Some(value) = store.get(&plugin_id, key) {
                            map.insert(key.clone(), serde_json::Value::String(value));
                        }
                    }
                    serde_json::Value::Object(map).to_string()
                }),
            )
            .map_err(host_setup_error)?;
    }

    // ---- 运行环境信息（`env.os` / `env.appVersion` / `process.platform`） ----
    // MusicFree 的插件常按 `env.os === 'android'` 分支；我们如实报当前桌面平台，
    // 而不是假装成安卓——插件若因此拒绝运行，用户看到的提示才是真的原因。
    {
        globals
            .set(
                "__hostEnvInfo",
                Function::new(ctx.clone(), move || -> String {
                    serde_json::json!({
                        "os": std::env::consts::OS,
                        "platform": std::env::consts::OS,
                        "appVersion": env!("CARGO_PKG_VERSION"),
                        "lang": "zh-CN",
                    })
                    .to_string()
                }),
            )
            .map_err(host_setup_error)?;
    }

    // ---- 哈希（crypto-js 垫片用） ----
    // 输入固定是十六进制字节串，输出小写十六进制摘要：只有一种形状，垫片侧不需要
    // 处理二进制编组，密码学实现也只有宿主这一份（sha2 / md-5）。
    {
        globals
            .set(
                "__hostDigest",
                Function::new(
                    ctx.clone(),
                    move |algorithm: String, hex: String| -> rquickjs::Result<String> {
                        let bytes = decode_hex(&hex).ok_or_else(|| {
                            js_error("GENTLY_PLUGIN_ERROR", "哈希输入必须是偶数长度的十六进制字符串")
                        })?;
                        digest_hex(&algorithm, &bytes).ok_or_else(|| {
                            js_error(
                                "GENTLY_PLUGIN_ERROR",
                                &format!("不支持的哈希算法：{algorithm}（只有 md5 / sha256）"),
                            )
                        })
                    },
                ),
            )
            .map_err(host_setup_error)?;
    }

    Ok(())
}

/// 十六进制字符串 → 字节（非法输入返回 None；不接受奇数长度）。
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push((high * 16 + low) as u8);
    }
    Some(out)
}

/// 摘要（小写十六进制）。只提供兼容插件实际需要的两种算法（ADR-0006：固定、可审计）。
fn digest_hex(algorithm: &str, bytes: &[u8]) -> Option<String> {
    match algorithm {
        "md5" => {
            let mut hasher = Md5::new();
            hasher.update(bytes);
            Some(format!("{:x}", hasher.finalize()))
        }
        "sha256" => {
            let mut hasher = Sha256::new();
            hasher.update(bytes);
            Some(format!("{:x}", hasher.finalize()))
        }
        _ => None,
    }
}

fn host_setup_error(err: rquickjs::Error) -> CoreError {
    CoreError::new(ErrorCode::PluginRuntimeError, format!("安装宿主能力失败：{err}"))
}

/// 构造一个带标记的 JS 错误：宿主侧据此把错误归类到正确错误码。
fn js_error(marker: &'static str, message: &str) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("host", marker, format!("{marker}: {message}"))
}

/// 探测结果：CommonJS 插件的元数据 + 真实能力。
#[derive(Debug, Clone, Default)]
pub struct ModuleProbe {
    /// `module.exports` 里的元数据（MusicFree 风格：name/version/platform/author…）
    pub metadata: std::collections::HashMap<String, String>,
    /// `module.exports.userVariables`：MusicFree 风格的用户变量声明（合成凭据字段用）
    pub variables: Vec<super::manifest::CredentialField>,
    pub capabilities: Vec<PluginCapability>,
}

/// 在沙箱里**只读地**跑一遍源码，读出 `module.exports` 的元数据与能力。
///
/// 用途：兼容模式下，MusicFree 风格插件没有头部注释，元数据在导出对象里。
/// 代价是会在沙箱内执行插件的顶层代码（有副作用可能），因此只在**用户显式开启
/// 兼容模式**的预览/安装流程里调用，并且此时 `fetch` 会因为空域名白名单而被拒绝。
///
/// 和正常调用一样有**截止时间中断**：顶层死循环会按 `limits.call_timeout` 被掐断，
/// 而不是让预览界面一直转圈。
pub fn probe(source: &str, limits: HostLimits, transport: Arc<dyn HttpTransport>) -> Fallible<ModuleProbe> {
    let runtime = Runtime::new()
        .map_err(|err| CoreError::new(ErrorCode::PluginRuntimeError, format!("创建运行时失败：{err}")))?;
    runtime.set_memory_limit(limits.memory_bytes);
    runtime.set_max_stack_size(limits.stack_bytes);

    // 探测期的截止时间在**进入 JS 之前**就设好：探测同样是一次会执行插件代码的动作
    let deadline = Arc::new(AtomicU64::new(now_millis() + limits.call_timeout.as_millis() as u64));
    {
        let deadline = Arc::clone(&deadline);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let value = deadline.load(Ordering::Relaxed);
            value != 0 && now_millis() >= value
        })));
    }

    // 空清单 + 空白名单：探测阶段不允许任何出网
    let manifest = PluginManifest {
        id: "probe".into(),
        name: "probe".into(),
        version: "0.0.0".into(),
        author: String::new(),
        description: String::new(),
        homepage: None,
        entry: None,
        qualities: vec![super::manifest::TrackQuality::Standard],
        permissions: Vec::new(),
        hosts: Vec::new(),
        credentials: Vec::new(),
        min_core_version: None,
        tags: Vec::new(),
        capabilities: Vec::new(),
        // 探测阶段按最严格策略：既不开兼容模式，也没有域名白名单 → 无法出网
        compat: false,
    };

    let context = Context::full(&runtime)
        .map_err(|err| CoreError::new(ErrorCode::PluginRuntimeError, format!("创建上下文失败：{err}")))?;

    context.with(|ctx| -> Fallible<()> {
        // 探测不记台账：探测期的白名单为空，任何请求都会先被拒（也正因为如此，
        // 探测到的域名不算「插件真的访问过」，不该进 TOFU 候选）
        install_host_functions(
            &ctx,
            &manifest,
            transport,
            Arc::new(super::credentials::MemoryCredentialStore::new()),
            std::path::PathBuf::new(),
            None,
        )?;
        ctx.eval::<(), _>(BOOTSTRAP).map_err(|err| describe_js_error(&err, "bootstrap 失败"))?;
        ctx.eval::<(), _>(source.as_bytes())
            .map_err(|err| eval_failure(&ctx, &err, "模块加载失败（顶层代码执行出错）"))?;
        Ok(())
    })?;

    let metadata = context.with(|ctx| -> Fallible<std::collections::HashMap<String, String>> {
        let json: String = ctx
            .eval(
                "(function(){try{return JSON.stringify((globalThis.module&&globalThis.module.exports)||{})}catch(e){return '{}'}})()",
            )
            .map_err(|err| describe_js_error(&err, "读取 module.exports 失败"))?;
        let value: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
        Ok(value
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                    .collect()
            })
            .unwrap_or_default())
    })?;

    let capabilities = collect_capabilities(&context)?;
    let variables = collect_user_variables(&context)?;
    Ok(ModuleProbe { metadata, variables, capabilities })
}

/// 读 `module.exports.userVariables`（MusicFree 风格的**变量声明**数组）。
///
/// 声明形如 `[{key, label?, required?, secret?}]`：插件靠这些键名从
/// `env.getUserVariables()` 取值，因此它们就是我们这边要展示给用户填的凭据字段。
/// 只接受有 `key` 的条目（MusicFree 也是这么过滤的），其它字段缺失时给合理默认值。
fn collect_user_variables(context: &Context) -> Fallible<Vec<super::manifest::CredentialField>> {
    context.with(|ctx| {
        let json: String = ctx
            .eval(
                r#"(function(){try{
                    var list=(globalThis.module&&globalThis.module.exports&&globalThis.module.exports.userVariables)||[];
                    if(!Array.isArray(list))return '[]';
                    return JSON.stringify(list.map(function(item){
                        item=item||{};
                        return {
                            key:String(item.key||''),
                            label:String(item.label||item.name||item.key||''),
                            required:item.required===true,
                            secret:item.secret===true
                        };
                    }).filter(function(item){return item.key.length>0}));
                }catch(e){return '[]'}})()"#,
            )
            .map_err(|err| describe_js_error(&err, "读取 userVariables 失败"))?;
        Ok(serde_json::from_str(&json).unwrap_or_default())
    })
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
/// `eval` 失败时的错误映射：优先带上 bootstrap 记录的说明
/// （QuickJS 异常文本穿不过 `Display`，所以关键信息放在全局槽位里）。
fn eval_failure(ctx: &rquickjs::Ctx<'_>, err: &rquickjs::Error, context: &str) -> CoreError {
    let detail: Option<String> = ctx.eval("globalThis.__gentlyLoadError").unwrap_or(None);
    match detail {
        Some(message) => CoreError::new(ErrorCode::PluginRuntimeError, format!("{context}：{message}")),
        None => describe_js_error(err, context),
    }
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

/// 沙箱 JS：bootstrap（宿主能力封装 + `__invoke`）与 compat（CommonJS + 固定模块清单）。
///
/// 分成两个文件是为了各守一个职责；它们由 `include_str!` 编进二进制，执行顺序即拼接顺序。
const BOOTSTRAP: &str = concat!(
    include_str!("sandbox/bootstrap.js"),
    "\n",
    include_str!("sandbox/compat.js"),
);

