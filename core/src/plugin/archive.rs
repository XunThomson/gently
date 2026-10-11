//! 插件**压缩包**导入（契约 `ImportSource{kind:'archive'}`）。
//!
//! 压缩包是**不可信输入**，所以这里的每一条限制都不是可选项：
//!
//! - **条目数上限**（[`MAX_ARCHIVE_ENTRIES`]）与**解压后总大小上限**
//!   （[`MAX_PLUGIN_BYTES`]）——否则一个几十 KB 的 zip 能撑爆磁盘（zip bomb）；
//! - **拒绝路径穿越**：只用 `enclosed_name()` 给出的相对路径，`..` / 绝对路径一律拒绝；
//! - **拒绝符号链接**：插件包没有理由带链接，而链接会把包外的文件拖进来；
//! - 只支持 **stored + deflate**（zip 的其它后端不在离线依赖里，也确实没必要）。
//!
//! 解压后归一化成两种已有形态，后续逻辑完全复用（`Dir` 走目录包，`Single` 走单文件）：
//! 这样「压缩包」只是「取得一个插件目录」的第四种途径，而不是又一条安装路径。

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::install::MAX_PLUGIN_BYTES;

use super::install::ENTRY_FILE;

/// 包内条目上限：插件包就是「一个脚本 + 少量资源」，超过这个数量基本可以确定有问题。
pub const MAX_ARCHIVE_ENTRIES: usize = 512;

/// 压缩包解开后的形态（相对 `dest` 根）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveShape {
    /// 目录包：根下有 `plugin.json`
    Dir,
    /// 单文件：根下只有一个 `.js`（其文件名，可能是 `plugin.js`）
    Single(String),
}

/// 把压缩包解压到 `dest` 并判断形态；`dest` 不存在时会创建。
///
/// 返回的形态已**考虑「包内多套了一层目录」**这种常见打包方式：
/// 例如 `my-plugin/plugin.json` 会被归一化成 `Dir`（并把那一层拍平）。
pub fn extract(archive_path: &Path, dest: &Path) -> Fallible<ArchiveShape> {
    let file = std::fs::File::open(archive_path).map_err(|err| {
        CoreError::new(ErrorCode::PluginInvalidSource, format!("打开压缩包失败：{err}"))
            .with_details(serde_json::json!({ "path": archive_path.to_string_lossy() }))
    })?;

    let mut zip = zip::ZipArchive::new(file).map_err(|err| {
        CoreError::new(ErrorCode::PluginInvalidSource, format!("不是可读的 zip 压缩包：{err}"))
    })?;

    if zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(CoreError::invalid_argument(format!(
            "压缩包条目过多（{} > {MAX_ARCHIVE_ENTRIES}）",
            zip.len()
        ))
        .with_details(serde_json::json!({ "entries": zip.len(), "limit": MAX_ARCHIVE_ENTRIES })));
    }

    std::fs::create_dir_all(dest)?;
    let mut total = 0u64;

    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| {
            CoreError::new(ErrorCode::PluginInvalidSource, format!("读取压缩包条目失败：{err}"))
        })?;

        // `enclosed_name` 是唯一可信的路径来源：`..`/绝对路径在这里被挡掉
        let Some(relative) = entry.enclosed_name() else {
            return Err(CoreError::new(
                ErrorCode::PluginInvalidSource,
                format!("压缩包条目路径非法：{}", entry.name()),
            ));
        };

        if let Some(mode) = entry.unix_mode() {
            // S_IFLNK = 0o120000：拒绝符号链接（包外内容不该被拖进来）
            if mode & 0o170000 == 0o120000 {
                return Err(CoreError::new(
                    ErrorCode::PluginInvalidSource,
                    format!("压缩包含符号链接，已拒绝：{}", entry.name()),
                ));
            }
        }

        let target = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }

        total += entry.size();
        if total > MAX_PLUGIN_BYTES {
            return Err(CoreError::invalid_argument(format!(
                "压缩包解压后超过 {MAX_PLUGIN_BYTES} 字节上限"
            ))
            .with_details(serde_json::json!({ "limit": MAX_PLUGIN_BYTES })));
        }

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
        out.flush()?;
    }

    let root = flatten_single_dir(dest)?;
    classify(&root)
}

/// 包内只有**一个**顶层目录时把它拍平（`my-plugin/plugin.json` → `plugin.json`）。
///
/// 只处理这一种情况：更深的嵌套说明包的结构不是「一个插件」，
/// 猜下去只会把一个错误的目录当成插件装进来。
fn flatten_single_dir(dest: &Path) -> Fallible<PathBuf> {
    let entries: Vec<_> = std::fs::read_dir(dest)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() != 1 || !entries[0].file_type()?.is_dir() {
        return Ok(dest.to_path_buf());
    }

    let inner = entries[0].path();
    if inner.join("plugin.json").is_file() || contains_js(&inner)? {
        // 把内层内容逐个移到 `dest`（rename 同分区，代价可忽略）
        let files: Vec<_> = std::fs::read_dir(&inner)?.collect::<Result<Vec<_>, _>>()?;
        for entry in files {
            let from = entry.path();
            let to = dest.join(entry.file_name());
            if to.exists() {
                return Ok(dest.to_path_buf());
            }
            std::fs::rename(&from, &to)?;
        }
        std::fs::remove_dir_all(&inner)?;
    }

    Ok(dest.to_path_buf())
}

/// 根目录下是否直接有 `.js` 文件。
fn contains_js(dir: &Path) -> Fallible<bool> {
    Ok(std::fs::read_dir(dir)?.any(|entry| {
        entry
            .map(|entry| {
                !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(true)
                    && entry.file_name().to_string_lossy().to_ascii_lowercase().ends_with(".js")
            })
            .unwrap_or(false)
    }))
}

/// 判断解压结果属于哪种形态；两者都不是就明确报错（而不是让后续步骤含糊失败）。
fn classify(root: &Path) -> Fallible<ArchiveShape> {
    if root.join("plugin.json").is_file() {
        return Ok(ArchiveShape::Dir);
    }

    let js: Vec<String> = std::fs::read_dir(root)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.to_ascii_lowercase().ends_with(".js"))
        .collect();

    match js.len() {
        1 => Ok(ArchiveShape::Single(js[0].clone())),
        0 => Err(CoreError::new(
            ErrorCode::PluginInvalidSource,
            "压缩包里既没有 plugin.json，也没有 .js 插件文件",
        )),
        _ => Err(CoreError::new(
            ErrorCode::PluginInvalidSource,
            format!("压缩包里有多个 .js 文件，无法判断入口：{}", js.join("、")),
        )
        .with_details(serde_json::json!({ "candidates": js }))),
    }
}

/// 把「单文件形态」的解压结果整理成目录包时代的统一入口 `plugin.js`：
/// 包目录里只留入口文件，其余（README、示例等）一律丢弃——安装目录只该有一个插件。
pub fn flatten_single(root: &Path, entry: &str) -> Fallible<()> {
    let entry_path = root.join(entry);
    let bytes = std::fs::read(&entry_path)?;

    if entry != ENTRY_FILE {
        std::fs::write(root.join(ENTRY_FILE), bytes)?;
        std::fs::remove_file(&entry_path)?;
    }

    for item in std::fs::read_dir(root)?.filter_map(|item| item.ok()) {
        let path = item.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        if path.file_name().map(|name| name != ENTRY_FILE).unwrap_or(false) {
            std::fs::remove_file(&path)?;
        }
    }

    Ok(())
}
