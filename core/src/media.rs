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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::contract::{CoreError, ErrorCode, Fallible};

/// 令牌有效期：足够听完一首歌，又不至于长期留着一个可被本机其它程序猜测的入口。
const TOKEN_TTL_SEC: u64 = 30 * 60;

/// 单次响应最多缓存的请求头字节数（防御畸形请求）。
const MAX_HEADER_BYTES: usize = 8 * 1024;

/// 上游连接超时（读取不设总时限：媒体流本来就是长连接）。
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

/// 一条流令牌指向什么。
///
/// 远端（插件的 `getMediaSource` 给的地址）与本地文件（本地曲库）走**同一条代理**：
/// 这样前端只有一条播放路径（拖动进度、请求头注入、无 Blob hack），
/// 也让「本地文件」重新享受 Range 支持。
#[derive(Debug, Clone)]
enum StreamTarget {
    /// 远端媒体：HTTP 转发 + 注入插件声明的请求头
    Remote { origin: String, headers: Vec<(String, String)> },
    /// 本地文件：直接读盘（同样支持 Range）
    Local { path: PathBuf },
}

struct StreamEntry {
    target: StreamTarget,
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
    /// 内嵌封面缓存目录：`/cover/<name>` **只**在这里取文件（由核心启动时注入）
    covers_dir: Arc<Mutex<Option<PathBuf>>>,
}

impl Default for StreamRegistry {
    fn default() -> Self {
        Self {
            table: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            server: Mutex::new(None),
            covers_dir: Arc::new(Mutex::new(None)),
        }
    }
}

impl StreamRegistry {
    /// 注入封面缓存目录（`local_library` 扫描时把内嵌封面落在这里，列表给回环地址）。
    pub fn set_covers_dir(&self, dir: PathBuf) {
        if let Ok(mut slot) = self.covers_dir.lock() {
            *slot = Some(dir);
        }
    }

    /// 给前端用的封面地址（封面不存在时返回 `None`，调用方退回渐变）。
    pub fn cover_url(&self, source: &Path) -> Fallible<Option<String>> {
        let dir = self
            .covers_dir
            .lock()
            .map_err(|_| CoreError::internal("封面目录锁已中毒"))?
            .clone();
        let Some(dir) = dir else { return Ok(None) };
        let store = crate::covers::CoverStore::new(dir);
        let Some(name) = store.existing(source) else {
            return Ok(None);
        };
        let port = self.ensure_server()?;
        Ok(Some(format!("http://127.0.0.1:{port}/cover/{name}")))
    }
    /// 发布一个可播放地址，返回给前端的 `streamUrl`。
    pub fn publish(&self, origin: &str, headers: Vec<(String, String)>) -> Fallible<String> {
        validate_origin(origin)?;
        self.publish_target(StreamTarget::Remote { origin: origin.to_string(), headers })
    }

    /// 发布一个**本地文件**的可播放地址（本地曲库走同一条代理）。
    ///
    /// 只接受音频扩展名且必须存在：这条路会让 WebView 读到磁盘文件，
    /// 因此白名单与扫描用的那一份完全一致（能被扫到的文件才允许被代理）。
    pub fn publish_local(&self, path: &Path) -> Fallible<String> {
        if !crate::local_library::is_audio_path(path) {
            return Err(CoreError::new(
                ErrorCode::MediaBlockedAddress,
                "只允许代理音频文件（扩展名不在白名单内）",
            )
            .with_details(json!({ "path": path.to_string_lossy() })));
        }
        if !path.is_file() {
            return Err(CoreError::not_found(format!("文件不存在：{}", path.display()))
                .with_details(json!({ "path": path.to_string_lossy() })));
        }
        self.publish_target(StreamTarget::Local { path: path.to_path_buf() })
    }

    /// 令牌 → 表（远端与本地共用同一条路径，避免两份发布逻辑）。
    fn publish_target(&self, target: StreamTarget) -> Fallible<String> {
        let port = self.ensure_server()?;
        let token = {
            let seq = self.counter.fetch_add(1, Ordering::Relaxed);
            format!("{}-{seq:x}", now_millis())
        };
        let entry = StreamEntry { target, expires_at: now_secs() + TOKEN_TTL_SEC };
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
        let covers = Arc::clone(&self.covers_dir);

        std::thread::Builder::new()
            .name("gently-media-proxy".into())
            .spawn(move || {
                for incoming in listener.incoming() {
                    match incoming {
                        Ok(socket) => {
                            let table = Arc::clone(&shared);
                            let covers = Arc::clone(&covers);
                            // 一条连接一个线程：拖动进度会产生新的连接（并发 Range 请求）
                            let _ = std::thread::Builder::new()
                                .name("gently-media-conn".into())
                                .spawn(move || {
                                    // INFO 级记一条「谁在取字节」：排查「界面在播但没声音」时，
                                    // 第一件要知道的事就是 WebView 到底有没有来请求（R34 的待查）。
                                    let peer = socket
                                        .peer_addr()
                                        .map(|addr| addr.to_string())
                                        .unwrap_or_else(|_| "unknown".into());
                                    tracing::info!(peer, "媒体连接已接受");
                                    if let Err(err) = serve(socket, &table, &covers) {
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
///
/// 规则实现只有一份（`plugin::transport::require_public_https`），下载链路用的是同一个函数。
pub fn validate_origin(origin: &str) -> Fallible<()> {
    crate::plugin::require_public_https(origin, "媒体地址")
}

/// 处理一条连接：解析请求 → 取令牌 → 转发上游 → 回写响应。
fn serve(
    socket: TcpStream,
    table: &Mutex<HashMap<String, StreamEntry>>,
    covers: &Mutex<Option<PathBuf>>,
) -> std::io::Result<()> {
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
    // 请求行也记下来：能区分「WebView 只做了探测」与「真的开始取流」
    tracing::info!(method = %method, target = %target, "媒体请求");

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

    /* 内嵌封面：`/cover/<32 位十六进制>.<图片扩展名>`，**只**在封面缓存目录里取文件
       （名字不合规直接 404，杜绝目录穿越与任意文件读取）。封面是列表里的缩略图，
       不需要 Range，也不进令牌表。 */
    if let Some(name) = target.strip_prefix("/cover/") {
        return serve_cover(&socket, name, covers);
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
        table.get(token).map(|item| item.target.clone())
    };

    let Some(target) = entry else {
        return write_simple(&socket, 404, "媒体令牌无效或已过期");
    };

    match target {
        StreamTarget::Remote { origin, headers } => forward(&socket, &origin, &headers, range),
        StreamTarget::Local { path } => serve_local(&socket, &path, range),
    }
}

/// 内嵌封面：从封面缓存目录读一张图片。
///
/// **安全边界**：文件名必须是 `<32 位小写十六进制>.<白名单图片扩展名>`，
/// 且在缓存目录里真实存在——除此之外任何输入都是 404（不给出「为什么」的细节，
/// 免得变成一个探测本机文件的接口）。
fn serve_cover(
    socket: &TcpStream,
    name: &str,
    covers: &Mutex<Option<PathBuf>>,
) -> std::io::Result<()> {
    let dir = covers.lock().ok().and_then(|slot| slot.clone());
    let Some(dir) = dir else {
        return write_simple(socket, 404, "封面缓存未启用");
    };
    let store = crate::covers::CoverStore::new(dir);
    let Some(path) = store.resolve(name) else {
        return write_simple(socket, 404, "封面不存在");
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return write_simple(socket, 404, "封面不可读");
    };
    let headers = vec![
        ("Cache-Control".to_string(), "no-store".to_string()),
        ("Content-Type".to_string(), content_type_of(&path)),
        ("Content-Length".to_string(), meta.len().to_string()),
    ];
    tracing::debug!(name, "封面请求");
    let Ok(mut file) = std::fs::File::open(&path) else {
        return write_simple(socket, 404, "封面不可读");
    };
    write_stream(socket, 200, &headers, &mut file)
}

/// 本地文件：读盘 + Range（拖动进度靠它）。///
/// 响应头里不出现文件路径，只有长度与类型——代理不该成为「目录浏览器」。
fn serve_local(socket: &TcpStream, path: &Path, range: Option<String>) -> std::io::Result<()> {
    let Ok(meta) = std::fs::metadata(path) else {
        return write_simple(socket, 404, "文件不可读");
    };
    let total = meta.len();
    let content_type = content_type_of(path);

    let base_headers = vec![
        ("Accept-Ranges".to_string(), "bytes".to_string()),
        ("Cache-Control".to_string(), "no-store".to_string()),
        ("Content-Type".to_string(), content_type),
    ];

    let Some((start, end)) = resolve_range(range.as_deref(), total) else {
        // 越界/语法错误的 Range：按 HTTP 语义回 416，并说明总长度
        let mut headers = base_headers;
        headers.push(("Content-Range".to_string(), format!("bytes */{total}")));
        return write_response(socket, 416, &headers, b"");
    };

    let length = end.saturating_sub(start);
    let status = if range.is_some() { 206 } else { 200 };
    // 记「回了什么」：排查「界面在播但没声音」时，要能区分
    // 「WebView 没来取」「取了一部分」「取全了但没播」三种情况（R34 的待查）。
    tracing::info!(
        status,
        start,
        end,
        total,
        has_range = range.is_some(),
        "媒体响应（本地文件）"
    );
    let mut headers = base_headers;
    headers.push(("Content-Length".to_string(), length.to_string()));
    if status == 206 {
        headers.push((
            "Content-Range".to_string(),
            format!("bytes {start}-{}/{}", end.saturating_sub(1), total),
        ));
    }

    let Ok(mut file) = std::fs::File::open(path) else {
        return write_simple(socket, 404, "文件不可读");
    };
    if start > 0 && std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(start)).is_err() {
        return write_simple(socket, 500, "读取文件失败");
    }
    write_stream(socket, status, &headers, &mut file.take(length))
}

/// Range 解析：`bytes=start-end` / `bytes=start-` / `bytes=-suffix`。
///
/// 返回「要发送的字节区间」`[start, end)`；`None` = 416（越界或语法错误）。
/// 没有 Range 头时返回整个文件。
fn resolve_range(spec: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let Some(spec) = spec else { return Some((0, total)) };
    let spec = spec.trim().strip_prefix("bytes=")?;
    // 只支持单区间（多区间回 416 更安全：没必要为它实现 multipart）
    if spec.contains(',') {
        return None;
    }
    let (start_text, end_text) = spec.split_once('-')?;
    if start_text.is_empty() {
        // `-N`：最后 N 字节
        let suffix: u64 = end_text.trim().parse().ok()?;
        if suffix == 0 || total == 0 {
            return None;
        }
        return Some((total.saturating_sub(suffix), total));
    }
    let start: u64 = start_text.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = match end_text.trim() {
        "" => total,
        text => text.parse::<u64>().ok()?.saturating_add(1).min(total),
    };
    if end <= start {
        return None;
    }
    Some((start, end))
}

/// 扩展名 → MIME（WebView 需要它才不会把文件当成下载）。
fn content_type_of(path: &Path) -> String {
    match path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a") | Some("mp4") | Some("m4s") | Some("aac") => "audio/mp4",
        Some("ogg") | Some("oga") | Some("opus") => "audio/ogg",
        Some("wav") => "audio/wav",
        // 内嵌封面（`/cover/<name>` 走这里）：扩展名来自 `covers::COVER_EXTENSIONS`
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => OCTET_STREAM,
    }
    .to_string()
}

/// 通用二进制类型：`<audio>` 见到它就拒绝解码（`.m4s` 这类非常规扩展名常见）。
const OCTET_STREAM: &str = "application/octet-stream";

/// 决定转发给 WebView 的 `Content-Type`。
///
/// 上游用 `application/octet-stream`（或干脆不给）下发音频时，`<audio>` 会拒绝解码，
/// 而按**地址扩展名**补一个音频类型就能播——这件事必须在代理层做一次，
/// 前端因此不需要「抓成 Blob 再强制 `audio/mp4`」这种 hack（M3 的退出标准之一）。
///
/// 只在上游类型缺失或属于通用二进制时才猜；上游给出具体类型时一律照抄，不覆盖。
fn effective_content_type(origin: &str, upstream: Option<&str>) -> Option<String> {
    let specific = upstream.filter(|value| {
        let essence = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        !essence.is_empty()
            && essence != OCTET_STREAM
            && essence != "binary/octet-stream"
            && essence != "application/force-download"
    });
    if let Some(value) = specific {
        return Some(value.to_string());
    }

    // 地址可能是带查询串/片段的完整 URL：只看路径部分的扩展名
    let path = origin.split(['?', '#']).next().unwrap_or(origin);
    let guessed = content_type_of(Path::new(path));
    if guessed == OCTET_STREAM {
        upstream.map(str::to_string)
    } else {
        Some(guessed)
    }
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
    // 与插件出网通道共用同一份「出站头」处理：**我们不解压**，插件却常常照抄浏览器的
    // `accept-encoding: gzip, deflate, br`（B 站插件给的媒体头里就有）。转发压缩体不只是
    // 解码不了——`Content-Length` / `Content-Range` 会与实际字节数对不上，Range 拖动直接坏掉。
    for (name, value) in crate::plugin::outgoing_headers(headers) {
        call = call.set(&name, &value);
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
    let upstream_type = response.header("content-type").map(str::to_string);
    let mut out_headers: Vec<(String, String)> = vec![
        // 让浏览器知道可以按字节范围请求（拖动进度的前提）
        ("Accept-Ranges".into(), "bytes".into()),
        ("Cache-Control".into(), "no-store".into()),
        ("Connection".into(), "close".into()),
    ];
    if let Some(value) = effective_content_type(origin, upstream_type.as_deref()) {
        out_headers.push(("Content-Type".into(), value));
    }
    for name in ["content-length", "content-range"] {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 上游给出具体音频类型时**照抄**（含 `; charset` 之类的参数），不做任何猜测。
    #[test]
    fn keeps_specific_upstream_content_type() {
        assert_eq!(
            effective_content_type("http://example.com/a.m4s", Some("audio/mpeg; charset=utf-8")),
            Some("audio/mpeg; charset=utf-8".to_string())
        );
        assert_eq!(
            effective_content_type("http://example.com/a.mp3", Some("audio/flac")),
            Some("audio/flac".to_string()),
            "上游说是 flac 就按 flac 转发，不按扩展名改判"
        );
    }

    /// 上游给 `application/octet-stream`（或缺失）时按地址扩展名补类型：
    /// 这正是前端当年那个「抓 Blob 再强制 audio/mp4」hack 要解决的问题。
    #[test]
    fn guesses_audio_type_when_upstream_is_generic() {
        for generic in [None, Some("application/octet-stream"), Some("binary/octet-stream")] {
            assert_eq!(
                effective_content_type("http://example.com/media/song.m4s?token=1", generic),
                Some("audio/mp4".to_string()),
                "上游类型 {generic:?} 时应按 .m4s 猜成 audio/mp4"
            );
        }
        assert_eq!(
            effective_content_type("http://example.com/x.flac", Some("application/octet-stream")),
            Some("audio/flac".to_string())
        );
    }

    /// 猜不出来时保持上游原样（不伪造类型），完全缺失时也不硬塞。
    #[test]
    fn leaves_unknown_extensions_alone() {
        assert_eq!(
            effective_content_type("http://example.com/stream", Some(OCTET_STREAM)),
            Some(OCTET_STREAM.to_string())
        );
        assert_eq!(effective_content_type("http://example.com/stream", None), None);
        assert_eq!(
            effective_content_type("http://example.com/a.bin", Some("text/plain")),
            Some("text/plain".to_string()),
            "非音频的具体类型也照抄——代理不做内容嗅探"
        );
    }

    /// 本地文件按扩展名给出 MIME（`.m4s` 与本地白名单无关，只是同一个映射表）。
    #[test]
    fn maps_extensions_to_mime() {
        assert_eq!(content_type_of(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(content_type_of(Path::new("a.FLAC")), "audio/flac");
        assert_eq!(content_type_of(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(content_type_of(Path::new("a.m4s")), "audio/mp4");
        assert_eq!(content_type_of(Path::new("a.opus")), "audio/ogg");
        assert_eq!(content_type_of(Path::new("a.txt")), OCTET_STREAM);
        assert_eq!(content_type_of(Path::new("noext")), OCTET_STREAM);
    }
}


