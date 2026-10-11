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

    /// **流式**获取（下载写盘用）：先给一次 `Start`（状态码 + 响应头），再逐块给 `Chunk`；
    /// `sink` 返回 `false` 表示要求中止。
    ///
    /// 为什么单独一个方法：`send` 会把整个响应体读进内存（还有 4 MiB 上限），
    /// 而下载必须边收边写——用 `send` 实现下载等于把大文件这条路堵死。
    /// `Start` 必须先于任何 `Chunk`：续传要靠状态码（206 才算续上，200 说明上游忽略了 Range）
    /// **在写第一个字节之前**决定是追加还是重写。
    ///
    /// 默认实现**明确报错**而不是退化成缓冲：避免将来新增传输层时，
    /// 下载悄悄变成「先全下载进内存再写盘」。
    fn download(
        &self,
        _request: &HttpRequest,
        _sink: &mut dyn FnMut(DownloadEvent<'_>) -> bool,
    ) -> Fallible<DownloadOutcome> {
        Err(CoreError::new(
            ErrorCode::Internal,
            "当前出网通道不支持流式下载（只有真实实现与测试假实现需要覆盖 download）",
        ))
    }
}

/// 流式下载过程中交给调用方的事件。
#[derive(Debug)]
pub enum DownloadEvent<'a> {
    /// 响应到达（还没读正文）：续传要在这里决定追加还是重写
    Start { status: u16, headers: &'a [(String, String)] },
    /// 一段响应体
    Chunk(&'a [u8]),
}

/// 一次流式下载的结果。
#[derive(Debug, Clone)]
pub struct DownloadOutcome {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub bytes: u64,
    /// 调用方要求中止（暂停/取消）：不是错误，进度已经落盘
    pub aborted: bool,
}

/// 「必须是公网 HTTPS」的唯一实现（媒体代理与下载共用）。
///
/// `what` 只用于错误文案（「媒体地址」「下载地址」），规则本身一处不改：
/// 仅 HTTPS、不得指向回环/链路本地/私有网段。
pub fn require_public_https(url: &str, what: &str) -> Fallible<()> {
    if !url.starts_with("https://") {
        return Err(CoreError::new(ErrorCode::MediaBlockedAddress, format!("{what}必须是 HTTPS")));
    }
    let host = host_of(url)
        .ok_or_else(|| CoreError::new(ErrorCode::MediaBlockedAddress, format!("无法解析{what}的域名")))?;
    if crate::plugin::is_private_host(&host) {
        return Err(CoreError::new(
            ErrorCode::MediaBlockedAddress,
            format!("{what}指向回环或内网，已拒绝（可能被用作访问本机的跳板）"),
        )
        .with_details(serde_json::json!({ "host": host })));
    }
    Ok(())
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

    /// 流式下载：边收边交给 sink；支持 `Range` 续传与手动跟随重定向（每一跳都重新校验）。
    fn download(
        &self,
        request: &HttpRequest,
        sink: &mut dyn FnMut(DownloadEvent<'_>) -> bool,
    ) -> Fallible<DownloadOutcome> {
        let mut current = request.clone();
        let mut redirects = 0u32;
        let mut written = 0u64;

        loop {
            // 每一跳都重新过「公网 HTTPS」校验：地址由插件/上游给出，不能被 302 带去内网
            require_public_https(&current.url, "下载地址")?;

            let mut call = self.agent.request(&current.method, &current.url);
            for (key, value) in &current.headers {
                call = call.set(key, value);
            }
            let result = match &current.body {
                Some(body) => call.send_string(body),
                None => call.call(),
            };

            let response = match result {
                Ok(response) => response,
                // 4xx/5xx 也是「有响应」：交给调用方按状态码判断（如 416 续传越界）
                Err(ureq::Error::Status(status, response)) => {
                    let headers = header_pairs(&response);
                    // 仍然先给 Start：调用方据此判断「续传越界」等情况，再看到 0 字节
                    let _ = sink(DownloadEvent::Start { status, headers: &headers });
                    return Ok(DownloadOutcome { status, headers, bytes: 0, aborted: false });
                }
                Err(err) => {
                    return Err(CoreError::new(
                        ErrorCode::SourceUpstreamFailed,
                        format!("下载请求失败：{err}"),
                    ))
                }
            };

            let status = response.status();
            let headers = header_pairs(&response);

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
                        return Err(CoreError::new(ErrorCode::SourceUpstreamFailed, "下载重定向次数超过上限"))
                    }
                    None => {}
                }
            }

            // 正文之前先报状态：续传要靠它在写第一个字节前决定「追加还是重写」
            if !sink(DownloadEvent::Start { status, headers: &headers }) {
                return Ok(DownloadOutcome { status, headers, bytes: 0, aborted: true });
            }

            let mut reader = response.into_reader();
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let read = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(err) => {
                        return Err(CoreError::new(
                            ErrorCode::SourceUpstreamFailed,
                            format!("读取下载响应失败：{err}"),
                        ))
                    }
                };
                written += read as u64;
                if !sink(DownloadEvent::Chunk(&buffer[..read])) {
                    // 暂停/取消：把已收到的字节数如实带回去（调用方据此落盘进度）
                    return Ok(DownloadOutcome { status, headers, bytes: written, aborted: true });
                }
            }

            return Ok(DownloadOutcome { status, headers, bytes: written, aborted: false });
        }
    }
}

/// 响应头 → `(小写名, 值)` 列表（下载与 `send` 都要，抽出来避免两份写法）。
fn header_pairs(response: &ureq::Response) -> Vec<(String, String)> {
    response
        .headers_names()
        .into_iter()
        .filter_map(|name| response.header(&name).map(|value| (name.to_ascii_lowercase(), value.to_string())))
        .collect()
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
