//! 插件域：清单解析、安装落盘、运行时宿主、订阅索引。
//!
//! 各模块职责：
//! - `manifest`：把插件源解析成清单并校验（不执行代码）；
//! - `install`：在用户同意后把文件复制进 `plugins/<id>/`（暂存 → 校验 → 原子替换）；
//! - `compat`：兼容开关的接入层——头部不全时用 `probe` 从 `module.exports` 合成清单（ADR-0006）；
//! - `host`：内嵌 QuickJS 沙箱（bootstrap 与 require 垫片在 `sandbox/` 下，M1b/ADR-0006）；
//! - `hosts`：兼容模式的域名观测台账（TOFU 收敛的依据，ADR-0006）；
//! - `shape`：插件返回值的形状适配（`[...]` / `{items}` / `{isEnd, data}` / `{isEnd, musicList}`）；
//! - `subscription`：社区仓库索引解析与校验（M1c）；
//! - `authoring`：作者工具逻辑（校验单文件、生成 `repository.json`）；
//! - `archive`：压缩包导入（解压到临时目录后归一化成目录包/单文件两种既有形态）。

pub mod archive;
pub mod authoring;
mod compat;
mod credentials;
mod host;
mod hosts;
mod install;
mod keyring;
mod manifest;
mod shape;
mod subscription;
mod transport;

pub use archive::{extract as extract_archive, flatten_single, ArchiveShape, MAX_ARCHIVE_ENTRIES};
pub use compat::{apply_explicit_compat, parse_source_compat};
pub use credentials::{open_store, CredentialStore, MemoryCredentialStore};
pub use keyring::OsCredentialStore;
pub use host::{kv_path, probe, HostLimits, ModuleProbe, PluginHandle, PluginHost};
pub use hosts::{HostLedger, HostUse};
pub use install::{
    entry_path, install, remove_files, sha256_hex, InstallOutcome, InstallSource, InstalledPlugin,
    DEFAULT_PRIORITY, ENTRY_FILE, MAX_PLUGIN_BYTES,
};
pub use manifest::{
    is_valid_host, parse_manifest_json, parse_source, CredentialField, ParsedPlugin,
    PluginCapability, PluginManifest, PluginPermission, TrackQuality, BUILTIN_REQUIRE_MODULES,
    HEADER_SCAN_LINES, MAX_SOURCE_BYTES,
};
pub use shape::list_items;
pub use subscription::{
    is_plain_file_name, is_private_host, parse_index, CatalogEntry, Subscription, SubscriptionIndex,
    SubscriptionSourceEntry,
};
pub use transport::{
    host_allowed, host_of, require_public_https, BlockingHttp, DownloadEvent, DownloadOutcome,
    HttpLimits,
    HttpRequest, HttpResponse, HttpTransport,
};
