//! 订阅与社区仓库索引（契约 §6）。
//!
//! 分发不依赖我们的服务器：社区把 `repository.json` + `*.js` 放在任意静态托管上，
//! 用户自己填地址（ADR-0005：**不预置任何订阅**）。
//!
//! 索引来自陌生人，因此这里按不可信输入处理：
//! - `fileName` 必须是**纯文件名**（拒绝路径分隔符与 `..`，防目录穿越）；
//! - `downloadUrl` 必须是 **HTTPS**，且**不得指向回环/内网地址**（防 SSRF）；
//! - `sha256` 有则校验，缺则记录「无校验」提示（不阻断，用户自己决定）。

use serde::{Deserialize, Serialize};

use crate::contract::{CoreError, ErrorCode, Fallible};

use super::transport::host_of;

/// 索引里的单个插件条目（字段与 Legado 社区仓库规范同构，字段只增不改）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSourceEntry {
    pub name: String,
    pub file_name: String,
    pub download_url: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub logo: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub updated_at: String,
    /// 可选：有则安装后校验内容
    #[serde(default)]
    pub sha256: Option<String>,
    /// 可选：便于安装前展示网络范围
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub qualities: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionIndex {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub url: Option<String>,
    pub sources: Vec<SubscriptionSourceEntry>,
}

impl SubscriptionIndex {
    pub fn find(&self, file_name: &str) -> Option<&SubscriptionSourceEntry> {
        self.sources.iter().find(|entry| entry.file_name == file_name)
    }
}

/// 解析并校验索引。任何非法条目都会让整份索引被拒（避免「安静地少了一半条目」）。
pub fn parse_index(json: &str) -> Fallible<SubscriptionIndex> {
    let index: SubscriptionIndex = serde_json::from_str(json).map_err(|err| {
        CoreError::new(ErrorCode::SubscriptionInvalidIndex, format!("索引不是合法 JSON：{err}"))
            .with_details(serde_json::json!({ "reason": err.to_string() }))
    })?;

    if index.name.trim().is_empty() {
        return Err(invalid("索引缺少 name", serde_json::json!({ "field": "name" })));
    }

    let mut problems: Vec<serde_json::Value> = Vec::new();
    for (position, entry) in index.sources.iter().enumerate() {
        if entry.name.trim().is_empty() {
            problems.push(serde_json::json!({ "index": position, "field": "name" }));
        }
        if !is_plain_file_name(&entry.file_name) {
            problems.push(serde_json::json!({
                "index": position,
                "field": "fileName",
                "value": entry.file_name,
                "expect": "纯文件名（不含路径分隔符与 ..）"
            }));
        }
        match host_of(&entry.download_url) {
            None => problems.push(serde_json::json!({
                "index": position, "field": "downloadUrl", "value": entry.download_url,
                "expect": "https:// 开头的绝对地址"
            })),
            Some(_) if !entry.download_url.starts_with("https://") => problems.push(serde_json::json!({
                "index": position, "field": "downloadUrl", "value": entry.download_url,
                "expect": "必须是 HTTPS"
            })),
            Some(host) if is_private_host(&host) => problems.push(serde_json::json!({
                "index": position, "field": "downloadUrl", "value": entry.download_url,
                "expect": "不得指向回环/内网地址"
            })),
            Some(_) => {}
        }
        if entry.version.trim().is_empty() {
            problems.push(serde_json::json!({ "index": position, "field": "version" }));
        }
        if entry.sha256.as_deref().is_some_and(|value| value.len() != 64) {
            problems.push(serde_json::json!({
                "index": position, "field": "sha256", "expect": "64 位十六进制"
            }));
        }
    }

    if !problems.is_empty() {
        return Err(invalid("索引包含非法条目", serde_json::json!({ "problems": problems })));
    }

    Ok(index)
}

fn invalid(message: &str, details: serde_json::Value) -> CoreError {
    CoreError::new(ErrorCode::SubscriptionInvalidIndex, message).with_details(details)
}

/// 纯文件名：不得包含路径分隔符、`..` 或协议前缀。
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.contains(':')
        && name != "."
}

/// 回环 / 私有 / 链路本地地址：核心主动发起的下载必须拒绝（防 SSRF）。
pub fn is_private_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if host.is_empty() {
        return true;
    }
    // IPv4 字面量
    let octets: Vec<&str> = host.split('.').collect();
    if octets.len() == 4 && octets.iter().all(|part| part.parse::<u8>().is_ok()) {
        let first: u8 = octets[0].parse().unwrap_or(0);
        let second: u8 = octets[1].parse().unwrap_or(0);
        return first == 10
            || first == 127
            || (first == 169 && second == 254)
            || (first == 172 && (16..=31).contains(&second))
            || (first == 192 && second == 168)
            || first == 0;
    }
    // IPv6：只挡最常见的回环/唯一本地/链路本地
    if host.contains(':') {
        return host == "::1"
            || host.starts_with("fc")
            || host.starts_with("fd")
            || host.starts_with("fe80");
    }
    false
}

/// 订阅记录（`subscriptions` 表）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    pub count: i64,
    /// 最近一次刷新失败的原因（有值时 UI 提示，但旧索引仍可用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 索引条目 + 本地安装状态（`plugin.catalog.list` 的返回体）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub entry: SubscriptionSourceEntry,
    pub subscription_id: String,
    pub subscription_name: String,
    pub installed: bool,
    pub update_available: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
        "name": "示例社区仓库", "version": "1.0.0", "updatedAt": "2026-10-07T00:00:00Z",
        "url": "https://example.com/community-index",
        "sources": [{
            "name": "示例音源", "fileName": "example.js",
            "downloadUrl": "https://example.com/plugins/example.js",
            "version": "1.0.0", "author": "someone", "tags": ["示例"], "enabled": true,
            "fileSize": 1234, "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
        }]
    }"#;

    #[test]
    fn parses_a_valid_index() {
        let index = parse_index(GOOD).expect("应解析成功");
        assert_eq!(index.name, "示例社区仓库");
        assert_eq!(index.sources.len(), 1);
        assert!(index.find("example.js").is_some());
    }

    #[test]
    fn rejects_path_traversal_in_file_name() {
        for bad in ["../evil.js", "sub/evil.js", "..\\\\evil.js", "C:evil.js", ""] {
            let json = GOOD.replace("example.js", bad);
            let err = parse_index(&json).unwrap_err();
            assert_eq!(err.code, ErrorCode::SubscriptionInvalidIndex, "{bad}");
            assert!(
                err.details.unwrap().to_string().contains("fileName"),
                "应指出 fileName 非法：{bad}"
            );
        }
    }

    #[test]
    fn rejects_private_and_plain_http_download_urls() {
        for bad in [
            "http://example.com/a.js",
            "https://127.0.0.1/a.js",
            "https://localhost/a.js",
            "https://192.168.1.10/a.js",
            "https://10.0.0.5/a.js",
            "https://169.254.1.1/a.js",
        ] {
            let json = GOOD.replace("https://example.com/plugins/example.js", bad);
            let err = parse_index(&json).unwrap_err();
            assert_eq!(err.code, ErrorCode::SubscriptionInvalidIndex, "{bad}");
        }
    }

    #[test]
    fn private_host_detection_is_not_overzealous() {
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("api.example.com"));
        // 容易误判的边界：169.253 与 172.32 都是公网
        assert!(!is_private_host("169.253.1.1"));
        assert!(!is_private_host("172.32.0.1"));
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("172.31.255.255"));
    }

    #[test]
    fn malformed_json_is_invalid_index() {
        let err = parse_index("{ nope").unwrap_err();
        assert_eq!(err.code, ErrorCode::SubscriptionInvalidIndex);
    }
}
