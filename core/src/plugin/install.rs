//! 插件安装：文件落盘（暂存 → 校验 → 原子替换）与来源校验和。
//!
//! 三条不可妥协的约束（对应 ADR-0005 与契约 §5.3）：
//! 1. **只在用户显式同意后落盘**（同意由命令层把关，本模块假定已被授权）；
//! 2. **绝不执行任何代码或安装脚本**：只读字节、解析元数据、复制文件；
//! 3. **失败不留半成品**：先写 `plugins/.staging/<ts>/`，校验通过后再原子 rename 进
//!    `plugins/<id>/`；替换旧版本时旧目录先移到 `.trash/` 再删除。
//!
//! 落盘布局统一为目录（单文件形态也归一化成 `plugins/<id>/plugin.js`），
//! 这样「加载插件」只有一种路径，M1b 不需要分情况处理。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::paths::AppPaths;

use super::manifest::{parse_manifest_json, parse_source, PluginManifest};

/// 单个插件的体积上限（含资源文件）：插件是脚本，超过这个体量基本可以确定有问题。
pub const MAX_PLUGIN_BYTES: u64 = 8 * 1024 * 1024;

/// 单文件形态归一化后的入口文件名。
pub const ENTRY_FILE: &str = "plugin.js";

/// 新装插件的默认优先级（数值越小越优先）。
pub const DEFAULT_PRIORITY: i64 = 100;

/// 已安装插件的记录（与 `plugin_state` 表一一对应）。
#[derive(Debug, Clone)]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub priority: i64,
    pub origin_kind: String,
    pub origin_value: String,
    pub sha256: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
}

impl InstalledPlugin {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }
}

/// 规范化后的安装来源。
pub enum InstallSource<'a> {
    /// 粘贴的源文件文本
    Paste(&'a str),
    /// 单个 `.js` 文件
    File(&'a Path),
    /// 目录包（含 `plugin.json`）
    Dir(&'a Path),
    /// 从订阅下载的内容（sha256 由调用方在下载后校验）
    Downloaded { subscription_id: &'a str, file_name: &'a str, content: &'a [u8] },
}

impl InstallSource<'_> {
    pub fn origin(&self) -> (&'static str, String) {
        match self {
            Self::Paste(_) => ("paste", String::new()),
            Self::File(path) => ("file", path.to_string_lossy().replace('\\', "/")),
            Self::Dir(path) => ("dir", path.to_string_lossy().replace('\\', "/")),
            // 用 `::` 拼接订阅 id 与文件名：列表时据此判断「某条索引是否已安装」
            Self::Downloaded { subscription_id, file_name, .. } => {
                ("catalog", format!("{subscription_id}::{file_name}"))
            }
        }
    }
}

pub struct InstallOutcome {
    pub record: InstalledPlugin,
    pub warnings: Vec<String>,
    /// 是否覆盖了同 id 的已装插件
    pub replaced: bool,
}

/// 安装（或覆盖安装）一个插件。**调用方必须已取得用户同意**。
pub fn install(paths: &AppPaths, source: InstallSource<'_>) -> Fallible<InstallOutcome> {
    clean_leftovers(paths);

    let stamp = timestamp();
    let staging = paths.plugins.join(".staging").join(format!("pkg-{stamp}"));
    std::fs::create_dir_all(&staging)?;

    // 任何失败都要把暂存目录清掉，绝不留半成品
    let staged = stage_source(&staging, &source);
    let (manifest, warnings, entry_sha256) = match staged {
        Ok(value) => value,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(err);
        }
    };

    let target = paths.plugins.join(&manifest.id);
    let replaced = target.exists();

    // 旧版本先移走（不直接删：rename 之后才删，缩短「两个版本都不完整」的窗口）
    let trash = paths.plugins.join(".trash").join(format!("{}-{stamp}", manifest.id));
    if replaced {
        std::fs::create_dir_all(trash.parent().unwrap_or(&paths.plugins))?;
        if let Err(err) = std::fs::rename(&target, &trash) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(CoreError::new(
                ErrorCode::PluginImportFailed,
                format!("替换旧版本失败（目录被占用？）：{err}"),
            ));
        }
    }

    if let Err(err) = std::fs::rename(&staging, &target) {
        // 回滚：把旧目录放回去，删掉暂存
        if replaced {
            let _ = std::fs::rename(&trash, &target);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(CoreError::new(
            ErrorCode::PluginImportFailed,
            format!("写入插件目录失败：{err}"),
        ));
    }

    if replaced {
        let _ = std::fs::remove_dir_all(&trash);
    }

    // 收尾：把空的 .staging / .trash 父目录一并清掉（remove_dir 只在目录为空时成功）
    for name in [".staging", ".trash"] {
        let dir = paths.plugins.join(name);
        if dir.is_dir() {
            let _ = std::fs::remove_dir(&dir);
        }
    }

    let now = timestamp();
    let (origin_kind, origin_value) = source.origin();
    tracing::info!(id = %manifest.id, version = %manifest.version, replaced, "插件已安装");

    Ok(InstallOutcome {
        record: InstalledPlugin {
            manifest,
            enabled: true,
            priority: DEFAULT_PRIORITY,
            origin_kind: origin_kind.to_string(),
            origin_value,
            sha256: entry_sha256,
            installed_at: now,
            updated_at: now,
        },
        warnings,
        replaced,
    })
}

/// 卸载时删除插件目录（失败不致命：库记录已删，文件残留只影响磁盘占用）。
pub fn remove_files(paths: &AppPaths, id: &str) -> Fallible<()> {
    let dir = paths.plugins.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// 入口文件的绝对路径（加载插件时用）。
pub fn entry_path(paths: &AppPaths, manifest: &PluginManifest) -> PathBuf {
    let dir = paths.plugins.join(&manifest.id);
    match manifest.entry.as_deref() {
        Some(entry) if !entry.is_empty() => dir.join(entry),
        _ => dir.join(ENTRY_FILE),
    }
}

// ---------------------------------------------------------------- 内部

/// 把来源写进暂存目录，并**从暂存的内容**解析清单（校验的就是将要落盘的东西）。
fn stage_source(
    staging: &Path,
    source: &InstallSource<'_>,
) -> Fallible<(PluginManifest, Vec<String>, Option<String>)> {
    match source {
        InstallSource::Paste(content) => {
            let parsed = parse_source(content)?;
            std::fs::write(staging.join(ENTRY_FILE), content.as_bytes())?;
            Ok((with_entry(parsed.manifest), parsed.warnings, Some(sha256_hex(content.as_bytes()))))
        }
        InstallSource::File(path) => {
            let bytes = read_limited(path)?;
            let text = String::from_utf8(bytes.clone()).map_err(|_| {
                CoreError::new(ErrorCode::PluginInvalidSource, "插件文件不是 UTF-8 文本")
            })?;
            let parsed = parse_source(&text)?;
            std::fs::write(staging.join(ENTRY_FILE), &bytes)?;
            Ok((with_entry(parsed.manifest), parsed.warnings, Some(sha256_hex(&bytes))))
        }
        InstallSource::Downloaded { content, .. } => {
            let bytes = content.to_vec();
            if bytes.len() as u64 > MAX_PLUGIN_BYTES {
                return Err(CoreError::invalid_argument(format!(
                    "插件超过 {MAX_PLUGIN_BYTES} 字节上限"
                ))
                .with_details(serde_json::json!({ "bytes": bytes.len(), "limit": MAX_PLUGIN_BYTES })));
            }
            let text = String::from_utf8(bytes.clone()).map_err(|_| {
                CoreError::new(ErrorCode::PluginInvalidSource, "下载的插件不是 UTF-8 文本")
            })?;
            let parsed = parse_source(&text)?;
            std::fs::write(staging.join(ENTRY_FILE), &bytes)?;
            Ok((with_entry(parsed.manifest), parsed.warnings, Some(sha256_hex(&bytes))))
        }
        InstallSource::Dir(path) => {
            if !path.is_dir() {
                return Err(CoreError::invalid_argument("目录包来源必须是目录"));
            }
            // 1) 先整体复制（跳过符号链接与超大文件），保持相对结构
            copy_tree(path, staging)?;

            // 2) 从**暂存副本**解析清单（而不是原目录）
            let manifest_path = staging.join("plugin.json");
            let json = std::fs::read_to_string(&manifest_path).map_err(|err| {
                CoreError::new(
                    ErrorCode::PluginInvalidManifest,
                    format!("目录包缺少可读的 plugin.json：{err}"),
                )
            })?;
            let raw: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
            let entry = raw.get("entry").and_then(|v| v.as_str()).map(str::to_string);
            let entry_source = entry
                .as_deref()
                .and_then(|name| std::fs::read_to_string(staging.join(name)).ok());
            if let Some(name) = entry.as_deref() {
                if !staging.join(name).is_file() {
                    return Err(CoreError::new(
                        ErrorCode::PluginInvalidManifest,
                        format!("plugin.json 声明的 entry 不存在：{name}"),
                    ));
                }
            }
            let parsed = parse_manifest_json(&json, entry_source.as_deref())?;
            let sha = entry_source.as_deref().map(|text| sha256_hex(text.as_bytes()));
            Ok((parsed.manifest, parsed.warnings, sha))
        }
    }
}

/// 单文件形态落盘后入口固定为 `plugin.js`。
fn with_entry(mut manifest: PluginManifest) -> PluginManifest {
    if manifest.entry.is_none() {
        manifest.entry = Some(ENTRY_FILE.to_string());
    }
    manifest
}

fn read_limited(path: &Path) -> Fallible<Vec<u8>> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_PLUGIN_BYTES {
        return Err(CoreError::invalid_argument(format!(
            "插件超过 {MAX_PLUGIN_BYTES} 字节上限"
        ))
        .with_details(serde_json::json!({ "bytes": meta.len(), "limit": MAX_PLUGIN_BYTES })));
    }
    Ok(std::fs::read(path)?)
}

/// 递归复制目录：**跳过符号链接**（避免把链接指向的外部内容装进来），累计体积受上限约束。
fn copy_tree(from: &Path, to: &Path) -> Fallible<()> {
    std::fs::create_dir_all(to)?;
    let mut total = 0u64;

    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());

        if file_type.is_symlink() {
            tracing::warn!(path = %entry.path().display(), "跳过符号链接");
            continue;
        }
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
            continue;
        }

        total += entry.metadata()?.len();
        if total > MAX_PLUGIN_BYTES {
            return Err(CoreError::invalid_argument(format!(
                "目录包累计超过 {MAX_PLUGIN_BYTES} 字节上限"
            ))
            .with_details(serde_json::json!({ "limit": MAX_PLUGIN_BYTES })));
        }
        std::fs::copy(entry.path(), target)?;
    }

    Ok(())
}

/// 清理上次失败留下的暂存/回收目录（尽力而为，失败只记日志）。
fn clean_leftovers(paths: &AppPaths) {
    for name in [".staging", ".trash"] {
        let dir = paths.plugins.join(name);
        if dir.exists() {
            if let Err(err) = std::fs::remove_dir_all(&dir) {
                tracing::warn!(dir = %dir.display(), %err, "清理临时目录失败");
            }
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
