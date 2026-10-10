//! 作者工具的核心逻辑（`plugin-tool` CLI 与测试共用）。
//!
//! 两件事：
//! 1. **校验**单个插件源（头部元数据、必选函数、`@hosts` 合法性）——作者发布前自测；
//! 2. **生成** `repository.json` 索引——社区仓库只需要「一个目录 + 一个索引文件」。
//!
//! 放在库里而不是只写在 bin 里，是为了让测试直接覆盖逻辑（CLI 只是薄壳）。

use std::path::{Path, PathBuf};

use crate::contract::{CoreError, ErrorCode, Fallible};

use super::manifest::{parse_source, PluginManifest};
use super::install::sha256_hex;
use super::subscription::{SubscriptionIndex, SubscriptionSourceEntry};

/// 单个文件的校验结果（CLI 逐条打印）。
#[derive(Debug, Clone)]
pub struct CheckReport {
    pub file: String,
    pub manifest: Option<PluginManifest>,
    pub warnings: Vec<String>,
    pub error: Option<CoreError>,
}

impl CheckReport {
    pub fn ok(&self) -> bool {
        self.error.is_none()
    }
}

/// 校验一段插件源码（`file` 只用于展示）。
pub fn check_text(file: &str, source: &str) -> CheckReport {
    match parse_source(source) {
        Ok(parsed) => CheckReport {
            file: file.to_string(),
            manifest: Some(parsed.manifest),
            warnings: parsed.warnings,
            error: None,
        },
        Err(error) => CheckReport {
            file: file.to_string(),
            manifest: None,
            warnings: Vec::new(),
            error: Some(error),
        },
    }
}

pub fn check_file(path: &Path) -> CheckReport {
    let display = path.to_string_lossy().replace('\\', "/");
    match std::fs::read_to_string(path) {
        Ok(text) => check_text(&display, &text),
        Err(err) => CheckReport {
            file: display,
            manifest: None,
            warnings: Vec::new(),
            error: Some(CoreError::new(ErrorCode::LibraryIoError, format!("读取失败：{err}"))),
        },
    }
}

#[derive(Debug, Clone)]
pub struct GenerateOptions {
    /// 索引里 `downloadUrl` 的前缀（如 `https://example.com/plugins`）
    pub base_url: String,
    pub name: Option<String>,
    /// 跳过非法文件（默认 false：宁可失败也不发布残缺索引）
    pub skip_invalid: bool,
}

/// 扫描目录里的 `*.js` 并生成索引。
///
/// 返回索引与逐文件报告；调用方（CLI）据此打印「哪些文件被跳过、为什么」。
pub fn generate_index(dir: &Path, options: &GenerateOptions) -> Fallible<(SubscriptionIndex, Vec<CheckReport>)> {
    if !dir.is_dir() {
        return Err(CoreError::invalid_argument("目录不存在")
            .with_details(serde_json::json!({ "dir": dir.to_string_lossy() })));
    }
    let base = options.base_url.trim_end_matches('/');
    if !base.starts_with("https://") {
        return Err(CoreError::invalid_argument("base-url 必须是 HTTPS（索引里的下载地址会被客户端校验）"));
    }

    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "js"))
        .collect();
    files.sort();

    let mut entries: Vec<SubscriptionSourceEntry> = Vec::new();
    let mut reports: Vec<CheckReport> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();

    for path in files {
        let report = check_file(&path);
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

        match (&report.manifest, &report.error) {
            (Some(manifest), _) => {
                let bytes = std::fs::read(&path)?;
                entries.push(SubscriptionSourceEntry {
                    name: manifest.name.clone(),
                    file_name: file_name.clone(),
                    download_url: format!("{base}/{file_name}"),
                    version: manifest.version.clone(),
                    author: manifest.author.clone(),
                    url: manifest.homepage.clone().unwrap_or_default(),
                    group: manifest.tags.first().cloned().unwrap_or_default(),
                    logo: String::new(),
                    description: manifest.description.clone(),
                    tags: manifest.tags.clone(),
                    enabled: true,
                    file_size: bytes.len() as u64,
                    updated_at: modified_iso8601(&path),
                    sha256: Some(sha256_hex(&bytes)),
                    hosts: manifest.hosts.clone(),
                    qualities: manifest
                        .qualities
                        .iter()
                        .map(|quality| format!("{quality:?}").to_lowercase())
                        .collect(),
                });
            }
            (None, Some(error)) => {
                invalid.push(format!("{file_name}（{}）", error.message));
            }
            (None, None) => {}
        }

        reports.push(report);
    }

    if !invalid.is_empty() && !options.skip_invalid {
        return Err(CoreError::new(
            ErrorCode::PluginInvalidSource,
            "目录里存在无法发布的插件（用 --skip-invalid 可跳过）",
        )
        .with_details(serde_json::json!({ "files": invalid })));
    }

    let name = options
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "社区音源仓库".to_string());

    let index = SubscriptionIndex {
        name,
        version: "1.0.0".to_string(),
        updated_at: now_iso8601(),
        url: Some(base.to_string()),
        sources: entries,
    };

    Ok((index, reports))
}

/// 文件修改时间的 ISO 8601（UTC）；取不到时用当前时间。
fn modified_iso8601(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| iso8601_from_unix(duration.as_secs() as i64))
        .unwrap_or_else(now_iso8601)
}

pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();
    iso8601_from_unix(secs)
}

/// Unix 秒 → `YYYY-MM-DDTHH:MM:SSZ`。
///
/// 自己实现是为了不引 chrono（本机场景只需要这一种格式），算法是标准的
/// civil_from_days（Howard Hinnant），已覆盖闰年与世纪边界。
pub fn iso8601_from_unix(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // days 从 1970-01-01 起算
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_handles_epoch_leap_years_and_century() {
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_unix(1_000_000_000), "2001-09-09T01:46:40Z");
        // 2000-02-29（闰年且是世纪年）
        assert_eq!(iso8601_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        // 2024-02-29
        assert_eq!(iso8601_from_unix(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(iso8601_from_unix(1_760_000_000), "2025-10-09T08:53:20Z");
    }
}
