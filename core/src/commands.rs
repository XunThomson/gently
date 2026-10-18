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
use serde_json::json;
use serde::Serialize;

use crate::contract::{
    command_count, is_known_command, CoreError, CoreResult, ErrorCode, Fallible, ImportSource,
    SystemCounts,
    SystemStatus, COMMAND_NAMES,
};
use crate::events::{EventSink, NullEventSink};
use crate::paths::AppPaths;
use crate::plugin::{
    apply_explicit_compat, extract_archive, is_private_host, is_valid_host, parse_index,
    parse_manifest_json, parse_source_compat, sha256_hex, ArchiveShape, BlockingHttp, CatalogEntry,
    HostLimits, HttpLimits, HttpRequest, HttpTransport, InstallSource, InstalledPlugin,
    CredentialStore, MemoryCredentialStore, ParsedPlugin, PluginHost, Subscription,
    MAX_SOURCE_BYTES,
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
    /// 流式搜索的取消登记表
    pub searches: Arc<crate::catalog::SearchRegistry>,
    /// 插件原始条目的进程内快照（播放解析要把插件自己的条目原样交回插件，见 `ItemSnapshots`）
    pub snapshots: Arc<crate::catalog::ItemSnapshots>,
    /// 下载任务的控制登记表（暂停/取消标志）
    pub downloads: Arc<crate::download::DownloadRegistry>,
    /// 播放缓存补全的登记表（防重复下载同一首、限制并发）
    pub cache_fills: Arc<crate::cache::CacheRegistry>,
    /// 第三方授权流程的登记表（进行中的回调监听，便于取消）
    pub oauth: Arc<crate::oauth::AuthRegistry>,
    /// 本地流代理（仅回环 + 一次性令牌；契约 §7）
    pub streams: Arc<crate::media::StreamRegistry>,
    pub events: Arc<dyn EventSink>,
}

impl CoreContext {
    pub fn new(paths: AppPaths) -> Self {
        let http: Arc<dyn HttpTransport> = Arc::new(BlockingHttp::new(HttpLimits::default()));
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::new());
        let plugins = Arc::new(
            PluginHost::new(
                paths.clone(),
                Arc::clone(&http),
                Arc::clone(&credentials),
                HostLimits::default(),
            )
            .with_oauth_token(crate::oauth::token_provider(credentials, Arc::clone(&http))),
        );
        // 内嵌封面缓存目录：扫描时把图片落在这里，列表给回环地址（`/cover/<name>`）
        let covers_dir = paths.cache.join("covers");
        let streams = Arc::new(crate::media::StreamRegistry::default());
        streams.set_covers_dir(covers_dir);
        Self {
            paths,
            store: None,
            store_error: None,
            plugin_runtime: "quickjs",
            plugins,
            http,
            searches: Arc::new(crate::catalog::SearchRegistry::default()),
            snapshots: Arc::new(crate::catalog::ItemSnapshots::default()),
            downloads: Arc::new(crate::download::DownloadRegistry::default()),
            cache_fills: Arc::new(crate::cache::CacheRegistry::default()),
            oauth: Arc::new(crate::oauth::AuthRegistry::default()),
            streams,
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

    /// 换成自定义出网实现（测试、离线模式）。
    ///
    /// 插件宿主与核心自身的出网必须**共用同一个实现**：只改 `ctx.http` 不会影响已经建好的
    /// 插件宿主——那样测试会以为「禁止出网」，插件却仍在打真实网络（这个坑踩过一次，
    /// 所以入口做成方法而不是裸字段赋值）。
    pub fn with_http(mut self, http: Arc<dyn HttpTransport>) -> Self {
        self.http = Arc::clone(&http);
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::new());
        self.plugins = Arc::new(
            PluginHost::new(
                self.paths.clone(),
                Arc::clone(&http),
                Arc::clone(&credentials),
                HostLimits::default(),
            )
            .with_oauth_token(crate::oauth::token_provider(credentials, Arc::clone(&http))),
        );
        self
    }

    /// 换成指定凭据存储（宿主与命令层共用）。
    ///
    /// 桌面端用系统凭据库（[`crate::plugin::open_store`]），测试与降级场景用内存实现：
    /// **默认是内存**，因此单元/集成测试不会往用户的凭据库里写东西。
    pub fn with_credentials(mut self, credentials: Arc<dyn CredentialStore>) -> Self {
        // 与 `with_http` 同因：宿主是单独构造的，换存储必须重建宿主
        let http = Arc::clone(&self.http);
        self.plugins = Arc::new(
            PluginHost::new(
                self.paths.clone(),
                Arc::clone(&http),
                Arc::clone(&credentials),
                HostLimits::default(),
            )
            .with_oauth_token(crate::oauth::token_provider(credentials, http)),
        );
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
        "system.cacheStatus" => cache_status(ctx, params),
        "system.cacheClear" => cache_clear(ctx, params),
        "system.cacheConfig" => cache_config(ctx, params),
        "plugin.preview" => plugin_preview(ctx, params),
        "plugin.import" => plugin_import(ctx, params),
        "plugin.list" => plugin_list(ctx),
        "plugin.remove" => plugin_remove(ctx, params),
        "plugin.setEnabled" => plugin_set_enabled(ctx, params),
        "plugin.setPriority" => plugin_set_priority(ctx, params),
        "plugin.reload" => plugin_reload(ctx, params),
        "plugin.compat.observed" => plugin_compat_observed(ctx, params),
        "plugin.compat.confirm" => plugin_compat_confirm(ctx, params),
        "plugin.subscriptions.list" => plugin_subscriptions_list(ctx),
        "plugin.subscriptions.add" => plugin_subscriptions_add(ctx, params),
        "plugin.subscriptions.remove" => plugin_subscriptions_remove(ctx, params),
        "plugin.subscriptions.refresh" => plugin_subscriptions_refresh(ctx, params),
        "plugin.catalog.list" => plugin_catalog_list(ctx, params),
        "catalog.track" => crate::catalog_detail::track(ctx, params),
        "catalog.album" => crate::catalog_detail::album(ctx, params),
        "catalog.playlist" => crate::catalog_detail::playlist(ctx, params),
        "catalog.topLists" => crate::catalog_detail::top_lists(ctx, params),
        "catalog.topList" => crate::catalog_detail::top_list(ctx, params),
        "catalog.recommend" => crate::catalog_detail::recommend(ctx, params),
        "catalog.favorites" => crate::catalog_detail::favorites(ctx, params),
        "catalog.favoriteCollections" => crate::catalog_detail::favorite_collections(ctx, params),
        "catalog.lyrics" => crate::catalog_detail::lyrics(ctx, params),
        "catalog.lyricsSearch" => crate::catalog_detail::lyrics_search(ctx, params),
        "catalog.loginQr" => crate::login_qr::login_qr(ctx, params),
        "catalog.loginQrPoll" => crate::login_qr::login_qr_poll(ctx, params),
        "library.favorites.list" => crate::library::favorites_list(ctx, params),
        "library.favorites.set" => crate::library::favorites_set(ctx, params),
        "library.playlists.list" => crate::library::playlists_list(ctx, params),
        "library.playlists.save" => crate::library::playlists_save(ctx, params),
        "library.playlists.delete" => crate::library::playlists_delete(ctx, params),
        "library.history.list" => crate::library::history_list(ctx, params),
        "library.history.push" => crate::library::history_push(ctx, params),
        "library.history.clear" => crate::library::history_clear(ctx, params),
        "library.local.scan" => crate::local_library::scan(ctx, params),
        "library.local.list" => crate::local_library::list(ctx, params),
        "library.local.remove" => crate::local_library::remove(ctx, params),
        "download.list" => crate::download::list(ctx, params),
        "download.create" => crate::download::create(ctx, params),
        "download.pause" => crate::download::pause(ctx, params),
        "download.resume" => crate::download::resume(ctx, params),
        "download.remove" => crate::download::remove(ctx, params),
        "download.clearFinished" => crate::download::clear_finished(ctx, params),
        "skin.list" => crate::skin::list(ctx, params),
        "skin.preview" => crate::skin::preview(ctx, params),
        "skin.install" => crate::skin::install(ctx, params),
        "skin.remove" => crate::skin::remove(ctx, params),
        "skin.setActive" => crate::skin::set_active(ctx, params),
        "skin.export" => crate::skin::export(ctx, params),
        "recommend.home" => crate::recommend::home(ctx, params),
        "recommend.similar" => crate::recommend::similar(ctx, params),
        "recommend.feedback" => crate::recommend::feedback(ctx, params),
        "plugin.checkUpdate" => crate::plugin_admin::check_update(ctx, params),
        "plugin.config.get" => crate::plugin_admin::config_get(ctx, params),
        "plugin.config.put" => crate::plugin_admin::config_put(ctx, params),
        "plugin.credentials.set" => crate::plugin_admin::credentials_set(ctx, params),
        "plugin.credentials.clear" => crate::plugin_admin::credentials_clear(ctx, params),
        "plugin.credentials.status" => crate::plugin_admin::credentials_status(ctx, params),
        "auth.status" => crate::oauth::status(ctx, params),
        "auth.begin" => crate::oauth::begin(ctx, params),
        "auth.cancel" => crate::oauth::cancel(ctx, params),
        "auth.signOut" => crate::oauth::sign_out(ctx, params),
        "catalog.search" => catalog_search(ctx, params),
        "catalog.searchCancel" => catalog_search_cancel(ctx, params),
        "playback.resolve" => playback_resolve(ctx, params),
        "playback.report" => playback_report(ctx, params),
        // 其余命令：契约已登记，实现在后续里程碑接入
        other => Err(CoreError::not_implemented(other)),
    };

    // 分发日志：既是最低成本的链路可观测性（能确认前端确实调到了核心），
    // 也是排查「前端报错但核心没收到」这类问题的第一手证据。
    // 失败时**连错误码与说明一起记**：只写 `ok=false` 会把「插件没装」和「插件跑挂了」
    // 混成一行，用户拿着日志也判断不出原因（真实排查时踩到过）。
    match &outcome {
        Ok(_) => tracing::debug!(command, ok = true, "dispatch"),
        Err(err) => tracing::warn!(
            command,
            ok = false,
            code = err.code.as_str(),
            message = %err.message,
            "dispatch",
        ),
    }

    CoreResult::from(outcome)
}

/// M1 已实现的命令（诊断用；插件域随里程碑逐步点亮）。
const IMPLEMENTED: &[&str] = &[
    "system.status",
    "system.paths",
    "system.reveal",
    "system.cacheStatus",
    "system.cacheClear",
    "system.cacheConfig",
    "plugin.preview",
    "plugin.import",
    "plugin.list",
    "plugin.remove",
    "plugin.setEnabled",
    "plugin.setPriority",
    "plugin.reload",
    "plugin.compat.observed",
    "plugin.compat.confirm",
    "plugin.subscriptions.list",
    "plugin.subscriptions.add",
    "plugin.subscriptions.remove",
    "plugin.subscriptions.refresh",
    "plugin.catalog.list",
    "library.favorites.list",
    "library.favorites.set",
    "library.playlists.list",
    "library.playlists.save",
    "library.playlists.delete",
    "library.history.list",
    "library.history.push",
    "library.history.clear",
    "library.local.scan",
    "library.local.list",
    "library.local.remove",
    "download.list",
    "download.create",
    "download.pause",
    "download.resume",
    "download.remove",
    "download.clearFinished",
    "skin.list",
    "skin.preview",
    "skin.install",
    "skin.remove",
    "skin.setActive",
    "skin.export",
    "recommend.home",
    "recommend.similar",
    "recommend.feedback",
    "plugin.checkUpdate",
    "plugin.config.get",
    "plugin.config.put",
    "plugin.credentials.set",
    "plugin.credentials.clear",
    "plugin.credentials.status",
    "auth.status",
    "auth.begin",
    "auth.cancel",
    "auth.signOut",
    "catalog.search",
    "catalog.searchCancel",
    "catalog.track",
    "catalog.album",
    "catalog.playlist",
    "catalog.topLists",
    "catalog.topList",
    "catalog.recommend",
    "catalog.favorites",
    "catalog.favoriteCollections",
    "catalog.lyrics",
    "catalog.lyricsSearch",
    "playback.resolve",
    "playback.report",
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
        credentials_backend: ctx.plugins.credentials().backend().to_string(),
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

/// `system.cacheStatus`：播放缓存 / 歌词与详情缓存 / 封面缓存的占用（设置页展示用）。
fn cache_status(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let _ = parse_params::<serde_json::Value>(params)?;
    Ok(crate::cache::status(&ctx.paths))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheClearParams {
    /// `media` / `catalog`（歌词与详情）/ `covers` / `all`（缺省）
    #[serde(default)]
    kind: Option<String>,
}

/// `system.cacheConfig{limitBytes}`：设置播放缓存的总量上限（第 70 条命令）。
///
/// 为什么单独一条命令而不是塞进 `cacheStatus`：**读**与**写**必须分开——
/// 界面每次刷新都调 status，如果它能写，一次参数错误就能改掉用户的设置。
fn cache_config(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CacheConfigParams {
        limit_bytes: u64,
    }
    let params: CacheConfigParams = parse_params(params)?;
    crate::cache::set_limit(&ctx.paths, params.limit_bytes)
}

/// `system.cacheClear{kind?}`：删除缓存（缓存可随时整目录删除，契约 §9）。
fn cache_clear(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: CacheClearParams = parse_params(params)?;
    crate::cache::clear(&ctx.paths, params.kind.as_deref().unwrap_or("all"))
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
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // 目录直接打开；文件用 /select 在父目录里高亮。
    //
    // 三个必须踩准的点（R66 修了前两个，R68 修第三个）：
    // 1. **分隔符必须是反斜杠**：`system.paths` 回给前端的路径是 `F:/a/b`（正斜杠，见
    //    `paths::to_dto`），前端原样传回来；`explorer "F:/a/b"` 会解析失败并**默默打开
    //    默认文件夹**（用户看到的症状是「打开的不是数据目录」）；
    // 2. `/select,` 后面的路径**要带引号**：带空格的路径（`C:\Users\Xun\AppData\...`）很常见，
    //    不加引号会被 explorer 截断；
    // 3. 拼好的这**一个**参数必须用 `raw_arg` 原样塞进命令行。用 `arg` 的话 Rust 会按 CRT
    //    规则再补一层引号，`/select,"<路径>"` 变成「被引号包住的带引号字符串」，explorer
    //    解析失败后同样默默打开默认文件夹（R68 实测：点「导出皮肤」跳出来的是「桌面」）。
    //    目录那种不带引号的参数碰不到这条，所以 R66 的目录用例一直是通的。
    let arg = reveal_arg(path.is_dir(), &path.to_string_lossy());
    Command::new("explorer").raw_arg(arg).spawn()?;
    Ok(())
}

/// 拼 `explorer` 的参数（**纯函数**，测试盯着这一份实现）。
///
/// 输入是任意分隔符的路径（前端回传的就是 `F:/...`），输出是 explorer 认的那一个参数。
#[cfg(any(target_os = "windows", test))]
fn reveal_arg(is_dir: bool, path: &str) -> String {
    let native = path.replace('/', "\\");
    if is_dir {
        native
    } else {
        format!("/select,\"{native}\"")
    }
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
struct PreviewParams {
    from: ImportSource,
    /// 用户显式开启的兼容模式（ADR-0006）：源码没有头部元数据时，用只读探测合成清单。
    /// 默认关闭——兼容插件的权限弱于自有 ABI，必须由用户主动选择。
    #[serde(default)]
    compat: bool,
}

/// `plugin.preview`：**读清楚但不落盘**（兼容模式会在沙箱里只读执行一次源码）。
///
/// 这是安装链路的第一步，也是权限同意的依据：清单、权限、凭据需求与警告都在这里产出。
fn plugin_preview(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: PreviewParams = parse_params(params)?;
    let compat = params.compat;

    let parsed = match params.from {
        ImportSource::Paste { content } => {
            if content.len() as u64 > MAX_SOURCE_BYTES {
                return Err(too_large(content.len() as u64));
            }
            parse_source_compat(&content, compat)?
        }
        ImportSource::File { path } => {
            // 读文件是用户的显式动作，因此不限制目录；但限制体积（插件是脚本）
            let meta = std::fs::metadata(&path)?;
            if meta.len() > MAX_SOURCE_BYTES {
                return Err(too_large(meta.len()));
            }
            let content = std::fs::read_to_string(&path)?;
            parse_source_compat(&content, compat)?
        }
        ImportSource::Dir { path } => parse_dir_package(std::path::Path::new(&path), compat)?,
        ImportSource::Archive { path } => {
            // 解压到系统临时目录：预览**只读不落盘**，不能污染插件目录
            let temp = temp_extract_dir("preview")?;
            let result = (|| {
                match extract_archive(std::path::Path::new(&path), &temp)? {
                    ArchiveShape::Dir => parse_dir_package(&temp, compat),
                    ArchiveShape::Single(name) => {
                        let text = std::fs::read_to_string(temp.join(&name))?;
                        parse_source_compat(&text, compat)
                    }
                }
            })();
            let _ = std::fs::remove_dir_all(&temp);
            result?
        }
        ImportSource::Url { url } => {
            let bytes = download_url(ctx, &url)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                CoreError::new(ErrorCode::PluginInvalidSource, "下载的插件不是 UTF-8 文本")
            })?;
            parse_source_compat(&text, compat)?
        }
        ImportSource::Catalog { subscription_id, file_name } => {
            // 预览同样要下载内容（否则无法给出真实清单），但仍**只读不写**
            let (_, bytes) = download_catalog_entry(ctx, &subscription_id, &file_name)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                CoreError::new(ErrorCode::PluginInvalidSource, "下载的插件不是 UTF-8 文本")
            })?;
            parse_source_compat(&text, compat)?
        }
    };

    let manifest = parsed.manifest;
    // 同 id 是否已存在：M1a 直接看插件目录（安装目录按 id 命名），M1b 起改为读 plugin_state 表
    let replaces_existing = ctx.paths.plugins.join(&manifest.id).exists();

    to_json(serde_json::json!({
        // `compat` 单独给一份：界面必须明示「权限弱于自有 ABI」，不能只靠 warnings 里的中文
        "compat": manifest.compat,
        // 第三方授权同样单独给：同意安装前要让用户看到「浏览器会被带去哪个域名」
        "oauth": manifest.oauth,
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

/// 目录包（或压缩包解出来的目录）→ 清单。预览与安装共用同一套解析与校验。
fn parse_dir_package(dir: &std::path::Path, compat: bool) -> Fallible<ParsedPlugin> {
    let manifest_path = dir.join("plugin.json");
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
        .and_then(|entry| std::fs::read_to_string(dir.join(entry)).ok());
    let mut parsed = parse_manifest_json(&json, entry_source.as_deref())?;
    // 目录包清单一定完整，但用户可能显式选了兼容模式（作者没写 @compat）
    if compat {
        apply_explicit_compat(&mut parsed);
    }
    Ok(parsed)
}

/// 预览压缩包用的临时目录（唯一名，用完即删）。
fn temp_extract_dir(tag: &str) -> Fallible<std::path::PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("gently-plugin-{tag}-{stamp}"));
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[derive(Debug, serde::Deserialize)]
struct ImportParams {
    from: ImportSource,
    /// 必须是字面量 `true`：安装是不可逆的落盘动作，必须由用户显式同意。
    #[serde(default)]
    consent: bool,
    /// 用户显式开启的兼容模式（ADR-0006）：与 `plugin.preview` 的同名参数一致，
    /// 因为安装会**从暂存副本重新解析**清单，两侧口径必须相同。
    #[serde(default)]
    compat: bool,
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
    let compat = params.compat;

    // 订阅条目需要先把内容下载下来（字节必须活到 install 调用结束，因此单独一条分支）
    let outcome = match &params.from {
        ImportSource::Catalog { subscription_id, file_name } => {
            let (_, bytes) = download_catalog_entry(ctx, subscription_id, file_name)?;
            crate::plugin::install(
                &ctx.paths,
                InstallSource::Bytes {
                    origin_kind: "catalog",
                    // 用 `::` 拼接订阅 id 与文件名：catalog.list 据此判断「某条索引是否已安装」
                    origin_value: format!("{subscription_id}::{file_name}"),
                    content: &bytes,
                },
                compat,
            )?
        }
        // URL 直链同样要先下载（字节必须活到 install 调用结束）
        ImportSource::Url { url } => {
            let bytes = download_url(ctx, url)?;
            crate::plugin::install(
                &ctx.paths,
                InstallSource::Bytes {
                    origin_kind: "url",
                    origin_value: url.clone(),
                    content: &bytes,
                },
                compat,
            )?
        }
        other => {
            let source = match other {
                ImportSource::Paste { content } => InstallSource::Paste(content),
                ImportSource::File { path } => InstallSource::File(std::path::Path::new(path)),
                ImportSource::Dir { path } => InstallSource::Dir(std::path::Path::new(path)),
                ImportSource::Archive { path } => InstallSource::Archive(std::path::Path::new(path)),
                ImportSource::Url { .. } | ImportSource::Catalog { .. } => {
                    unreachable!("下载类来源已在上方分支处理")
                }
            };
            crate::plugin::install(&ctx.paths, source, compat)?
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
    // 观测台账属于这个插件：无论是否删文件都清掉，避免下次装同 id 的插件继承旧域名
    ctx.plugins.clear_observed_hosts(&params.id);
    ctx.plugins.unload(&params.id);
    Ok(serde_json::Value::Null)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatIdParams {
    id: String,
}

/// `plugin.compat.observed`：兼容插件在兼容模式下**实际访问过**的域名（TOFU 收敛的依据）。
///
/// 不是兼容插件时返回 `compat: false` 与空列表，而不是报错——「没有可收敛的东西」不是异常。
fn plugin_compat_observed(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: CompatIdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let record = store
        .get_plugin(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{}", params.id)))?;

    to_json(serde_json::json!({
        "pluginId": params.id,
        "compat": record.manifest.compat,
        "whitelist": record.manifest.hosts,
        "hosts": ctx.plugins.observed_hosts(&params.id),
    }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatConfirmParams {
    id: String,
    /// 要固化的域名（来自 `plugin.compat.observed`）
    hosts: Vec<String>,
    /// 收窄权限同样要用户显式同意：可能让插件从此访问不了别的域名
    #[serde(default)]
    consent: bool,
}

/// `plugin.compat.confirm`：把观测到的域名固化成 `hosts` 白名单，**并关闭兼容模式**。
///
/// 为什么必须关兼容模式：兼容分支在权限检查里先于白名单，只写 `hosts` 而不关兼容模式
/// 等于什么都没做（白名单永远不会被查）。收敛之后插件回到「声明式白名单」的严格模型；
/// 想恢复兼容模式只能重新导入并勾选兼容模式（这是**收窄**动作，方向不可逆）。
fn plugin_compat_confirm(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: CompatConfirmParams = parse_params(params)?;
    if !params.consent {
        return Err(CoreError::invalid_argument(
            "收敛权限需要用户显式同意（consent 必须为 true）",
        ));
    }
    if params.hosts.is_empty() {
        return Err(CoreError::invalid_argument(
            "至少要固化一个域名；若列表为空，说明该插件还没有成功出网过",
        ));
    }

    let store = require_store(ctx)?;
    let mut record = store
        .get_plugin(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{}", params.id)))?;
    if !record.manifest.compat {
        return Err(CoreError::invalid_argument(format!(
            "插件不是兼容模式，无需收敛：{}",
            params.id
        )));
    }

    // 只接受**观测到的**合法域名：白名单不能凭空写进来（否则这个命令就成了提权入口）
    let observed: Vec<String> =
        ctx.plugins.observed_hosts(&params.id).into_iter().map(|use_| use_.host).collect();
    let mut hosts: Vec<String> = Vec::new();
    for candidate in &params.hosts {
        let host = candidate.trim().to_ascii_lowercase();
        if !is_valid_host(&host) {
            return Err(CoreError::invalid_argument(format!("不是合法的域名：{candidate}"))
                .with_details(serde_json::json!({ "host": candidate })));
        }
        if !observed.contains(&host) {
            return Err(CoreError::invalid_argument(format!(
                "域名 {host} 不在观测记录里，不能写进白名单"
            ))
            .with_details(serde_json::json!({ "host": host, "observed": observed })));
        }
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }

    record.manifest.hosts = hosts;
    record.manifest.compat = false;
    record.updated_at = crate::store::now_millis();
    store.upsert_plugin(&record)?;

    // 运行时里还挂着旧的（compat = true）清单：卸载掉，下次使用时按新清单重新加载。
    // 刻意不在这里 reload——改权限的命令不该顺手执行插件代码。
    ctx.plugins.unload(&params.id);
    ctx.plugins.clear_observed_hosts(&params.id);

    tracing::info!(plugin = %params.id, hosts = ?record.manifest.hosts, "兼容模式已收敛为域名白名单");
    to_json(plugin_summary(&record))
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
        // 兼容模式：界面据此打标记并明示「权限弱于自有 ABI」（ADR-0006）
        "compat": manifest.compat,
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

// ---------------------------------------------------------------- 曲库搜索（流式）

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSearchParams {
    keyword: String,
    #[serde(default)]
    sources: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<usize>,
}

fn catalog_search(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: CatalogSearchParams = parse_params(params)?;
    let limit = params.limit.unwrap_or(30).clamp(1, 100);
    crate::catalog::search(ctx, &params.keyword, params.sources, limit)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCancelParams {
    search_id: String,
}

fn catalog_search_cancel(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: SearchCancelParams = parse_params(params)?;
    crate::catalog::cancel(ctx, &params.search_id)?;
    Ok(serde_json::Value::Null)
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

/// 下载一个 URL 直链（`{kind:'url'}` 导入用）。
///
/// 与订阅下载同样的约束：**仅 HTTPS、不得指向回环/内网**（用户填的地址也要防 SSRF）。
pub(crate) fn download_url_checked(ctx: &CoreContext, url: &str) -> Fallible<Vec<u8>> {
    download_url(ctx, url)
}

fn download_url(ctx: &CoreContext, url: &str) -> Fallible<Vec<u8>> {
    if !url.starts_with("https://") {
        return Err(CoreError::invalid_argument("插件地址必须是 HTTPS"));
    }
    let host = crate::plugin::host_of(url)
        .ok_or_else(|| CoreError::invalid_argument("无法解析插件地址的域名"))?;
    if is_private_host(&host) {
        return Err(CoreError::invalid_argument("插件地址不得指向回环或内网地址")
            .with_details(serde_json::json!({ "host": host })));
    }

    let response = ctx.http.send(&HttpRequest {
        method: "GET".into(),
        url: url.to_string(),
        headers: vec![],
        body: None,
    })?;
    if response.truncated {
        return Err(CoreError::new(ErrorCode::PluginImportFailed, "下载内容超过体积上限"));
    }
    Ok(response.body.into_bytes())
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
// ---------------------------------------------------------------- 播放（候选回退 + 流代理）

/// 本地曲库的来源标识：`local:<绝对路径>`（id 由路径派生，见 `local_library`）。
///
/// 播放时它**不经插件**，直接走回环流代理——本地文件与远端媒体共用一条通道。
const LOCAL_SOURCE: &str = "local";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveParams {
    /// 统一曲目引用 `source:rawId`。
    ///
    /// **同时接受 `ref`（契约里的名字）与 `reference`**：早期实现只认后者，而契约与其它
    /// 命令写的是 `ref`——参数名不一致的代价是调用方收到一句「缺字段」，
    /// 而真实原因只是名字不同（整链路测试就是为了照出这类错）。
    #[serde(rename = "ref", alias = "reference")]
    reference: String,
    quality: String,
    /// 用户偏好的音源顺序（可选）
    #[serde(default)]
    preferred_sources: Option<Vec<String>>,
    /// 候选引用列表（来自搜索结果）：给定时核心按优先级依次回退
    #[serde(default)]
    candidates: Option<Vec<String>>,
    /// 交给插件的曲目对象（MusicFree 风格插件需要原始字段，如 bvid/aid）
    #[serde(default)]
    track: Option<serde_json::Value>,
}

/// `playback.resolve`：按候选顺序依次尝试，全部失败返回 **`data: null`**（不是错误）。
///
/// 契约里的承诺：候选顺序即回退顺序；`null` 让前端退回模拟时钟。
fn playback_resolve(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: ResolveParams = parse_params(params)?;
    crate::catalog::ensure_loaded(ctx)?;

    for reference in candidate_order(ctx, &params) {
        let (source, raw_id) = match reference.split_once(':') {
            Some(parts) => parts,
            None => continue,
        };

        /* 缓存优先：命中就直接把本地文件发布到同一条回环代理。
           放在插件解析**之前**，因此断网或插件被卸载时也能播已经缓存过的那首。 */
        if source != LOCAL_SOURCE {
            let exact = crate::cache::lookup_exact(
                &ctx.paths,
                &crate::cache::media_key(&reference, &params.quality),
            );
            if let Some(hit) = exact.or_else(|| crate::cache::lookup_any(&ctx.paths, &reference)) {
                match ctx.streams.publish_local(&hit.path) {
                    Ok(stream_url) => {
                        let quality =
                            if hit.quality.is_empty() { params.quality.clone() } else { hit.quality };
                        tracing::debug!(source, quality = %quality, "播放命中本地缓存");
                        return to_json(json!({
                            "source": source,
                            "quality": quality,
                            "streamUrl": stream_url,
                            "originUrl": "",
                            "headers": {},
                            "expiresInSec": 1800,
                            "fromCache": true,
                        }));
                    }
                    Err(error) => {
                        // 缓存文件坏了/被删了：不能因此播不了，继续走插件解析
                        tracing::warn!(code = error.code.as_str(), "缓存文件不可播：{}", error.message);
                    }
                }
            }
        }

        // 本地曲目：不经插件，直接把文件发布到**同一条回环代理**上
        // （前端因此只有一条播放路径：Range/拖动进度、无 Blob hack）
        if source == LOCAL_SOURCE {
            let path = std::path::Path::new(raw_id);
            match ctx.streams.publish_local(path) {
                Ok(stream_url) => {
                    return to_json(json!({
                        "source": LOCAL_SOURCE,
                        "quality": params.quality,
                        "streamUrl": stream_url,
                        "originUrl": raw_id,
                        "headers": {},
                        "mimeType": std::path::Path::new(raw_id)
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| format!("audio/{}", ext.to_ascii_lowercase())),
                        "expiresInSec": 1800,
                    }));
                }
                Err(error) => {
                    // 文件被删/被移走：当作该候选不可播，继续试下一个（契约：不弹错）
                    tracing::warn!(path = raw_id, code = error.code.as_str(), "本地文件不可播：{}", error.message);
                    continue;
                }
            }
        }

        let Some(capabilities) = ctx.plugins.capabilities(source) else { continue };
        if !capabilities.contains(&crate::plugin::PluginCapability::GetMediaSource) {
            continue;
        }

        /* 以库里的状态为准：用户刚点了「停用」，这次播放就不该再走它
           （与搜索的「禁用立即生效」一致；缓存命中的分支在上面，不受影响）。 */
        if let Some(store) = ctx.store.as_ref() {
            if let Ok(Some(record)) = store.get_plugin(source) {
                if !record.enabled {
                    tracing::debug!(source, "插件已停用，跳过该候选");
                    continue;
                }
            }
        }

        // 插件看到的曲目对象：优先用**插件自己产出过的原始条目**（归一化时留下的快照，字段最全），
        // 其次用前端给的快照，最后退化成最小对象。
        // 为什么快照优先：MusicFree 生态的 `getMediaSource(musicItem)` 要读 bvid/aid/cid 这类
        // 源内字段，而契约只把 `source:rawId` 交给前端——只传最小对象的话，真实插件一播就报错（R53 实测）。
        let track = ctx
            .snapshots
            .get(source, raw_id)
            .or_else(|| params.track.clone())
            .unwrap_or_else(|| json!({ "id": raw_id, "source": source }));
        let args = json!([track, params.quality]).to_string();

        let raw = match ctx.plugins.call(source, "getMediaSource", &args) {
            Ok(raw) => raw,
            Err(error) => {
                // 单个源失败不是终点：继续试下一个候选（对应契约的「不要提示用户，切换音源」）
                tracing::warn!(source, code = error.code.as_str(), "解析播放地址失败，尝试下一个候选");
                continue;
            }
        };

        let Ok(Some(media)) = crate::media::parse_media(&raw) else {
            continue; // null / 字段不合法 = 该源不可播
        };

        // SSRF 防护 + 发布流令牌（地址由上游给出，不受 @hosts 约束，必须在这里拦）
        let stream_url = match ctx.streams.publish(&media.url, media.headers.clone()) {
            Ok(url) => url,
            Err(error) => {
                tracing::warn!(source, code = error.code.as_str(), "媒体地址被拒：{}", error.message);
                continue;
            }
        };

        let quality = media.quality.unwrap_or_else(|| params.quality.clone());

        /* 播放成功后在后台把这首歌补进缓存（只缓存用户真的播放过的）。
           失败只记 debug 日志，不影响本次播放。 */
        crate::cache::spawn_fill(
            ctx,
            reference.clone(),
            quality.clone(),
            source.to_string(),
            media.url.clone(),
            media.headers.clone(),
        );

        return to_json(json!({
            "source": source,
            "quality": quality,
            // 前端只应使用 streamUrl；originUrl/headers 仅供展示与排障
            "streamUrl": stream_url,
            "originUrl": media.url,
            "headers": media.headers.iter().map(|(name, value)| (name.clone(), json!(value))).collect::<serde_json::Map<String, serde_json::Value>>(),
            "mimeType": media.mime_type,
            "expiresInSec": media.expires_in_sec.unwrap_or(1800),
        }));
    }

    // 契约：全部候选失败 → data: null（前端据此退回模拟时钟），而不是抛错
    to_json(serde_json::Value::Null)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportParams {
    #[serde(rename = "ref")]
    reference: serde_json::Value,
    /// **实际播成的**音源（可能在候选回退中换了源）；缺省时用引用里的 source
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    played_sec: i64,
    #[serde(default)]
    completed: bool,
    /// 曲目快照（同 `library.history.push`：界面手上有，带上就能离线列历史）
    #[serde(default)]
    track: Option<serde_json::Value>,
}

/// `playback.report{ref, source, quality, playedSec, completed, track?}`：上报一次播放。
///
/// 写的就是播放历史（与 `library.history.push` 同一份实现）：历史是「最近播放」与
/// 后续推荐画像的共同数据源。`quality` 目前不落库——`RecentTrack` 里没有这一列，
/// 记了也没人消费（要加就同时改契约与前端类型）。
fn playback_report(ctx: &CoreContext, params: serde_json::Value) -> Fallible<serde_json::Value> {
    let params: ReportParams = parse_params(params)?;
    let store = require_store(ctx)?;

    // 引用既接受字符串也接受 TrackRef 对象（与 library 域同一套解析）
    let (reference, ref_source) = crate::library::resolve_ref(&params.reference)?;
    let source = params
        .source
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(&ref_source)
        .to_string();

    let snapshot = crate::library::snapshot_of(&reference, &source, params.track.as_ref());
    store.push_history(&reference, &source, &snapshot, params.played_sec, params.completed)?;
    Ok(serde_json::Value::Null)
}

/// 候选顺序：显式 candidates（按 preferredSources 排序）→ 否则只用引用自身来源。
fn candidate_order(ctx: &CoreContext, params: &ResolveParams) -> Vec<String> {
    let mut list: Vec<String> = params
        .candidates
        .clone()
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| vec![params.reference.clone()]);

    if let Some(preferred) = &params.preferred_sources {
        // 用户指定的顺序优先，其余保持原顺序
        list.sort_by_key(|reference| {
            let source = reference.split(':').next().unwrap_or_default();
            preferred.iter().position(|item| item == source).unwrap_or(usize::MAX)
        });
    }
    let _ = ctx;
    list
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

#[cfg(test)]
mod reveal_args {
    use super::reveal_arg;

    /// `system.paths` 回给前端的是正斜杠路径，前端原样传回来；explorer 必须是反斜杠。
    #[test]
    fn forward_slashes_become_native_backslashes() {
        assert_eq!(reveal_arg(true, "C:/Users/Xun/AppData"), r"C:\Users\Xun\AppData");
        assert_eq!(
            reveal_arg(true, r"C:\Users\Xun\AppData"),
            r"C:\Users\Xun\AppData"
        );
    }

    /// 文件要用 `/select,"<path>"`：带空格的路径不加引号会被 explorer 截断。
    #[test]
    fn files_are_selected_and_quoted() {
        assert_eq!(
            reveal_arg(false, "C:/Users/Xun/My Music/a.flac"),
            r#"/select,"C:\Users\Xun\My Music\a.flac""#
        );
        // 目录不拼 /select：直接打开那个目录
        assert!(reveal_arg(true, "C:/Users/Xun/My Music").ends_with(r"My Music"));
        assert!(!reveal_arg(true, "C:/Users/Xun/My Music").starts_with("/select"));
    }
}