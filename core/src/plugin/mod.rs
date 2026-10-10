//! 插件域：清单解析、安装落盘、运行时宿主、订阅索引。
//!
//! M1a 的两步都**不执行任何代码**：
//! - `manifest`：把插件源解析成清单并校验；
//! - `install`：在用户同意后把文件复制进 `plugins/<id>/`（暂存 → 校验 → 原子替换）；
//! - `host`：内嵌 QuickJS 沙箱（M1b）；
//! - `subscription`：社区仓库索引解析与校验（M1c）。

mod credentials;
mod host;
mod install;
mod manifest;
mod subscription;
mod transport;

pub use credentials::{CredentialStore, MemoryCredentialStore};
pub use host::{kv_path, HostLimits, PluginHandle, PluginHost};
pub use install::{
    entry_path, install, remove_files, sha256_hex, InstallOutcome, InstallSource, InstalledPlugin,
    DEFAULT_PRIORITY, ENTRY_FILE, MAX_PLUGIN_BYTES,
};
pub use manifest::{
    parse_manifest_json, parse_source, CredentialField, ParsedPlugin, PluginCapability,
    PluginManifest, PluginPermission, TrackQuality, HEADER_SCAN_LINES, MAX_SOURCE_BYTES,
};
pub use subscription::{
    is_plain_file_name, is_private_host, parse_index, CatalogEntry, Subscription, SubscriptionIndex,
    SubscriptionSourceEntry,
};
pub use transport::{
    host_allowed, host_of, BlockingHttp, HttpLimits, HttpRequest, HttpResponse, HttpTransport,
};
