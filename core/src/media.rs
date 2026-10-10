//! 媒体传输：候选回退解析 + **本地流代理**（契约 §7）。
//!
//! # 为什么必须有代理
//!
//! WebView 里的 `<audio>` **无法设置请求头**（`Referer` / `User-Agent` / `Cookie`），
//! 而真实音源大量依赖这些头；同时还需要 `Range`（拖动进度）与放宽 CORS。
//! 因此核心在 **仅回环地址**上起一个临时 HTTP 服务，把上游流按需转发：
//!
//! - `playback.resolve` 返回的 `streamUrl` 形如 `http://127.0.0.1:<port>/m/<token>`；
//! - 代理注入插件声明的请求头、透传 `Range`/`206`/`Content-Range`，`Cache-Control: no-store`；
//! - **SSRF 防护**：媒体地址由上游返回，不受 `@hosts` 约束，因此在发布令牌前拦截
//!   回环/内网/链路本地地址（`media.blocked_address`）；
//! - 令牌有过期时间，未知/过期令牌一律 404；代理**只服务媒体**，不提供通用转发（否则成了跳板）。
//!
//! 这里用极简的手写 HTTP（只处理 `GET`、一次请求一条连接）而不是引入框架：
//! 需求面窄（单一路由 + Range 透传），依赖越少越好，且行为完全可控。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::is_private_host;

/// 令牌有效期：足够听完一首歌，又不至于长期留着一个可被本机其它程序猜测的入口。
const TOKEN_TTL_SEC: u64 = 30 * 60;

/// 单次响应最多缓存的请求头字节数（防御畸形请求）。
const MAX_HEADER_BYTES: usize = 8 * 1024;

/// 上游连接超时（读取不设总时限：媒体流本来就是长连接）。
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

struct StreamEntry {
    origin: String,
    headers: Vec<(String, String)>,
    expires_at: u64,
}

/// 流令牌表 + 回环代理服务器。
///
/// 令牌表用 `Arc<Mutex<…>>`：`publish` 与代理线程必须看到**同一份**数据，
/// 因此表的句柄在构造时就固定下来，不做所有权搬运。
pub struct StreamRegistry {
    table: Arc<Mutex<HashMap<String, StreamEntry>>>,
    counter: AtomicU64,
    /// 已启动的代理端口（只启动一次）
    server: Mutex<Option<u16>>,
}

impl Default for StreamRegistry {
    fn default() -> Self {
        Self {
            table: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            server: Mutex::new(None),
        }
    }
}

impl StreamRegistry {
    /// 发布一个可播放地址，返回给前端的 `streamUrl`。
    pub fn publish(&self, origin: &str, headers: Vec<(String, String)>) -> Fallible<String> {
        validate_origin(origin)?;
        let port = self.ensure_server()?;

        let token = {
            let seq = self.counter.fetch_add(1, Ordering::Relaxed);
            format!("{}-{seq:x}", now_millis())
        };
        let entry = StreamEntry {
            origin: origin.to_string(),
            headers,
            expires_at: now_secs() + TOKEN_TTL_SEC,
        };
        self.table
            .lock()
            .map_err(|_| CoreError::internal("流令牌表锁已中毒"))?
            .insert(token.clone(), entry);

        Ok(format!("http://127.0.0.1:{port}/m/{token}"))
    }

    /// 启动回环服务器（只启动一次）。
    fn ensure_server(&self) -> Fallible<u16> {
        let mut server = self.server.lock().map_err(|_| CoreError::internal("流代理锁已中毒"))?;
        if let Some(port) = *server {
            return Ok(port);
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| {
            CoreError::new(ErrorCode::MediaProxyFailed, format!("绑定回环端口失败：{err}"))
        })?;
        let port = listener
            .local_addr()
            .map_err(|err| CoreError::new(ErrorCode::MediaProxyFailed, format!("读取端口失败：{err}")))?
            .port();

        // 代理线程持有表的克隆：与 publish 看到同一份数据
        let shared = Arc::clone(&self.table);

        std::thread::Builder::new()
            .name("gently-media-proxy".into())
            .spawn(move || {
                for incoming in listener.incoming() {
                    match incoming {
                        Ok(socket) => {
                            let table = Arc::clone(&shared);
                            // 一条连接一个线程：拖动进度会产生新的连接（并发 Range 请求）
                            let _ = std::thread::Builder::new()
                                .name("gently-media-conn".into())
                                .spawn(move || {
                                    if let Err(err) = serve(socket, &table) {
                                        tracing::debug!(%err, "媒体连接结束");
                                    }
                                });
                        }
                        Err(err) => tracing::warn!(%err, "接受媒体连接失败"),
                    }
                }
            })
            .map_err(|err| CoreError::new(ErrorCode::MediaProxyFailed, format!("启动代理线程失败：{err}")))?;

        tracing::info!(port, "本地流代理已启动（仅回环）");
        *server = Some(port);
        Ok(port)
    }
}

/// 媒体地址校验（SSRF 防护的第一道）：仅 HTTPS 且不得指向本机/内网。
pub fn validate_origin(origin: &str) -> Fallible<()> {
    if !origin.starts_with("https://") {
        return Err(CoreError::new(ErrorCode::MediaBlockedAddress, "媒体地址必须是 HTTPS"));
    }
    let host = crate::plugin::host_of(origin)
        .ok_or_else(|| CoreError::new(ErrorCode::MediaBlockedAddress, "无法解析媒体地址域名"))?;
    if is_private_host(&host) {
        return Err(CoreError::new(
            ErrorCode::MediaBlockedAddress,
            "媒体地址指向回环或内网，已拒绝（可能被用作访问本机的跳板）",
        )
        .with_details(json!({ "host": host })));
    }
    Ok(())
}

/// 处理一条连接：解析请求 → 取令牌 → 转发上游 → 回写响应。
fn serve(socket: TcpStream, table: &Mutex<HashMap<String, StreamEntry>>) -> std::io::Result<()> {
    socket.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(socket.try_clone()?);

    // 请求行
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    // 请求头（只需要 Range）
    let mut range: Option<String> = None;
    let mut consumed = line.len();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        consumed += header.len();
        if consumed > MAX_HEADER_BYTES {
            return write_simple(&socket, 431, "请求头过大");
        }
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }

    if method != "GET" {
        return write_simple(&socket, 405, "只支持 GET");
    }

    let token = target.trim_start_matches("/m/");
    if !target.starts_with("/m/") || token.is_empty() || token.contains('/') {
        return write_simple(&socket, 404, "未知媒体路径");
    }

    let entry = {
        let mut table = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 顺手清理过期令牌，避免长跑进程里堆积
        let now = now_secs();
        table.retain(|_, item| item.expires_at > now);
        table.get(token).map(|item| (item.origin.clone(), item.headers.clone()))
    };

    let Some((origin, headers)) = entry else {
        return write_simple(&socket, 404, "媒体令牌无效或已过期");
    };

    forward(&socket, &origin, &headers, range)
}

/// 转发上游响应（含 206 与请求头注入）。
fn forward(
    socket: &TcpStream,
    origin: &str,
    headers: &[(String, String)],
    range: Option<String>,
) -> std::io::Result<()> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(UPSTREAM_TIMEOUT)
        .timeout_read(UPSTREAM_TIMEOUT)
        .redirects(0)
        .build();

    let mut call = agent.get(origin);
    for (name, value) in headers {
        call = call.set(name, value);
    }
    if let Some(range) = &range {
        call = call.set("range", range);
    }

    let response = match call.call() {
        Ok(response) => response,
        // 上游用 4xx/5xx 回应是正常情况（如 Range 越界），照样转发状态码
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            return write_response(socket, status, &[], body.as_bytes());
        }
        Err(err) => {
            tracing::warn!(%err, "上游媒体请求失败");
            return write_simple(socket, 502, "上游媒体请求失败");
        }
    };

    let status = response.status();
    let mut out_headers: Vec<(String, String)> = vec![
        // 让浏览器知道可以按字节范围请求（拖动进度的前提）
        ("Accept-Ranges".into(), "bytes".into()),
        ("Cache-Control".into(), "no-store".into()),
        ("Connection".into(), "close".into()),
    ];
    for name in ["content-type", "content-length", "content-range"] {
        if let Some(value) = response.header(name) {
            out_headers.push((name.to_string(), value.to_string()));
        }
    }

    let mut body = response.into_reader();
    write_stream(socket, status, &out_headers, &mut body)
}

/// 写一个已知长度的响应。
fn write_response(
    socket: &TcpStream,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut out = socket.try_clone()?;
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    out.write_all(head.as_bytes())?;
    out.write_all(body)?;
    out.flush()
}

/// 流式写响应：已知长度就直接写；否则用 chunked（浏览器支持，且不需要预知总长）。
fn write_stream(
    socket: &TcpStream,
    status: u16,
    headers: &[(String, String)],
    body: &mut dyn Read,
) -> std::io::Result<()> {
    let mut out = socket.try_clone()?;
    let chunked = !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-length"));

    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if chunked {
        head.push_str("Transfer-Encoding: chunked\r\n");
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;

    let mut buffer = vec![0u8; 32 * 1024];
    loop {
        let read = match body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            // 客户端提前断开（切歌/拖动）时中止即可，不算错误
            Err(_) => break,
        };
        if chunked {
            out.write_all(format!("{read:x}\r\n").as_bytes())?;
            out.write_all(&buffer[..read])?;
            out.write_all(b"\r\n")?;
        } else {
            out.write_all(&buffer[..read])?;
        }
        out.flush()?;
    }

    if chunked {
        out.write_all(b"0\r\n\r\n")?;
    }
    out.flush()
}

fn write_simple(socket: &TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    write_response(socket, status, &[("Content-Type".into(), "text/plain; charset=utf-8".into())], message.as_bytes())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "OK",
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// 解析插件返回的 `getMediaSource` 结果。
///
/// 契约形状：`{url, headers?, quality?, mimeType?, expiresInSec?}`；返回 `null` 表示该源不可播。
/// 这里对**键名做宽松匹配**（`url`/`playUrl`、`headers`/`header`），因为社区插件的字段名并不统一。
pub fn parse_media(raw: &str) -> Fallible<Option<MediaSource>> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| CoreError::new(ErrorCode::PluginRuntimeError, format!("媒体信息不是合法 JSON：{err}")))?;

    if value.is_null() {
        return Ok(None);
    }
    let Some(object) = value.as_object() else {
        return Err(CoreError::new(ErrorCode::PluginRuntimeError, "媒体信息应为对象或 null"));
    };

    let url = ["url", "playUrl", "src"]
        .iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .map(str::to_string);
    let Some(url) = url else {
        return Err(CoreError::new(ErrorCode::PluginRuntimeError, "媒体信息缺少 url 字段"));
    };

    let headers = ["headers", "header"]
        .iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_object()))
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| value.as_str().map(|text| (name.clone(), text.to_string())))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Some(MediaSource {
        url,
        headers,
        quality: object.get("quality").and_then(|value| value.as_str()).map(str::to_string),
        mime_type: object.get("mimeType").and_then(|value| value.as_str()).map(str::to_string),
        expires_in_sec: object.get("expiresInSec").and_then(|value| value.as_u64()),
    }))
}

#[derive(Debug, Clone)]
pub struct MediaSource {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub quality: Option<String>,
    pub mime_type: Option<String>,
    pub expires_in_sec: Option<u64>,
}


