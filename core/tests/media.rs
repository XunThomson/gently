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
    let dir = std::env::temp_dir().join(format!(
        "gently-media-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let mut ctx = CoreContext::new(paths)
        .with_store(store)
        .with_events(Arc::new(NullSink));
    ctx.http = Arc::new(OfflineTransport);
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
        .publish("https://cdn.example.com/a.m4a", vec![("Referer".into(), "https://example.com".into())])
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
