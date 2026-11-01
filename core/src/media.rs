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

/// 允许跟随的上游跳转次数（302 → CDN 是常态；Ring 用不上更多）
const MAX_UPSTREAM_REDIRECTS: u32 = 3;

/// 一条流令牌指向什么。
///
/// 远端（插件的 `getMediaSource` 给的地址）与本地文件（本地曲库）走**同一条代理**：
/// 这样前端只有一条播放路径（拖动进度、请求头注入、无 Blob hack），
/// 也让「本地文件」重新享受 Range 支持。
#[derive(Debug, Clone)]
enum StreamTarget {
    /// 远端媒体：HTTP 转发 + 注入插件声明的请求头
    ///
    /// `mime` 是插件在 `getMediaSource` 里声明的 `mimeType`（契约里本来就有这个字段，
    /// R110 之前被丢掉了）：字节嗅不出来时它是第二顺位的证据。
    Remote { origin: String, headers: Vec<(String, String)>, mime: Option<String> },
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
    ///
    /// `mime` 来自插件声明的 `mimeType`（可空）：代理会优先按**字节**判断容器类型，
    /// 嗅不出来时才用它（见 `effective_content_type`）。
    pub fn publish(
        &self,
        origin: &str,
        headers: Vec<(String, String)>,
        mime: Option<String>,
    ) -> Fallible<String> {
        validate_origin(origin)?;
        self.publish_target(StreamTarget::Remote {
            origin: origin.to_string(),
            headers,
            mime,
        })
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
        StreamTarget::Remote { origin, headers, mime } => {
            forward(&socket, &origin, &headers, range, mime.as_deref())
        }
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
        // 与远端转发保持同一套 CORS：本地文件同样经回环代理交给 WebView，
        // 页面在 `http://tauri.localhost`，因此这条路也跨源（排查时要能直接取字节）。
        ("Access-Control-Allow-Origin".to_string(), "*".to_string()),
        (
            "Access-Control-Expose-Headers".to_string(),
            "Content-Length, Content-Range, Accept-Ranges".to_string(),
        ),
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

/// 嗅探时最多看多少字节（够覆盖所有音频容器签名，又不至于拖慢首字节）。
const SNIFF_BYTES: usize = 512;

/// 这段 Range 是不是从第 0 字节开始（`bytes=0-…` / 没有 Range）。
///
/// 只在这种情况下能嗅探容器头：媒体元素的首个请求几乎总是 `Range: bytes=0-`，
/// 如果因为它带了 Range 就放弃嗅探，那这层修复在**真实播放路径上等于没做**。
fn range_starts_at_zero(spec: Option<&str>) -> bool {
    let Some(spec) = spec else { return true };
    let spec = spec.trim();
    let Some(rest) = spec.strip_prefix("bytes=") else { return false };
    let Some((start, _)) = rest.split_once('-') else { return false };
    start.trim().parse::<u64>().map(|value| value == 0).unwrap_or(false)
}

/// 按**字节**判断音频容器，返回应当告诉浏览器的 MIME。
///
/// 为什么非要有这一步：浏览器是**按 `Content-Type` 挑解复用器**的，上游经常给
/// `application/octet-stream` 或者干脆不给（B 站的 `.m4s` 分离音轨就是这种），
/// 而地址又没有能猜的扩展名。桌面 Chromium 有时靠 FFmpeg 自己嗅探蒙对，
/// 安卓 WebView 蒙不对就报 `DEMUXER_ERROR_COULD_NOT_OPEN: open context failed`
/// （表现是「播放条在走、没有声音」，R108/R109 卡在这里的根因）。
fn sniff_audio_type(prefix: &[u8]) -> Option<&'static str> {
    if prefix.len() >= 12 && &prefix[4..8] == b"ftyp" {
        // ISO BMFF（m4a / m4s / mp4）：片段式 DASH 音轨也在这里
        return Some("audio/mp4");
    }
    if prefix.starts_with(b"ID3") {
        return Some("audio/mpeg");
    }
    if prefix.starts_with(b"fLaC") {
        return Some("audio/flac");
    }
    if prefix.starts_with(b"OggS") {
        return Some("audio/ogg");
    }
    if prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if prefix.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        // EBML（webm / mkv）
        return Some("audio/webm");
    }
    if prefix.starts_with(b"#!AMR") {
        return Some("audio/amr");
    }
    if prefix.len() >= 2 && prefix[0] == 0xFF && (prefix[1] & 0xE0) == 0xE0 {
        /* MPEG 音频帧同步字（0xFFEx / 0xFFFx）。layer 位为 0 的是 ADTS 的 AAC，
           其余按 MP3 处理——两者都喂给 FFmpeg 时它自己还会再判一次。 */
        return Some(if prefix[1] & 0xF6 == 0xF0 { "audio/aac" } else { "audio/mpeg" });
    }
    None
}

/// 先读一小段前缀用于嗅探；读满、读到 EOF 或**认出类型就停**（不耽误首字节）。
fn read_sniff_prefix(body: &mut dyn Read) -> Vec<u8> {
    let mut buffer = vec![0u8; SNIFF_BYTES];
    let mut filled = 0;
    while filled < SNIFF_BYTES {
        match body.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => {
                filled += read;
                if filled >= 12 && sniff_audio_type(&buffer[..filled]).is_some() {
                    break;
                }
            }
            // 上游抖一下就先把已有的字节发出去：剩下的交给后面的循环
            Err(_) => break,
        }
    }
    buffer.truncate(filled);
    buffer
}

/// 上游类型是不是「说了等于没说」的通用二进制。
fn is_generic_type(value: &str) -> bool {
    let essence = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    essence.is_empty()
        || essence == OCTET_STREAM
        || essence == "binary/octet-stream"
        || essence == "application/force-download"
}

/// 决定转发给 WebView 的 `Content-Type`。
///
/// 优先级（越靠前越硬）：**字节嗅探** → 插件声明的 `mimeType` → 上游给的具体类型 →
/// 地址扩展名 → 上游原样。理由是这次的教训：上游标什么、地址叫什么，都可能与实际字节
/// 不符，而浏览器只信 `Content-Type`。嗅探只在**非 Range 请求**上做（第二段字节不是容器头）。
fn effective_content_type(
    origin: &str,
    upstream: Option<&str>,
    declared: Option<&str>,
    sniffed: Option<&str>,
) -> Option<String> {
    if let Some(value) = sniffed {
        return Some(value.to_string());
    }
    if let Some(value) = declared.filter(|value| !is_generic_type(value)) {
        return Some(value.to_string());
    }
    if let Some(value) = upstream.filter(|value| !is_generic_type(value)) {
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
    declared_mime: Option<&str>,
) -> std::io::Result<()> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(UPSTREAM_TIMEOUT)
        .timeout_read(UPSTREAM_TIMEOUT)
        // 上游常常是「302 到 CDN」：网易云的外链就 302 到 http 的 m70x.music.126.net。
        // 以前这里是 redirects(0)，302 被原样转给 WebView，而页面在 tauri://localhost 里，
        // 跟去 http CDN 属于混合内容 → 直接被拦，表现成「播放条在走但没声音」。
        // 改由代理自己跟（次数有上限），浏览器就只跟回环代理打交道。
        .redirects(MAX_UPSTREAM_REDIRECTS)
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
    let upstream_length = response.header("content-length").map(str::to_string);
    let upstream_range = response.header("content-range").map(str::to_string);
    let mut body = response.into_reader();
    /* Range 请求要的是「第 N 字节之后」的那一段，头几个字节已经不是容器签名了，
       这时候嗅探只会得出错误结论；只挑「从 0 开始」的响应嗅探（含媒体元素惯用的
       `bytes=0-`，否则这层修复在真实播放路径上等于没做 → R110 的教训）。 */
    let sniffable = range_starts_at_zero(range.as_deref());
    let prefix = if sniffable { read_sniff_prefix(&mut body) } else { Vec::new() };
    let sniffed = sniff_audio_type(&prefix);
    let content_type = effective_content_type(origin, upstream_type.as_deref(), declared_mime, sniffed);

    let mut out_headers: Vec<(String, String)> = vec![
        // 让浏览器知道可以按字节范围请求（拖动进度的前提）
        ("Accept-Ranges".into(), "bytes".into()),
        ("Cache-Control".into(), "no-store".into()),
        ("Connection".into(), "close".into()),
        /* 放宽 CORS：媒体走的是 `http://127.0.0.1:<port>`，与页面（`http://tauri.localhost`）
           本来就跨源。`<audio>` 不看 CORS，但「抓一段字节看看它到底是什么」这种排查
           （以及将来可能加的 `crossorigin` 分析）需要它；只暴露只读的传输头，不涉及凭据。 */
        ("Access-Control-Allow-Origin".into(), "*".into()),
        ("Access-Control-Expose-Headers".into(), "Content-Length, Content-Range, Accept-Ranges".into()),
    ];
    if let Some(value) = &content_type {
        out_headers.push(("Content-Type".into(), value.clone()));
    }
    if let Some(value) = &upstream_length {
        out_headers.push(("Content-Length".into(), value.clone()));
    }
    if let Some(value) = &upstream_range {
        out_headers.push(("Content-Range".into(), value.clone()));
    }

    /* 一次能看全的响应记下来：以后遇到「播不出声」先看这几行，不要再去猜
       （以前这里只有一行「媒体请求」，看不出上游给的是音频还是错误页）。 */
    tracing::info!(
        status,
        content_type = content_type.as_deref().unwrap_or("(none)"),
        upstream_type = upstream_type.as_deref().unwrap_or("(none)"),
        sniffed = sniffed.unwrap_or("(unknown)"),
        prefix_len = prefix.len(),
        "媒体响应"
    );
    if sniffed.is_none()
        && sniffable
        && !content_type.as_deref().is_some_and(|value| value.starts_with("audio/"))
    {
        tracing::warn!(
            upstream_type = upstream_type.as_deref().unwrap_or("(none)"),
            "上游返回的不是可识别的音频（多半是错误页 / 需要登录 / 需要请求头）"
        );
    }

    let mut rest: &mut dyn Read = &mut body;
    let mut full = std::io::Cursor::new(prefix).chain(rest);
    write_stream(socket, status, &out_headers, &mut full)
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

    /// 上游给出具体音频类型时照抄（含 `; charset` 之类的参数）。
    #[test]
    fn keeps_specific_upstream_content_type() {
        assert_eq!(
            effective_content_type("http://example.com/a.m4s", Some("audio/mpeg; charset=utf-8"), None, None),
            Some("audio/mpeg; charset=utf-8".to_string())
        );
        assert_eq!(
            effective_content_type("http://example.com/a.mp3", Some("audio/flac"), None, None),
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
                effective_content_type("http://example.com/media/song.m4s?token=1", generic, None, None),
                Some("audio/mp4".to_string()),
                "上游类型 {generic:?} 时应按 .m4s 猜成 audio/mp4"
            );
        }
        assert_eq!(
            effective_content_type("http://example.com/x.flac", Some("application/octet-stream"), None, None),
            Some("audio/flac".to_string())
        );
    }

    /// 猜不出来时保持上游原样（不伪造类型），完全缺失时也不硬塞。
    #[test]
    fn leaves_unknown_extensions_alone() {
        assert_eq!(
            effective_content_type("http://example.com/stream", Some(OCTET_STREAM), None, None),
            Some(OCTET_STREAM.to_string())
        );
        assert_eq!(effective_content_type("http://example.com/stream", None, None, None), None);
        assert_eq!(
            effective_content_type("http://example.com/a.bin", Some("text/plain"), None, None),
            Some("text/plain".to_string()),
            "非音频的具体类型也照抄——猜不出来时别替上游改口"
        );
    }

    /// **字节嗅探排在最前**：上游说 octet-stream、地址没有扩展名，但字节是 fMP4
    /// （B 站 `.m4s` 分离音轨的典型形态）——这时必须告诉浏览器 `audio/mp4`，
    /// 否则安卓 WebView 报 `DEMUXER_ERROR_COULD_NOT_OPEN`（R108/R109 卡死的根因）。
    #[test]
    fn sniffs_the_container_from_bytes() {
        let fmp4 = b"\x00\x00\x00\x20ftypiso5\x00\x00\x02\x00isomiso5dash";
        assert_eq!(sniff_audio_type(fmp4), Some("audio/mp4"));
        assert_eq!(sniff_audio_type(b"ID3\x04\x00\x00\x00\x00\x00\x00"), Some("audio/mpeg"));
        assert_eq!(sniff_audio_type(b"fLaC\x00\x00\x00\x22"), Some("audio/flac"));
        assert_eq!(sniff_audio_type(b"OggS\x00\x02\x00\x00"), Some("audio/ogg"));
        assert_eq!(sniff_audio_type(b"RIFF\x24\x08\x00\x00WAVEfmt "), Some("audio/wav"));
        assert_eq!(sniff_audio_type(&[0xFF, 0xFB, 0x90, 0x64]), Some("audio/mpeg"), "MP3 帧同步");
        assert_eq!(sniff_audio_type(&[0xFF, 0xF1, 0x50, 0x80]), Some("audio/aac"), "ADTS");
        assert_eq!(sniff_audio_type(b"<html><body>403"), None, "错误页认不出来");
        assert_eq!(sniff_audio_type(b""), None);

        assert_eq!(
            effective_content_type(
                "https://cdn.example.com/upos-sz-mirror/x?auth=1",
                Some(OCTET_STREAM),
                None,
                Some("audio/mp4")
            ),
            Some("audio/mp4".to_string()),
            "嗅探结果优先于「上游说是 octet-stream」"
        );
    }

    /// 插件声明的 `mimeType` 是第二顺位证据（契约里有这个字段，以前被代理丢掉了）。
    #[test]
    fn honours_the_plugin_declared_mime_type() {
        assert_eq!(
            effective_content_type("http://example.com/stream", Some(OCTET_STREAM), Some("audio/mp4"), None),
            Some("audio/mp4".to_string())
        );
        assert_eq!(
            effective_content_type("http://example.com/stream", Some(OCTET_STREAM), Some(OCTET_STREAM), None),
            Some(OCTET_STREAM.to_string()),
            "声明的也是通用类型时不算证据，继续往下看"
        );
    }

    /// 媒体元素的首个请求几乎总是 `bytes=0-`：这种情况**必须**嗅探（否则修复形同不存在）。
    #[test]
    fn range_from_zero_is_still_sniffable() {
        assert!(range_starts_at_zero(None), "没有 Range = 整段，当然能嗅");
        assert!(range_starts_at_zero(Some("bytes=0-")), "媒体元素惯用它");
        assert!(range_starts_at_zero(Some("bytes=0-2047")));
        assert!(!range_starts_at_zero(Some("bytes=2048-")), "从中间开始就不是容器头了");
        assert!(!range_starts_at_zero(Some("bytes=-512")), "后缀区间也不是");
        assert!(!range_starts_at_zero(Some("garbage")));
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

    /// **端到端**：上游只给 `application/octet-stream`、地址没有扩展名、浏览器还带
    /// `Range: bytes=0-` —— 代理仍要按字节认出 fMP4 并回 `Content-Type: audio/mp4`，
    /// 且字节一个不少（前缀嗅探过的部分要重新吐出来）。
    #[test]
    fn forwards_sniffed_audio_type_for_a_plain_range_request() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::thread;

        let body: Vec<u8> = {
            let mut bytes = b"\x00\x00\x00\x20ftypiso5\x00\x00\x02\x00isomiso5dash".to_vec();
            bytes.extend_from_slice(b"PAYLOAD");
            bytes
        };

        let upstream = TcpListener::bind("127.0.0.1:0").expect("bind upstream");
        let upstream_url = format!("http://{}/upos/stream?auth=1", upstream.local_addr().expect("addr"));
        let expected = body.clone();
        let upstream_thread = thread::spawn(move || {
            let (mut socket, _) = upstream.accept().expect("accept");
            let mut buffer = [0u8; 2048];
            let _ = socket.read(&mut buffer);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                expected.len()
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(&expected);
        });

        let client = TcpListener::bind("127.0.0.1:0").expect("bind client");
        let client_port = client.local_addr().expect("client addr").port();
        let writer = TcpStream::connect(("127.0.0.1", client_port)).expect("connect client");
        let (reader, _) = client.accept().expect("accept client");

        forward(&writer, &upstream_url, &[], Some("bytes=0-".into()), None).expect("forward ok");
        drop(writer);

        let mut response = Vec::new();
        (&reader).read_to_end(&mut response).expect("read response");
        upstream_thread.join().expect("joined");

        let text = String::from_utf8_lossy(&response).to_string();
        assert!(
            text.to_ascii_lowercase().contains("content-type: audio/mp4"),
            "带 Range 的整段请求也要按字节认出音频：{text}"
        );
        assert!(
            text.contains("Access-Control-Allow-Origin: *"),
            "回环代理要放宽 CORS（页面是 http://tauri.localhost）：{text}"
        );
        let body_start = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("headers end")
            + 4;
        assert_eq!(&response[body_start..], &body[..], "嗅探过的前缀不能丢字节");
    }

    /// **代理自己跟 302**：上游先回 302 指向另一台「CDN」，代理要把后者的音频字节
    /// （206 + Content-Range）转给客户端，而不是把 302 丢给 WebView——那样在 `tauri://`
    /// 页面里跟去 http CDN 会被当混合内容拦掉，表现成「播放条在走、没有声音」。
    #[test]
    fn follows_upstream_redirect_and_forwards_range_bytes() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::thread;

        // 「CDN」：真的回 206 + 一小段音频
        let cdn = TcpListener::bind("127.0.0.1:0").expect("bind cdn");
        let cdn_url = format!("http://{}/x.mp3", cdn.local_addr().expect("cdn addr"));
        let cdn_thread = thread::spawn(move || {
            let (mut socket, _) = cdn.accept().expect("accept cdn");
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer);
            let body = b"AUDIOBYTES";
            let head = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Range: bytes 0-9/100\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(body);
        });

        // 「上游」：只回 302
        let origin = TcpListener::bind("127.0.0.1:0").expect("bind origin");
        let origin_url =
            format!("http://{}/song/media/outer/url?id=1.mp3", origin.local_addr().expect("origin addr"));
        let origin_thread = thread::spawn(move || {
            let (mut socket, _) = origin.accept().expect("accept origin");
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer);
            let head = format!(
                "HTTP/1.1 302 Found\r\nLocation: {cdn_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = socket.write_all(head.as_bytes());
        });

        // 客户端：拿一条真实 socket，让代理往里写
        let client = TcpListener::bind("127.0.0.1:0").expect("bind client");
        let client_port = client.local_addr().expect("client addr").port();
        let writer = TcpStream::connect(("127.0.0.1", client_port)).expect("connect client");
        let (reader, _) = client.accept().expect("accept client");

        forward(&writer, &origin_url, &[], Some("bytes=0-9".into()), None).expect("forward ok");
        drop(writer);

        let mut response = Vec::new();
        (&reader).read_to_end(&mut response).expect("read response");
        let text = String::from_utf8_lossy(&response).to_string();
        origin_thread.join().expect("origin joined");
        cdn_thread.join().expect("cdn joined");

        assert!(text.starts_with("HTTP/1.1 206"), "应当转发上游的 206：{text}");
        assert!(text.contains("AUDIOBYTES"), "应当转发 CDN 的音频字节：{text}");
        assert!(!text.contains("302 Found"), "302 不该原样转给客户端：{text}");
    }
}


