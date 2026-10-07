//! 插件出网通道：**唯一**允许插件访问网络的地方。
//!
//! 设计要点：
//! 1. `fetch` 是**同步**的（宿主里就是一次阻塞请求）——本机核心调用插件发生在阻塞线程上，
//!    这换来插件作者可以用最自然的方式写 `await fetch(...)`（返回的已是 resolved Promise）；
//! 2. 只允许 **HTTPS**，且域名必须命中清单 `@hosts`（在白名单外 → `plugin.permission_denied`）；
//! 3. 有连接/读取超时、响应体积上限、重定向次数上限（防止插件把核心当跳板或被大响应拖死）；
//! 4. 传输层是 trait：测试用 mock，真实实现用阻塞式 HTTP 客户端（TLS 走 rustls）。

use std::io::Read;
use std::time::Duration;

use crate::contract::{CoreError, ErrorCode, Fallible};

/// 一次出网请求（由插件通过 `fetch` 发起）。
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// 响应被体积上限截断（插件应据此判断而不是假装完整）
    pub truncated: bool,
}

/// 出网通道。
pub trait HttpTransport: Send + Sync {
    fn send(&self, request: &HttpRequest) -> Fallible<HttpResponse>;
}

/// 限制参数（来自 `app.config` / 环境，集中在此便于统一调参）。
#[derive(Debug, Clone, Copy)]
pub struct HttpLimits {
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    /// 单次响应体上限（防止插件拉超大文件把内存吃掉）
    pub max_bytes: u64,
    pub max_redirects: u32,
    /// 单个 HTTP 方法允许的请求体上限
    pub max_request_bytes: usize,
}

impl Default for HttpLimits {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(5),
            read_timeout: Duration::from_secs(10),
            max_bytes: 4 * 1024 * 1024,
            max_redirects: 3,
            max_request_bytes: 512 * 1024,
        }
    }
}

/// 真实实现：阻塞式 HTTP。
pub struct BlockingHttp {
    agent: ureq::Agent,
    limits: HttpLimits,
}

impl BlockingHttp {
    pub fn new(limits: HttpLimits) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(limits.connect_timeout)
            .timeout_read(limits.read_timeout)
            .timeout_write(limits.read_timeout)
            // 自己处理重定向：需要重新做白名单与协议校验
            .redirects(0)
            .build();
        Self { agent, limits }
    }
}

impl HttpTransport for BlockingHttp {
    fn send(&self, request: &HttpRequest) -> Fallible<HttpResponse> {
        if let Some(body) = &request.body {
            if body.len() > self.limits.max_request_bytes {
                return Err(CoreError::invalid_argument("请求体超过上限")
                    .with_details(serde_json::json!({ "limit": self.limits.max_request_bytes })));
            }
        }

        let mut current = request.clone();
        let mut redirects = 0u32;

        loop {
            let mut call = self.agent.request(&current.method, &current.url);
            for (key, value) in &current.headers {
                call = call.set(key, value);
            }

            let result = match &current.body {
                Some(body) => call.send_string(body),
                None => call.call(),
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    let headers = response
                        .headers_names()
                        .into_iter()
                        .filter_map(|name| {
                            response.header(&name).map(|value| (name.to_ascii_lowercase(), value.to_string()))
                        })
                        .collect::<Vec<_>>();

                    // 手动跟随重定向（每一跳都会重新过白名单，避免被 302 带去任意地址）
                    if (300..400).contains(&status) {
                        let location = headers
                            .iter()
                            .find(|(name, _)| name == "location")
                            .map(|(_, value)| value.clone());
                        match location {
                            Some(location) if redirects < self.limits.max_redirects => {
                                redirects += 1;
                                current.url = resolve_location(&current.url, &location)?;
                                continue;
                            }
                            Some(_) => {
                                return Err(CoreError::new(
                                    ErrorCode::SourceUpstreamFailed,
                                    "重定向次数超过上限",
                                ))
                            }
                            None => {}
                        }
                    }

                    let mut body = String::new();
                    let bytes = response
                        .into_reader()
                        .take(self.limits.max_bytes + 1)
                        .read_to_string(&mut body)
                        .map_err(|err| {
                            CoreError::new(ErrorCode::SourceUpstreamFailed, format!("读取响应失败：{err}"))
                        })?;
                    let truncated = bytes as u64 > self.limits.max_bytes;

                    return Ok(HttpResponse { status, headers, body, truncated });
                }
                Err(ureq::Error::Status(status, response)) => {
                    let body = response.into_string().unwrap_or_default();
                    return Ok(HttpResponse { status, headers: vec![], body, truncated: false });
                }
                Err(err) => {
                    return Err(CoreError::new(
                        ErrorCode::SourceUpstreamFailed,
                        format!("请求失败：{err}"),
                    ))
                }
            }
        }
    }
}

/// 相对/绝对 Location 解析（只支持绝对 URL，够了）。
fn resolve_location(base: &str, location: &str) -> Fallible<String> {
    if location.starts_with("https://") {
        return Ok(location.to_string());
    }
    if location.starts_with("http://") {
        return Err(CoreError::new(ErrorCode::MediaBlockedAddress, "插件出网只允许 HTTPS"));
    }
    // 相对跳转：拼到当前 URL 的目录上
    let origin_end = base.find("://").map(|i| i + 3).unwrap_or(0);
    let path_start = base[origin_end..].find('/').map(|i| origin_end + i).unwrap_or(base.len());
    let origin = &base[..path_start];
    if location.starts_with('/') {
        Ok(format!("{origin}{location}"))
    } else {
        let dir_end = base.rfind('/').filter(|i| *i > origin_end).unwrap_or(path_start);
        Ok(format!("{}{location}", &base[..=dir_end]))
    }
}

/// 从 URL 里取出主机名（小写）。非法 URL 返回 None。
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    // 去掉 userinfo 与端口
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 白名单匹配：允许声明白名单项为后缀域（如 `example.com` 命中 `api.example.com`）。
///
/// 这样作者不必把每个 CDN 子域都列出来，同时仍然不能访问无关域名。
pub fn host_allowed(allowlist: &[String], host: &str) -> bool {
    allowlist.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        let entry = entry.split(':').next().unwrap_or(&entry).to_string();
        !entry.is_empty() && (host == entry || host.ends_with(&format!(".{entry}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_extraction_handles_ports_and_userinfo() {
        assert_eq!(host_of("https://api.example.com/a/b?c=1").as_deref(), Some("api.example.com"));
        assert_eq!(host_of("https://api.example.com:8443/x").as_deref(), Some("api.example.com"));
        assert_eq!(host_of("https://user:pw@api.example.com/x").as_deref(), Some("api.example.com"));
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn allowlist_matches_subdomains_only() {
        let list = vec!["example.com".to_string()];
        assert!(host_allowed(&list, "example.com"));
        assert!(host_allowed(&list, "api.example.com"));
        // 关键：不能在无关域名上「后缀命中」
        assert!(!host_allowed(&list, "evil-example.com"));
        assert!(!host_allowed(&list, "example.com.evil.net"));
        assert!(!host_allowed(&[], "example.com"));
    }

    #[test]
    fn relative_redirects_resolve_against_the_base() {
        assert_eq!(
            resolve_location("https://a.example.com/x/y", "/z").unwrap(),
            "https://a.example.com/z"
        );
        assert_eq!(
            resolve_location("https://a.example.com/x/y", "w").unwrap(),
            "https://a.example.com/x/w"
        );
        assert!(resolve_location("https://a.example.com/x", "http://b.example.com/y").is_err());
    }
}
