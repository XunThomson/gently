//! 插件域：清单解析、校验与（后续）运行时宿主。
//!
//! M1a 只做**不执行代码**的部分：把插件源解析成清单、校验字段、静态预扫描能力，
//! 供 `plugin.preview` 在安装前展示「它是什么、要什么权限、从哪来」。
//! 真正的执行（QuickJS 沙箱）在 M1b。

mod manifest;

pub use manifest::{
    parse_manifest_json, parse_source, CredentialField, ParsedPlugin, PluginCapability,
    PluginManifest, PluginPermission, TrackQuality, HEADER_SCAN_LINES, MAX_SOURCE_BYTES,
};
