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
use crate::plugin::{
    is_private_host, parse_index, parse_manifest_json, parse_source, sha256_hex, BlockingHttp,
    CatalogEntry, HostLimits, HttpLimits, HttpRequest, HttpTransport, InstallSource,
    InstalledPlugin, MemoryCredentialStore, PluginHost, Subscription, MAX_SOURCE_BYTES,
};
use crate::store::Store;

/// 处理器运行时上下文（由 `src-tauri` 在启动时构造一次）。
pub struct CoreContext {
    pub paths: AppPaths,
    /// 数据库不可用时为 `None`：应用仍要能启动（诊断页会显示原因）。
    pub store: Option<Store>,
    pub store_error: Option<String>,
    /// 插件运行时名：M1b 起为 `quickjs`。
    pub plugin_runtime: &'static str,
    /// 插件沙箱宿主（默认出网实现 + 内存凭据；OS keyring 在后续步骤接入）
    pub plugins: Arc<PluginHost>,
    /// 核心自身发起的出网（订阅索引、插件下载）——与插件宿主共用同一传输实现
    pub http: Arc<dyn HttpTransport>,
    pub events: Arc<dyn EventSink>,
}

impl CoreContext {
    pub fn new(paths: AppPaths) -> Self {
        let http: Arc<dyn HttpTransport> = Arc::new(BlockingHttp::new(HttpLimits::default()));
        let plugins = Arc::new(PluginHost::new(
            paths.clone(),
            Arc::clone(&http),
            Arc::new(MemoryCredentialStore::new()),
            HostLimits::default(),
        ));
        Self {
            paths,
            store: None,
            store_error: None,
            plugin_runtime: "quickjs",
            plugins,
            http,
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
        "plugin.preview" => plugin_preview(ctx, params),
        "plugin.import" => plugin_import(ctx, params),
        "plugin.list" => plugin_list(ctx),
        "plugin.remove" => plugin_remove(ctx, params),
        "plugin.setEnabled" => plugin_set_enabled(ctx, params),
        "plugin.setPriority" => plugin_set_priority(ctx, params),
        "plugin.reload" => plugin_reload(ctx, params),
        "plugin.subscriptions.list" => plugin_subscriptions_list(ctx),
        "plugin.subscriptions.add" => plugin_subscriptions_add(ctx, params),
        "plugin.subscriptions.remove" => plugin_subscriptions_remove(ctx, params),
        "plugin.subscriptions.refresh" => plugin_subscriptions_refresh(ctx, params),
        "plugin.catalog.list" => plugin_catalog_list(ctx, params),
        // 其余命令：契约已登记，实现在后续里程碑接入
        other => Err(CoreError::not_implemented(other)),
    };

    // 分发日志：既是最低成本的链路可观测性（能确认前端确实调到了核心），
    // 也是排查「前端报错但核心没收到」这类问题的第一手证据
    tracing::debug!(command, ok = outcome.is_ok(), "dispatch");

    CoreResult::from(outcome)
}

/// M1 已实现的命令（诊断用；插件域随里程碑逐步点亮）。
const IMPLEMENTED: &[&str] = &[
    "system.status",
    "system.paths",
    "system.reveal",
    "plugin.preview",
    "plugin.import",
    "plugin.list",
    "plugin.remove",
    "plugin.setEnabled",
    "plugin.setPriority",
    "plugin.reload",
    "plugin.subscriptions.list",
    "plugin.subscriptions.add",
    "plugin.subscriptions.remove",
    "plugin.subscriptions.refresh",
    "plugin.catalog.list",
];

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

// ---------------------------------------------------------------- plugin 域

/// 导入来源（与契约 §2 的 `ImportSource` 对应）。
///
/// M1a 支持 `paste` / `file` / `dir`（都是本地、无网络、可即时校验的来源）；
/// `archive` / `url` / `catalog` 需要解压与 HTTP 客户端，放在 M1b/M1c。
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ImportSource {
    File { path: String },
    Dir { path: String },
    Archive { path: String },
    Url { url: String },
    Paste { content: String },
    Catalog { subscription_id: String, file_name: String },
}

#[derive(Debug, serde::Deserialize)]
struct PreviewParams {
    from: ImportSource,
}

/// `plugin.preview`：**读清楚但不落盘、不执行代码**。
///
/// 这是安装链路的第一步，也是权限同意的依据：清单、权限、凭据需求与警告都在这里产出。
fn plugin_preview(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: PreviewParams = parse_params(params)?;

    let parsed = match params.from {
        ImportSource::Paste { content } => {
            if content.len() as u64 > MAX_SOURCE_BYTES {
                return Err(too_large(content.len() as u64));
            }
            parse_source(&content)?
        }
        ImportSource::File { path } => {
            // 读文件是用户的显式动作，因此不限制目录；但限制体积（插件是脚本）
            let meta = std::fs::metadata(&path)?;
            if meta.len() > MAX_SOURCE_BYTES {
                return Err(too_large(meta.len()));
            }
            let content = std::fs::read_to_string(&path)?;
            parse_source(&content)?
        }
        ImportSource::Dir { path } => {
            let manifest_path = std::path::Path::new(&path).join("plugin.json");
            let json = std::fs::read_to_string(&manifest_path).map_err(|err| {
                CoreError::new(
                    ErrorCode::PluginInvalidManifest,
                    format!("读取 plugin.json 失败：{err}"),
                )
                .with_details(serde_json::json!({ "path": manifest_path.to_string_lossy() }))
            })?;

            // 入口源码用于能力预扫描；缺失不算错误（纯声明式插件也允许）
            let raw: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
            let entry_source = raw
                .get("entry")
                .and_then(|v| v.as_str())
                .and_then(|entry| std::fs::read_to_string(std::path::Path::new(&path).join(entry)).ok());
            parse_manifest_json(&json, entry_source.as_deref())?
        }
        ImportSource::Archive { path } => {
            // 明确告诉用户「哪个来源还没实现」，而不是笼统的 not_implemented
            return Err(not_implemented_source("archive", &path));
        }
        ImportSource::Url { url } => {
            return Err(not_implemented_source("url", &url));
        }
        ImportSource::Catalog { subscription_id, file_name } => {
            // 预览同样要下载内容（否则无法给出真实清单），但仍**只读不写**
            let (_, bytes) = download_catalog_entry(ctx, &subscription_id, &file_name)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                CoreError::new(ErrorCode::PluginInvalidSource, "下载的插件不是 UTF-8 文本")
            })?;
            parse_source(&text)?
        }
    };

    let manifest = parsed.manifest;
    // 同 id 是否已存在：M1a 直接看插件目录（安装目录按 id 命名），M1b 起改为读 plugin_state 表
    let replaces_existing = ctx.paths.plugins.join(&manifest.id).exists();

    to_json(serde_json::json!({
        "manifest": manifest,
        "permissions": manifest.permissions,
        "credentials": manifest.credentials,
        "warnings": parsed.warnings,
        "replacesExisting": replaces_existing,
    }))
}

fn too_large(bytes: u64) -> CoreError {
    CoreError::invalid_argument(format!("插件源超过 {MAX_SOURCE_BYTES} 字节上限"))
        .with_details(serde_json::json!({ "bytes": bytes, "limit": MAX_SOURCE_BYTES }))
}

/// 该来源形态尚未实现：带上具体来源与「什么时候会有」，便于前端给出准确提示。
fn not_implemented_source(kind: &str, origin: &str) -> CoreError {
    CoreError::not_implemented(&format!("plugin.preview({kind})")).with_details(
        serde_json::json!({
            "kind": kind,
            "origin": origin,
            "supported": ["paste", "file", "dir"],
        }),
    )
}

#[derive(Debug, serde::Deserialize)]
struct ImportParams {
    from: ImportSource,
    /// 必须是字面量 `true`：安装是不可逆的落盘动作，必须由用户显式同意。
    #[serde(default)]
    consent: bool,
}

/// `plugin.import`：**用户同意后**才落盘。成功返回安装后的完整摘要。
fn plugin_import(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: ImportParams = parse_params(params)?;
    if !params.consent {
        return Err(CoreError::invalid_argument(
            "安装需要用户显式同意（consent 必须为 true）；请先调用 plugin.preview 展示权限",
        ));
    }
    let store = require_store(ctx)?;

    // 订阅条目需要先把内容下载下来（字节必须活到 install 调用结束，因此单独一条分支）
    let outcome = match &params.from {
        ImportSource::Catalog { subscription_id, file_name } => {
            let (_, bytes) = download_catalog_entry(ctx, subscription_id, file_name)?;
            crate::plugin::install(
                &ctx.paths,
                InstallSource::Downloaded {
                    subscription_id,
                    file_name,
                    content: &bytes,
                },
            )?
        }
        other => {
            let source = match other {
                ImportSource::Paste { content } => InstallSource::Paste(content),
                ImportSource::File { path } => InstallSource::File(std::path::Path::new(path)),
                ImportSource::Dir { path } => InstallSource::Dir(std::path::Path::new(path)),
                ImportSource::Archive { path } => return Err(not_implemented_source("archive", path)),
                ImportSource::Url { url } => return Err(not_implemented_source("url", url)),
                ImportSource::Catalog { .. } => unreachable!("catalog 已在上方分支处理"),
            };
            crate::plugin::install(&ctx.paths, source)?
        }
    };
    store.upsert_plugin(&outcome.record)?;

    // 事件：安装完成后前端刷新列表（M1c 会带进度阶段）
    ctx.events.emit(
        crate::events::events::PLUGIN_IMPORT_PROGRESS,
        serde_json::json!({ "phase": "install", "percent": 100 }),
    );

    to_json(serde_json::json!({
        "plugin": plugin_summary(&outcome.record),
        "warnings": outcome.warnings,
        "replaced": outcome.replaced,
    }))
}

/// `plugin.list`：已安装插件（按优先级 → 名称排序，与回退顺序一致）。
fn plugin_list(ctx: &CoreContext) -> Fallible<serde_json::Value> {
    let store = require_store(ctx)?;
    let records = store.list_plugins()?;
    to_json(records.iter().map(plugin_summary).collect::<Vec<_>>())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    id: String,
    /// 缺省 true：卸载默认连文件一起删（只删库记录会留下孤儿目录）
    #[serde(default = "default_true")]
    delete_files: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnabledParams {
    id: String,
    enabled: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriorityParams {
    id: String,
    priority: i64,
}

fn default_true() -> bool {
    true
}

fn plugin_remove(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: RemoveParams = parse_params(params)?;
    let store = require_store(ctx)?;

    let removed = store.remove_plugin(&params.id)?;
    if !removed {
        return Err(CoreError::not_found(format!("插件未安装：{}", params.id)));
    }
    if params.delete_files {
        crate::plugin::remove_files(&ctx.paths, &params.id)?;
    }
    Ok(serde_json::Value::Null)
}

fn plugin_set_enabled(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: EnabledParams = parse_params(params)?;
    let store = require_store(ctx)?;

    if !store.set_plugin_enabled(&params.id, params.enabled)? {
        return Err(CoreError::not_found(format!("插件未安装：{}", params.id)));
    }
    let record = store
        .get_plugin(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{}", params.id)))?;
    to_json(plugin_summary(&record))
}

fn plugin_set_priority(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: PriorityParams = parse_params(params)?;
    let store = require_store(ctx)?;

    if !store.set_plugin_priority(&params.id, params.priority)? {
        return Err(CoreError::not_found(format!("插件未安装：{}", params.id)));
    }
    Ok(serde_json::Value::Null)
}

/// 数据库不可用时明确失败：插件状态以库为准，没有库就不能假装装上了。
fn require_store(ctx: &CoreContext) -> Fallible<&Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写插件状态").with_details(
            serde_json::json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

/// 插件摘要：契约里的 `PluginSummary`（前端列表与同意界面都用它）。
fn plugin_summary(record: &InstalledPlugin) -> serde_json::Value {
    let manifest = &record.manifest;
    let origin = match record.origin_kind.as_str() {
        "url" => serde_json::json!({ "kind": "url", "url": record.origin_value }),
        "catalog" => {
            // origin_value 形如 `<subscriptionId>::<fileName>`
            let (subscription_id, file_name) =
                record.origin_value.split_once("::").unwrap_or((record.origin_value.as_str(), ""));
            serde_json::json!({
                "kind": "catalog", "subscriptionId": subscription_id, "fileName": file_name
            })
        }
        "paste" => serde_json::json!({ "kind": "paste" }),
        other => serde_json::json!({ "kind": other, "path": record.origin_value }),
    };

    serde_json::json!({
        "id": manifest.id,
        "name": manifest.name,
        "version": manifest.version,
        "author": manifest.author,
        "description": manifest.description,
        "homepage": manifest.homepage,
        // 我们不内置任何插件（ADR-0005），因此这里恒为 false
        "builtin": false,
        "enabled": record.enabled,
        "priority": record.priority,
        "manifest": manifest,
        "origin": origin,
        "sha256": record.sha256,
    })
}

/// `plugin.reload`：把插件装进沙箱并**真实探测能力**，然后把探测结果写回清单快照。
///
/// 这也是「插件首次可用」的入口：安装只落盘，真正建运行时（QuickJS）发生在这里。
/// 探测优先于安装期的静态预扫描——例如 `const getLyric = async () => {}` 这种写法
/// 静态扫描找不到，但运行时能认出来。
fn plugin_reload(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: ReloadParams = parse_params(params)?;
    let store = require_store(ctx)?;

    let record = store
        .get_plugin(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{}", params.id)))?;

    let capabilities = ctx.plugins.load(record.manifest.clone())?;

    let mut updated = record;
    updated.manifest.capabilities = capabilities;
    updated.updated_at = crate::store::now_millis();
    store.upsert_plugin(&updated)?;

    to_json(plugin_summary(&updated))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReloadParams {
    id: String,
}

// ---------------------------------------------------------------- 订阅与社区仓库

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionAddParams {
    url: String,
    name: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionIdParams {
    id: String,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CatalogListParams {
    subscription_id: Option<String>,
    query: Option<String>,
    tags: Option<Vec<String>>,
}

fn plugin_subscriptions_list(ctx: &CoreContext) -> Fallible<serde_json::Value> {
    to_json(require_store(ctx)?.list_subscriptions()?)
}

/// 添加订阅：登记后**立即尝试拉一次索引**。
/// 拉取失败不算添加失败——订阅仍然存在，只是带上 `lastError`（用户可在列表里看到并重试）。
fn plugin_subscriptions_add(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: SubscriptionAddParams = parse_params(params)?;
    validate_subscription_url(&params.url)?;
    let store = require_store(ctx)?;

    let id = subscription_id_for(&params.url);
    let name = params
        .name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_subscription_name(&params.url));
    store.add_subscription(&id, &name, &params.url)?;

    if let Err(err) = refresh_subscription(ctx, store, &id) {
        tracing::warn!(subscription = %id, %err, "订阅添加成功但首次刷新失败");
    }

    let record = store
        .get_subscription(&id)?
        .ok_or_else(|| CoreError::internal("订阅写入后读取失败"))?;
    to_json(record)
}

fn plugin_subscriptions_remove(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: SubscriptionIdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    if !store.remove_subscription(&params.id)? {
        return Err(CoreError::not_found(format!("订阅不存在：{}", params.id)));
    }
    // 缓存索引一并清掉（否则删了订阅还能看到条目）
    let _ = std::fs::remove_file(index_cache_path(ctx, &params.id));
    Ok(serde_json::Value::Null)
}

fn plugin_subscriptions_refresh(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: SubscriptionIdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    to_json(refresh_subscription(ctx, store, &params.id)?)
}

/// 拉取并校验索引；成功写缓存，失败**保留旧索引**并记录原因（契约 §2）。
fn refresh_subscription(ctx: &CoreContext, store: &Store, id: &str) -> Fallible<Subscription> {
    let record = store
        .get_subscription(id)?
        .ok_or_else(|| CoreError::not_found(format!("订阅不存在：{id}")))?;

    let request = HttpRequest {
        method: "GET".into(),
        url: record.url.clone(),
        headers: vec![("accept".into(), "application/json".into())],
        body: None,
    };

    let response = ctx.http.send(&request).map_err(|err| {
        let _ = store.mark_subscription_error(id, &err.message);
        CoreError::new(
            ErrorCode::SubscriptionFetchFailed,
            format!("拉取订阅索引失败：{}", err.message),
        )
        .with_details(serde_json::json!({ "subscriptionId": id, "url": record.url }))
    })?;

    if response.truncated {
        let _ = store.mark_subscription_error(id, "索引超过体积上限");
        return Err(CoreError::new(ErrorCode::SubscriptionInvalidIndex, "索引超过体积上限"));
    }

    let index = parse_index(&response.body).map_err(|err| {
        // 把字段级细节也带上：用户需要知道索引「哪里」非法，而不是只有一句「包含非法条目」
        let _ = store.mark_subscription_error(id, &describe_error(&err));
        err
    })?;

    std::fs::create_dir_all(&ctx.paths.subscriptions)?;
    std::fs::write(index_cache_path(ctx, id), response.body.as_bytes())?;
    store.mark_subscription_refreshed(id, index.sources.len() as i64)?;

    store
        .get_subscription(id)?
        .ok_or_else(|| CoreError::internal("订阅刷新后读取失败"))
}

/// 订阅内可安装条目 + 本地安装状态。
fn plugin_catalog_list(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: CatalogListParams = parse_params(params).unwrap_or_default();
    let store = require_store(ctx)?;
    let installed = store.list_plugins()?;
    let mut entries: Vec<CatalogEntry> = Vec::new();

    for subscription in store.list_subscriptions()? {
        if let Some(filter) = &params.subscription_id {
            if filter != &subscription.id {
                continue;
            }
        }
        // 未刷新过的订阅没有缓存：跳过（列表里由 lastError 提示）
        let Ok(text) = std::fs::read_to_string(index_cache_path(ctx, &subscription.id)) else {
            continue;
        };
        let Ok(index) = parse_index(&text) else { continue };

        for entry in index.sources {
            if let Some(query) = &params.query {
                let needle = query.to_lowercase();
                let haystack = format!("{} {} {}", entry.name, entry.author, entry.description).to_lowercase();
                if !needle.is_empty() && !haystack.contains(&needle) {
                    continue;
                }
            }
            if let Some(tags) = &params.tags {
                if !tags.is_empty() && !tags.iter().any(|tag| entry.tags.contains(tag)) {
                    continue;
                }
            }

            let origin_value = format!("{}::{}", subscription.id, entry.file_name);
            let installed_record = installed
                .iter()
                .find(|record| record.origin_kind == "catalog" && record.origin_value == origin_value);
            entries.push(CatalogEntry {
                installed: installed_record.is_some(),
                update_available: installed_record
                    .map(|record| record.manifest.version != entry.version)
                    .unwrap_or(false),
                subscription_id: subscription.id.clone(),
                subscription_name: index.name.clone(),
                entry,
            });
        }
    }

    to_json(entries)
}

/// 下载订阅条目并校验 sha256（有则校验，缺则记录提示）。
fn download_catalog_entry(
    ctx: &CoreContext,
    subscription_id: &str,
    file_name: &str,
) -> Fallible<(crate::plugin::SubscriptionSourceEntry, Vec<u8>)> {
    let store = require_store(ctx)?;
    if store.get_subscription(subscription_id)?.is_none() {
        return Err(CoreError::not_found(format!("订阅不存在：{subscription_id}")));
    }

    let text = std::fs::read_to_string(index_cache_path(ctx, subscription_id)).map_err(|_| {
        CoreError::new(ErrorCode::SubscriptionFetchFailed, "订阅索引尚未刷新，请先 refresh")
            .with_details(serde_json::json!({ "subscriptionId": subscription_id }))
    })?;
    let index = parse_index(&text)?;
    let entry = index
        .find(file_name)
        .ok_or_else(|| CoreError::not_found(format!("索引里没有该文件：{file_name}")))?
        .clone();

    let response = ctx.http.send(&HttpRequest {
        method: "GET".into(),
        url: entry.download_url.clone(),
        headers: vec![],
        body: None,
    })?;
    if response.truncated {
        return Err(CoreError::new(ErrorCode::PluginImportFailed, "下载内容超过体积上限"));
    }

    let bytes = response.body.into_bytes();
    if let Some(expected) = &entry.sha256 {
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(CoreError::new(ErrorCode::PluginImportFailed, "校验和不匹配，已拒绝安装")
                .with_details(serde_json::json!({
                    "expected": expected, "actual": actual, "file": entry.file_name
                })));
        }
    } else {
        tracing::warn!(file = %entry.file_name, "订阅条目未提供 sha256，无法校验完整性");
    }

    Ok((entry, bytes))
}

/// 订阅地址校验：必须 HTTPS 且不得指向回环/内网（核心主动发起，防 SSRF）。
fn validate_subscription_url(url: &str) -> Fallible<()> {
    if !url.starts_with("https://") {
        return Err(CoreError::invalid_argument("订阅地址必须是 HTTPS"));
    }
    let host = crate::plugin::host_of(url)
        .ok_or_else(|| CoreError::invalid_argument("无法解析订阅地址的域名"))?;
    if is_private_host(&host) {
        return Err(CoreError::invalid_argument("订阅地址不得指向回环或内网地址")
            .with_details(serde_json::json!({ "host": host })));
    }
    Ok(())
}

/// 订阅 id 由 URL 派生（稳定且可复现，不需要 uuid 依赖）。
/// 把错误压成一行可展示的说明（带字段级细节，超长截断）。
fn describe_error(err: &CoreError) -> String {
    match &err.details {
        None => err.message.clone(),
        Some(details) => {
            let text = format!("{}（{details}）", err.message);
            if text.chars().count() > 300 {
                format!("{}…", text.chars().take(300).collect::<String>())
            } else {
                text
            }
        }
    }
}
fn subscription_id_for(url: &str) -> String {
    format!("sub-{}", &sha256_hex(url.as_bytes())[..12])
}

fn default_subscription_name(url: &str) -> String {
    crate::plugin::host_of(url).unwrap_or_else(|| "订阅".to_string())
}

fn index_cache_path(ctx: &CoreContext, id: &str) -> std::path::PathBuf {
    ctx.paths.subscriptions.join(format!("{id}.json"))
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
