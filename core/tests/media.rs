//! 媒体解析与本地流代理的测试（M2 播放链路）。
//!
//! 注意一个**设计上的边界**：代理发布令牌前会拒绝回环/内网地址（SSRF 防护），
//! 因此**无法**在测试里用「本机起的 origin 服务器」做端到端串流——这是防护生效的证据，
//! 不是测试缺口。这里按能力边界分层验证：
//! - 地址校验（含 M2 退出标准「指向 127.0.0.1 的媒体被拒」）；
//! - 插件返回值的解析（含社区插件的字段别名）；
//! - 候选回退（一个源失败/返回 null → 切下一个；全失败 → `data: null`）；
//! - 代理本身的存活与令牌校验（未知令牌 404）。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::events::EventSink;
use gently_core::media::{parse_media, validate_origin};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

struct OfflineTransport;

impl HttpTransport for OfflineTransport {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

fn setup() -> (CoreContext, std::path::PathBuf) {
    let dir = common::temp_dir("media");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths)
        .with_store(store)
        .with_events(Arc::new(NullSink))
        .with_http(Arc::new(OfflineTransport));
    (ctx, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn install(ctx: &CoreContext, source: &str) {
    let value = call(ctx, "plugin.import", json!({ "from": { "kind": "paste", "content": source }, "consent": true }));
    assert_eq!(value["ok"], json!(true), "{value}");
}

/// 插件：始终返回 null（该源不可播）
const PLUGIN_NULL: &str = r#"
// @id null-source
// @name 不可播源
// @version 1.0.0
// @author tester
async function getMediaSource(track, quality) { return null; }
"#;

/// 插件：返回一个私网地址（应被 SSRF 防护拒绝）
const PLUGIN_PRIVATE: &str = r#"
// @id private-source
// @name 私网源
// @version 1.0.0
// @author tester
async function getMediaSource(track, quality) {
    return {url: 'https://127.0.0.1:8443/secret.mp3', headers: {'Referer': 'https://example.com'}};
}
"#;

/// 插件：正常返回公网地址（并带上请求头，验证会被代理注入）
const PLUGIN_OK: &str = r#"
// @id ok-source
// @name 正常源
// @version 1.0.0
// @author tester
async function getMediaSource(track, quality) {
    return {url: 'https://cdn.example.com/a.m4a', headers: {'Referer': 'https://example.com'}, quality: 'high'};
}
"#;

#[test]
fn media_origin_validation_blocks_local_and_plain_http() {
    // 公网 HTTPS 允许
    assert!(validate_origin("https://cdn.example.com/a.m4a").is_ok());

    // M2 退出标准：指向 127.0.0.1 必须被拒
    for blocked in [
        "https://127.0.0.1/a.mp3",
        "https://localhost/a.mp3",
        "https://192.168.1.20/a.mp3",
        "https://10.0.0.2/a.mp3",
        "https://169.254.1.1/a.mp3",
        "http://cdn.example.com/a.mp3",
    ] {
        let error = validate_origin(blocked).unwrap_err();
        assert_eq!(error.code, ErrorCode::MediaBlockedAddress, "{blocked}");
    }
}

#[test]
fn plugin_media_payload_tolerates_field_aliases() {
    // 契约形状
    let parsed = parse_media(r#"{"url":"https://a.example.com/x.mp3","headers":{"a":"b"}}"#)
        .unwrap()
        .expect("应解析出媒体");
    assert_eq!(parsed.url, "https://a.example.com/x.mp3");
    assert_eq!(parsed.headers, vec![("a".to_string(), "b".to_string())]);

    // 社区插件常见的字段别名
    let parsed = parse_media(r#"{"playUrl":"https://b.example.com/y.mp3","header":{"Referer":"https://b.example.com"}}"#)
        .unwrap()
        .expect("应识别 playUrl/header 别名");
    assert_eq!(parsed.url, "https://b.example.com/y.mp3");
    assert_eq!(parsed.headers.len(), 1);

    // 不可播
    assert!(parse_media("null").unwrap().is_none());

    // 缺少 url / 非对象 → 插件运行时错误（让作者知道返回值不符合约定）
    assert_eq!(
        parse_media(r#"{"headers":{}}"#).unwrap_err().code,
        ErrorCode::PluginRuntimeError
    );
    assert_eq!(parse_media("42").unwrap_err().code, ErrorCode::PluginRuntimeError);
}

#[test]
fn resolve_falls_back_across_candidates_and_returns_null_when_all_fail() {
    let (ctx, dir) = setup();
    install(&ctx, PLUGIN_NULL);
    install(&ctx, PLUGIN_PRIVATE);
    install(&ctx, PLUGIN_OK);
    // 让私网源排在正常源之前：它会被拒，然后应继续回退到正常源
    assert_eq!(call(&ctx, "plugin.setPriority", json!({ "id": "private-source", "priority": 10 }))["ok"], json!(true));
    assert_eq!(call(&ctx, "plugin.setPriority", json!({ "id": "ok-source", "priority": 20 }))["ok"], json!(true));
    assert_eq!(call(&ctx, "plugin.setPriority", json!({ "id": "null-source", "priority": 5 }))["ok"], json!(true));

    let value = call(
        &ctx,
        "playback.resolve",
        json!({
            "reference": "ok-source:1",
            "quality": "high",
            "candidates": ["null-source:1", "private-source:1", "ok-source:1"],
        }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    let data = &value["data"];
    assert_eq!(data["source"], json!("ok-source"), "应回退到可播的源");
    // 前端只该用 streamUrl，且它必须指向本机回环代理
    let stream_url = data["streamUrl"].as_str().unwrap();
    assert!(stream_url.starts_with("http://127.0.0.1:"), "{stream_url}");
    assert!(stream_url.contains("/m/"));
    // 原始地址与请求头仅供排障（前端不要直接用）
    assert_eq!(data["originUrl"], json!("https://cdn.example.com/a.m4a"));
    assert_eq!(data["headers"]["Referer"], json!("https://example.com"));
    assert_eq!(data["quality"], json!("high"), "插件给出的实际档位优先");

    // 全部候选都不可播 → data: null（前端据此退回模拟时钟），而不是错误
    let value = call(
        &ctx,
        "playback.resolve",
        json!({ "reference": "null-source:1", "quality": "standard", "candidates": ["null-source:1", "private-source:1"] }),
    );
    assert_eq!(value["ok"], json!(true));
    assert_eq!(value["data"], json!(null));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn proxy_is_loopback_only_and_rejects_unknown_tokens() {
    let (ctx, dir) = setup();

    // 发布一个令牌（地址是公网 https，不会被拒）
    let stream_url = ctx
        .streams
        .publish(
            "https://cdn.example.com/a.m4a",
            vec![("Referer".into(), "https://example.com".into())],
            Some("audio/mp4".into()),
        )
        .expect("应能发布流令牌");
    assert!(stream_url.starts_with("http://127.0.0.1:"), "{stream_url}");

    // 直接连代理：未知令牌必须 404（不泄露任何信息，也不做通用转发）
    let port: u16 = stream_url
        .trim_start_matches("http://127.0.0.1:")
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).expect("代理应在本机监听");
    socket
        .write_all(b"GET /m/does-not-exist HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    assert!(response.contains("令牌无效"), "{response}");

    // 非 /m/ 路径同样拒绝（代理不是通用转发器）
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket.write_all(b"GET /proxy?url=https://evil.example.com HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");

    std::fs::remove_dir_all(&dir).ok();
}

/// 供测试确认「没有可用源时不会报错」——这里顺带覆盖 `playback.resolve` 在无插件时的行为。
#[test]
fn resolve_without_any_plugin_returns_null() {
    let (ctx, dir) = setup();
    let value = call(&ctx, "playback.resolve", json!({ "reference": "whatever:1", "quality": "standard" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"], json!(null));
    std::fs::remove_dir_all(&dir).ok();
}

/// 生成一个可播放的 PCM WAV（8kHz 单声道 8bit），用于本地播放链路测试。
fn write_wav(path: &std::path::Path, seconds: u32) {
    let sample_rate: u32 = 8_000;
    let data_len = sample_rate * seconds;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend(std::iter::repeat(128u8).take(data_len as usize));
    std::fs::write(path, bytes).unwrap();
}

/// 本地曲库里的文件走**同一条回环代理**：`streamUrl` 可播、支持 Range（拖动进度）。
#[test]
fn local_files_play_through_the_same_proxy_with_range() {
    let (ctx, dir) = setup();
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    let file = music.join("本地曲目.wav");
    write_wav(&file, 4);

    // 入库 → 播放解析：本地曲目不经插件，直接拿到代理地址
    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(scanned["ok"], json!(true), "{scanned}");
    let id = call(&ctx, "library.local.list", json!({}))["data"]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let resolved = call(&ctx, "playback.resolve", json!({ "reference": id, "quality": "standard" }));
    assert_eq!(resolved["ok"], json!(true), "{resolved}");
    let stream_url = resolved["data"]["streamUrl"].as_str().expect("应有代理地址").to_string();
    assert!(stream_url.starts_with("http://127.0.0.1:"), "{stream_url}");
    assert_eq!(resolved["data"]["source"], json!("local"));
    assert_eq!(resolved["data"]["mimeType"], json!("audio/wav"));

    let port: u16 = stream_url
        .trim_start_matches("http://127.0.0.1:")
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let path = format!("/m/{}", stream_url.rsplit('/').next().unwrap());

    // 整段请求：200 + Content-Length + Accept-Ranges
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
        .unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).unwrap();
    let head = String::from_utf8_lossy(&raw[..600.min(raw.len())]).to_string();
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(head.contains("Accept-Ranges: bytes"), "{head}");
    assert!(head.contains("Content-Type: audio/wav"), "{head}");
    assert!(head.contains("Cache-Control: no-store"), "{head}");

    // Range 请求：206 + Content-Range（拖动进度的前提）
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=100-199\r\n\r\n").as_bytes(),
        )
        .unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).unwrap();
    let head = String::from_utf8_lossy(&raw[..700.min(raw.len())]).to_string();
    assert!(head.starts_with("HTTP/1.1 206"), "{head}");
    assert!(head.contains("Content-Range: bytes 100-199/"), "{head}");
    assert!(head.contains("Content-Length: 100"), "{head}");

    // 越界 Range：416（而不是假装成功或泄漏文件大小以外的信息）
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=999999-\r\n\r\n").as_bytes(),
        )
        .unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).unwrap();
    let head = String::from_utf8_lossy(&raw[..400.min(raw.len())]).to_string();
    assert!(head.starts_with("HTTP/1.1 416"), "{head}");

    // 文件被删后：候选不可播 → data: null（不报错，前端退回模拟时钟）
    std::fs::remove_file(&file).unwrap();
    let resolved = call(&ctx, "playback.resolve", json!({ "reference": id, "quality": "standard" }));
    assert_eq!(resolved["ok"], json!(true), "{resolved}");
    assert_eq!(resolved["data"], json!(null));

    // 非音频文件不允许被代理（白名单与扫描一致）
    let text = music.join("notes.txt");
    std::fs::write(&text, "not audio").unwrap();
    let blocked = ctx.streams.publish_local(&text);
    assert!(blocked.is_err(), "非音频文件必须被拒");

    std::fs::remove_dir_all(&dir).ok();
}

/// `playback.report` 写播放历史（与 `library.history.push` 同一份数据）。
#[test]
fn playback_report_records_history() {    let (ctx, dir) = setup();

    let value = call(
        &ctx,
        "playback.report",
        json!({
            "ref": {"id": "demo:a", "source": "demo", "sourceTrackId": "a"},
            "source": "demo",
            "quality": "high",
            "playedSec": 42,
            "completed": false,
            "track": {"id": "demo:a", "title": "甲", "artist": "歌手", "durationSec": 200},
        }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");

    let history = call(&ctx, "library.history.list", json!({}));
    let items = history["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{history}");
    assert_eq!(items[0]["id"], json!("demo:a"));
    assert_eq!(items[0]["title"], json!("甲"));
    assert_eq!(items[0]["playedSec"], json!(42));
    assert_eq!(items[0]["playCount"], json!(1));

    // 引用格式错误 → 参数非法；库不可用时 → library.io_error
    let bad = call(&ctx, "playback.report", json!({ "ref": "没有冒号" }));
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad}");

    std::fs::remove_dir_all(&dir).ok();
}

/// 播放缓存：播放过的远端曲目落本地；**断网/插件停用时仍能从缓存播**；可清理。
#[test]
fn played_tracks_are_cached_and_playable_when_the_source_is_gone() {
    use gently_core::plugin::{DownloadEvent, DownloadOutcome};

    /// 只用于缓存补全的传输层：`download` 返回 11 字节；不联网。
    struct CacheTransport;
    impl HttpTransport for CacheTransport {
        fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
            Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
        }

        fn download(
            &self,
            _request: &HttpRequest,
            sink: &mut dyn FnMut(DownloadEvent<'_>) -> bool,
        ) -> Fallible<DownloadOutcome> {
            let headers = vec![("content-length".to_string(), "11".to_string())];
            let keep = sink(DownloadEvent::Start { status: 200, headers: &headers });
            if !keep {
                return Ok(DownloadOutcome { status: 200, headers, bytes: 0, aborted: true });
            }
            let body = b"cached-mp3!";
            let _ = sink(DownloadEvent::Chunk(body));
            Ok(DownloadOutcome { status: 200, headers, bytes: body.len() as u64, aborted: false })
        }
    }

    const CACHE_SOURCE: &str = r#"
// @id cache-source
// @name 缓存测试源
// @version 1.0.0
// @author tester
// @hosts cdn.example.com
async function getMediaSource() {
    return {url: 'https://cdn.example.com/song.mp3', headers: {'Referer': 'https://example.com'}};
}
"#;

    let dir = common::temp_dir("media-cache");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths)
        .with_store(store)
        .with_events(Arc::new(NullSink))
        .with_http(Arc::new(CacheTransport));
    install(&ctx, CACHE_SOURCE);

    let reference = "cache-source:t1";
    let first = call(&ctx, "playback.resolve", json!({ "reference": reference, "quality": "standard" }));
    assert_eq!(first["ok"], json!(true), "{first}");
    assert_eq!(first["data"]["source"], json!("cache-source"), "{first}");

    // 缓存是后台线程补的：等文件出现（最多 3s），并确认 status 能看见
    let key = gently_core::cache::media_key(reference, "standard");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline
        && gently_core::cache::lookup_exact(&ctx.paths, &key).is_none()
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        gently_core::cache::lookup_exact(&ctx.paths, &key).is_some(),
        "播放后应写入缓存"
    );
    let status = call(&ctx, "system.cacheStatus", json!({}));
    assert_eq!(status["ok"], json!(true), "{status}");
    assert!(status["data"]["mediaCount"].as_u64().unwrap() >= 1, "{status}");

    // 停用插件 = 源不可用；缓存优先应仍然可播（离线场景）
    let disabled = call(&ctx, "plugin.setEnabled", json!({ "id": "cache-source", "enabled": false }));
    assert_eq!(disabled["ok"], json!(true), "{disabled}");
    let offline = call(&ctx, "playback.resolve", json!({ "reference": reference, "quality": "standard" }));
    assert_eq!(offline["ok"], json!(true), "{offline}");
    assert_eq!(offline["data"]["fromCache"], json!(true), "应命中缓存：{offline}");
    assert!(
        offline["data"]["streamUrl"].as_str().unwrap().starts_with("http://127.0.0.1"),
        "缓存也要走同一条回环代理：{offline}"
    );

    // 清理后：缓存没了、源也不可用 → 按契约返回 null（不假装能播）
    let cleared = call(&ctx, "system.cacheClear", json!({ "kind": "media" }));
    assert_eq!(cleared["ok"], json!(true), "{cleared}");
    assert!(cleared["data"]["removedFiles"].as_u64().unwrap() >= 1, "{cleared}");
    let after = call(&ctx, "system.cacheStatus", json!({}));
    assert_eq!(after["data"]["mediaCount"], json!(0), "{after}");
    let gone = call(&ctx, "playback.resolve", json!({ "reference": reference, "quality": "standard" }));
    assert_eq!(gone["data"], json!(null), "{gone}");

    std::fs::remove_dir_all(&dir).ok();
}

/// 缓存上限可配（`system.cacheConfig`）：越界被拒、设置**存盘**（清缓存不会重置）、
/// 调小之后**立刻**按新上限淘汰。
#[test]
fn cache_limit_is_configurable_and_enforced_immediately() {
    let dir = common::temp_dir("media-cache-limit");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();

    // 默认 1 GiB
    let status = gently_core::cache::status(&paths);
    assert_eq!(status["limitBytes"], json!(1024u64 * 1024 * 1024), "{status}");

    // 越界：太小 / 太大都拒绝，而且**不改动**已存的值
    for bad in [1u64, 64 * 1024 * 1024, 64 * 1024 * 1024 * 1024] {
        let err = gently_core::cache::set_limit(&paths, bad).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad}");
    }
    assert_eq!(
        gently_core::cache::media_limit(&paths),
        1024u64 * 1024 * 1024,
        "越界写入不得改动设置"
    );

    // 合法值：生效并返回最新状态
    let updated = gently_core::cache::set_limit(&paths, 256 * 1024 * 1024).unwrap();
    assert_eq!(updated["limitBytes"], json!(256u64 * 1024 * 1024), "{updated}");
    assert_eq!(gently_core::cache::media_limit(&paths), 256 * 1024 * 1024);

    // 设置写在 data/ 而不是 cache/：清缓存不该把用户设置一起清掉
    let cleared = gently_core::cache::clear(&paths, "all").unwrap();
    assert!(cleared["removedFiles"].is_u64(), "{cleared}");
    assert_eq!(
        gently_core::cache::media_limit(&paths),
        256 * 1024 * 1024,
        "清缓存后上限仍然是用户设的值"
    );

    // 调小后立刻淘汰：塞两个文件，再把上限压到最低，最旧的那个必须消失
    let media = paths.cache.join("media");
    std::fs::create_dir_all(&media).unwrap();
    let write_entry = |name: &str, bytes: usize, at: u64| {
        let path = media.join(name);
        std::fs::write(&path, vec![0u8; bytes]).unwrap();
        std::fs::write(
            media.join(format!("{name}.json")),
            serde_json::json!({"reference": name, "at": at}).to_string().as_bytes(),
        )
        .unwrap();
    };
    write_entry("old.mp3", 80 * 1024 * 1024, 1);
    write_entry("new.mp3", 80 * 1024 * 1024, 2);
    assert_eq!(gently_core::cache::status(&paths)["mediaCount"], json!(2));

    // 128 MiB 上限：两个 80 MiB 放不下，最旧的被删掉
    gently_core::cache::set_limit(&paths, gently_core::cache::MIN_LIMIT_BYTES).unwrap();
    assert!(!media.join("old.mp3").exists(), "最旧的应被淘汰");
    assert!(media.join("new.mp3").exists(), "较新的应留下");

    std::fs::remove_dir_all(&dir).ok();
}