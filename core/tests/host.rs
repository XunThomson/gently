//! 插件沙箱的行为测试。
//!
//! 这里用**mock 传输层**（不发真实请求）验证沙箱的边界：
//! 权限拒绝、域名白名单、HTTPS 限制、超时中断、能力缺失、kv 持久化、
//! 以及「bootstrap 结束后原始宿主入口被删除」这一逃逸封堵。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gently_core::contract::ErrorCode;
use gently_core::plugin::{
    parse_source, CredentialStore, HostLimits, HttpRequest, HttpResponse, HttpTransport,
    MemoryCredentialStore, PluginHost,
};
use gently_core::AppPaths;

mod common;

/// mock 传输：按 URL 返回预设响应，并记录收到的请求（含插件设置的请求头）。
#[derive(Default)]
struct MockTransport {
    responses: Mutex<HashMap<String, HttpResponse>>,
    calls: Mutex<Vec<HttpRequest>>,
}

impl MockTransport {
    fn with(url: &str, body: &str) -> Arc<Self> {
        Self::with_response(url, 200, "", body)
    }

    /// 指定状态码与 content-type 的响应（垫片要按 axios 语义处理非 2xx 与 JSON 解析）。
    fn with_response(url: &str, status: u16, content_type: &str, body: &str) -> Arc<Self> {
        let transport = Self::default();
        let headers = if content_type.is_empty() {
            vec![]
        } else {
            vec![("content-type".to_string(), content_type.to_string())]
        };
        transport.responses.lock().unwrap().insert(
            url.to_string(),
            HttpResponse { status, headers, body: body.to_string(), truncated: false },
        );
        Arc::new(transport)
    }

    fn calls(&self) -> Vec<HttpRequest> {
        self.calls.lock().unwrap().clone()
    }
}

impl HttpTransport for MockTransport {
    fn send(&self, request: &HttpRequest) -> gently_core::contract::Fallible<HttpResponse> {
        self.calls.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .get(&request.url)
            .cloned()
            .ok_or_else(|| {
                gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "mock：未预设该 URL")
            })
    }
}

fn temp_paths(tag: &str) -> (AppPaths, std::path::PathBuf) {
    let dir = common::temp_dir(&format!("host-{tag}"));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");
    (paths, dir)
}

/// 把插件源码写进 `plugins/<id>/plugin.js` 并解析出清单（模拟「已安装」状态）。
fn install_source(
    paths: &AppPaths,
    source: &str,
) -> gently_core::plugin::PluginManifest {
    let parsed = parse_source(source).expect("源码应能解析");
    let dir = paths.plugins.join(&parsed.manifest.id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("plugin.js"), source).unwrap();
    parsed.manifest
}

fn host_with(
    paths: &AppPaths,
    transport: Arc<dyn HttpTransport>,
    credentials: Arc<dyn CredentialStore>,
    timeout: Duration,
) -> PluginHost {
    PluginHost::new(
        paths.clone(),
        transport,
        credentials,
        HostLimits { call_timeout: timeout, ..HostLimits::default() },
    )
}

const SEARCH_PLUGIN: &str = r#"
// @id search-source
// @name 搜索源
// @version 1.0.0
// @author someone
// @hosts api.example.com
async function search(keyword, page) {
    const res = await fetch('https://api.example.com/search?q=' + encodeURIComponent(keyword), {
        headers: {'User-Agent': 'gently-plugin', 'Referer': 'https://api.example.com'},
    });
    const data = await res.json();
    return data.items.map((it) => ({id: 'search-source:' + it.id, title: it.name, artist: 'x'}));
}
async function getMediaSource(track, quality) {
    return {url: 'https://cdn.example.com/a.m4a', quality: quality};
}
"#;

#[test]
fn loads_plugin_and_detects_capabilities_from_the_runtime() {
    let (paths, dir) = temp_paths("load");
    let manifest = install_source(&paths, SEARCH_PLUGIN);
    let transport = MockTransport::with("https://api.example.com/search?q=%E5%A4%9C%E6%9B%B2", r#"{"items":[{"id":"1","name":"夜曲"}]}"#);
    let host = host_with(&paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));

    let capabilities = host.load(manifest).expect("加载成功");
    // 真实探测（不是静态预扫描）：只有源码里定义的两个函数
    assert_eq!(capabilities.len(), 2, "{capabilities:?}");

    let json = host.call("search-source", "search", r#"["夜曲", 1]"#).expect("调用成功");
    assert!(json.contains("夜曲"), "{json}");
    assert!(json.contains("search-source:1"), "{json}");

    host.unload("search-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn fetch_forwards_plugin_headers_to_the_allowlisted_host() {
    let (paths, dir) = temp_paths("fetch");
    let manifest = install_source(&paths, SEARCH_PLUGIN);
    let transport = MockTransport::with("https://api.example.com/search?q=x", r#"{"items":[]}"#);
    let host = host_with(&paths, transport.clone(), Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).unwrap();

    host.call("search-source", "search", r#"["x", 1]"#).expect("白名单内应可访问");

    // 插件设置的头必须原样转发（真实音源大量依赖 Referer / User-Agent）
    let calls = transport.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].url, "https://api.example.com/search?q=x");
    assert!(calls[0]
        .headers
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case("user-agent") && value == "gently-plugin"));
    assert!(calls[0]
        .headers
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case("referer") && value == "https://api.example.com"));

    host.unload("search-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn undeclared_host_is_permission_denied() {
    let (paths, dir) = temp_paths("denied");
    let source = SEARCH_PLUGIN.replace("api.example.com/search", "evil.example.net/search");
    let manifest = install_source(&paths, &source);
    // mock 里预设的是被禁的地址；若沙箱失效，请求就会成功，测试随之失败
    let transport = MockTransport::with("https://evil.example.net/search?q=x", r#"{"items":[]}"#);
    let host = host_with(&paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).unwrap();

    let err = host.call("search-source", "search", r#"["x", 1]"#).unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginPermissionDenied, "{err:?}");
    assert!(err.message.contains("白名单"), "{}", err.message);

    host.unload("search-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn http_scheme_is_rejected() {
    let (paths, dir) = temp_paths("scheme");
    let source = SEARCH_PLUGIN.replace("https://api.example.com/search", "http://api.example.com/search");
    let manifest = install_source(&paths, &source);
    let transport = MockTransport::with("http://api.example.com/search?q=x", "{}");
    let host = host_with(&paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).unwrap();

    let err = host.call("search-source", "search", r#"["x", 1]"#).unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginPermissionDenied, "{err:?}");
    assert!(err.message.contains("HTTPS"), "{}", err.message);

    host.unload("search-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn raw_host_entry_points_are_deleted_after_bootstrap() {
    let (paths, dir) = temp_paths("escape");
    let source = r#"
// @id escape-source
// @name 逃逸尝试
// @version 1.0.0
// @author someone
// @hosts api.example.com
async function search() {
    // bootstrap 之后原始入口必须已经不存在
    return {hasFetch: typeof globalThis.__hostFetch, hasLog: typeof globalThis.__hostLog,
            hasStorage: typeof globalThis.__hostStorageGet};
}
"#;
    let manifest = install_source(&paths, source);
    let transport = MockTransport::with("https://api.example.com/", "{}");
    let host = host_with(&paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).unwrap();

    let json = host.call("escape-source", "search", "[]").unwrap();
    assert!(json.contains(r#""hasFetch":"undefined""#), "原始入口应被删除：{json}");
    assert!(json.contains(r#""hasLog":"undefined""#), "{json}");
    assert!(json.contains(r#""hasStorage":"undefined""#), "{json}");

    host.unload("escape-source");
    std::fs::remove_dir_all(&dir).ok();
}

/// MusicFree 风格的插件：靠 `env.getUserVariables()` 拿用户填的变量。
const ENV_PLUGIN: &str = r#"
// @id env-source
// @name 变量源
// @version 1.0.0
// @author someone
// @hosts api.example.com
// @credentials cookie,cookie 值
async function search() {
    const vars = env.getUserVariables();
    const direct = env.userVariables;
    return {
        cookie: vars.cookie === undefined ? null : vars.cookie,
        same: JSON.stringify(vars) === JSON.stringify(direct),
        os: typeof env.os,
        version: typeof env.appVersion,
        processEnv: typeof process.env.getUserVariables,
        rawHost: typeof globalThis.__hostUserVariables,
    };
}
"#;

#[test]
fn env_exposes_user_variables_to_compat_plugins() {
    let (paths, dir) = temp_paths("env-vars");
    let manifest = install_source(&paths, ENV_PLUGIN);

    // 用户已填过凭据：插件应能通过 env.getUserVariables() 读到同一个值
    let store = MemoryCredentialStore::new();
    store.set("env-source", "cookie", Some("SESS=abc"));
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(store),
        Duration::from_secs(5),
    );
    host.load(manifest.clone()).unwrap();

    let value: serde_json::Value =
        serde_json::from_str(&host.call("env-source", "search", "[]").unwrap()).unwrap();
    assert_eq!(value["cookie"], "SESS=abc", "应读到用户填的值：{value}");
    assert_eq!(value["same"], true, "两种写法应返回同一份变量：{value}");
    assert_eq!(value["os"], "string", "env.os 要存在（插件常按平台分支）");
    assert_eq!(value["version"], "string", "env.appVersion 要存在");
    assert_eq!(value["processEnv"], "function", "process.env 应指向同一个 env");
    assert_eq!(value["rawHost"], "undefined", "原始宿主入口必须被删除：{value}");

    // 没填过的键不能凭空冒出来
    assert!(!value.as_object().unwrap().contains_key("missing"));

    host.unload("env-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn user_variables_are_empty_without_credentials_permission() {
    let (paths, dir) = temp_paths("env-denied");
    // 声明里没有 @credentials → 没有凭据权限 → 变量一律读不到
    let source = ENV_PLUGIN.replace("// @credentials cookie,cookie 值\n", "");
    let manifest = install_source(&paths, &source);

    let store = MemoryCredentialStore::new();
    store.set("env-source", "cookie", Some("SESS=abc"));
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(store),
        Duration::from_secs(5),
    );
    host.load(manifest).unwrap();

    let value: serde_json::Value =
        serde_json::from_str(&host.call("env-source", "search", "[]").unwrap()).unwrap();
    assert_eq!(value["cookie"], serde_json::Value::Null, "无权限时不得读到值：{value}");

    host.unload("env-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_capability_reports_not_implemented() {    let (paths, dir) = temp_paths("capability");
    let manifest = install_source(&paths, SEARCH_PLUGIN);
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(MemoryCredentialStore::new()),
        Duration::from_secs(5),
    );
    host.load(manifest).unwrap();

    // 插件没实现 getLyric → UI 应隐藏入口，而不是报错
    let err = host.call("search-source", "getLyric", r#"["1"]"#).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotImplemented, "{err:?}");

    host.unload("search-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn infinite_loop_is_interrupted_by_timeout() {
    let (paths, dir) = temp_paths("timeout");
    let source = r#"
// @id loop-source
// @name 死循环
// @version 1.0.0
// @author someone
async function search() {
    // 纯 CPU 死循环：只有中断处理器能救回来
    while (true) { Math.sqrt(12345.6789); }
}
"#;
    let manifest = install_source(&paths, source);
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(MemoryCredentialStore::new()),
        Duration::from_millis(300),
    );
    host.load(manifest).unwrap();

    let started = std::time::Instant::now();
    let err = host.call("loop-source", "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginRuntimeError, "{err:?}");
    assert!(err.message.contains("超时"), "{}", err.message);
    // 必须被及时中断，而不是等默认 8 秒
    assert!(started.elapsed() < Duration::from_secs(3), "耗时 {:?}", started.elapsed());

    host.unload("loop-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn plugin_exception_becomes_runtime_error() {
    let (paths, dir) = temp_paths("throw");
    let source = r#"
// @id throw-source
// @name 抛错
// @version 1.0.0
// @author someone
async function search() { throw new Error('上游接口变了'); }
"#;
    let manifest = install_source(&paths, source);
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(MemoryCredentialStore::new()),
        Duration::from_secs(5),
    );
    host.load(manifest).unwrap();

    let err = host.call("throw-source", "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginRuntimeError, "{err:?}");
    assert!(err.message.contains("上游接口变了"), "{}", err.message);

    host.unload("throw-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn storage_persists_across_calls_and_reloads() {
    let (paths, dir) = temp_paths("storage");
    let source = r#"
// @id kv-source
// @name 存东西
// @version 1.0.0
// @author someone
async function search() {
    const seen = storage.get('count') || 0;
    storage.set('count', seen + 1);
    return {count: seen + 1};
}
"#;
    let manifest = install_source(&paths, source);
    let transport = MockTransport::with("https://api.example.com/", "{}");
    let host = host_with(&paths, transport.clone(), Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest.clone()).unwrap();

    assert!(host.call("kv-source", "search", "[]").unwrap().contains("\"count\":1"));
    assert!(host.call("kv-source", "search", "[]").unwrap().contains("\"count\":2"));

    // 重新加载（模拟 reload）：kv 必须还在
    host.unload("kv-source");
    host.load(manifest).unwrap();
    assert!(host.call("kv-source", "search", "[]").unwrap().contains("\"count\":3"));

    host.unload("kv-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn credentials_are_only_visible_when_declared() {
    let (paths, dir) = temp_paths("credentials");
    let source = r#"
// @id cred-source
// @name 要密钥
// @version 1.0.0
// @author someone
// @credentials apiKey:API Key:required
async function search() { return {key: credentials.get('apiKey') || null}; }
"#;
    let manifest = install_source(&paths, source);
    let credentials = Arc::new(MemoryCredentialStore::new());
    credentials.set("cred-source", "apiKey", Some("secret-value"));
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        credentials.clone(),
        Duration::from_secs(5),
    );
    host.load(manifest).unwrap();
    assert!(host.call("cred-source", "search", "[]").unwrap().contains("secret-value"));
    host.unload("cred-source");

    // 没声明 credentials 权限的插件即使 keyring 里有值也读不到
    let no_perm = r#"
// @id no-cred
// @name 没声明
// @version 1.0.0
// @author someone
async function search() { return {key: credentials.get('apiKey') || null}; }
"#;
    let manifest = install_source(&paths, no_perm);
    host.load(manifest).unwrap();
    assert!(host.call("no-cred", "search", "[]").unwrap().contains("\"key\":null"));

    host.unload("no-cred");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn syntax_error_is_reported_at_load_time() {
    let (paths, dir) = temp_paths("syntax");
    let source = "// @id broken\n// @name 坏的\n// @version 1.0.0\n// @author x\nasync function search( { \n";
    let manifest = install_source(&paths, source);
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(MemoryCredentialStore::new()),
        Duration::from_secs(5),
    );

    let err = host.load(manifest).unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginRuntimeError, "{err:?}");
    assert!(err.message.contains("插件加载失败"), "{}", err.message);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn compat_mode_allows_public_hosts_but_never_local_ones() {
    let (paths, dir) = temp_paths("compat");
    // 兼容模式插件：不声明 @hosts，只标 @compat
    let source = r#"
// @id compat-source
// @name 兼容源
// @version 1.0.0
// @author tester
// @compat
async function search() {
    const res = await fetch('https://api.example.com/list');
    return await res.json();
}
"#;
    let manifest = install_source(&paths, source);
    assert!(manifest.compat, "应识别 @compat");
    assert!(manifest.hosts.is_empty());

    let transport = MockTransport::with("https://api.example.com/list", r#"{"ok":true}"#);
    let host = host_with(&paths, transport.clone(), Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).unwrap();

    // 兼容模式：公网 HTTPS 放行
    let value = host.call("compat-source", "search", "[]").expect("兼容模式应放行公网域名");
    assert!(value.contains("true"), "{value}");
    assert_eq!(transport.calls().len(), 1);

    // 但本机/内网**始终**拒绝：兼容模式放宽的是「哪些公网域名」，不是「能不能打本机」
    let local = install_source(
        &paths,
        &source.replace("api.example.com/list", "127.0.0.1:9/secret"),
    );
    let host2 = host_with(&paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host2.load(local).unwrap();
    let err = host2.call("compat-source", "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginPermissionDenied, "{err:?}");
    assert!(err.message.contains("本机"), "{}", err.message);

    host.unload("compat-source");
    host2.unload("compat-source");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn non_compat_plugin_without_hosts_stays_blocked() {
    let (paths, dir) = temp_paths("strict");
    let source = r#"
// @id strict-source
// @name 严格源
// @version 1.0.0
// @author tester
// @permissions network
async function search() {
    const res = await fetch('https://api.example.com/list');
    return await res.json();
}
"#;
    let manifest = install_source(&paths, source);
    assert!(!manifest.compat, "未标 @compat 就不是兼容模式");

    let transport = MockTransport::with("https://api.example.com/list", "{}");
    let host = host_with(&paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).unwrap();
    let err = host.call("strict-source", "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginPermissionDenied, "{err:?}");
    assert!(err.message.contains("白名单"), "{}", err.message);

    host.unload("strict-source");
    std::fs::remove_dir_all(&dir).ok();
}

// ------------------------------------------------------------------ require 垫片
//
// 兼容模式的固定模块清单（`he` / `axios` / `dayjs` / `crypto-js`）是**形状翻译**：
// 出网仍走宿主通道，因此白名单 / 兼容模式域名策略 / 「不打本机」这些边界在垫片下一律照旧
// ——这正是下面这些测试要盯住的东西。

/// 兼容模式插件头部：`@compat` 会推导出 `network` 权限（否则插件根本出不了网）。
const COMPAT_HEADER: &str = "// @id compat-shim\n// @name 兼容垫片\n// @version 1.0.0\n// @author tester\n// @compat\n";
const COMPAT_ID: &str = "compat-shim";

fn load_compat(
    paths: &AppPaths,
    transport: Arc<dyn HttpTransport>,
    body: &str,
) -> PluginHost {
    let source = format!("{COMPAT_HEADER}{body}");
    let manifest = install_source(paths, &source);
    let host = host_with(paths, transport, Arc::new(MemoryCredentialStore::new()), Duration::from_secs(5));
    host.load(manifest).expect("兼容插件应能加载");
    host
}

#[test]
fn crypto_js_shim_matches_reference_vectors() {
    let (paths, dir) = temp_paths("shim-crypto");
    let host = load_compat(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        r#"
const CryptoJS = require('crypto-js');
module.exports = {
    async search() {
        return {
            md5: CryptoJS.MD5('abc').toString(),
            sha256: CryptoJS.SHA256('abc').toString(CryptoJS.enc.Hex),
            foxMd5: CryptoJS.MD5('The quick brown fox jumps over the lazy dog').toString(),
            foxSha: CryptoJS.enc.Hex.stringify(
                CryptoJS.SHA256('The quick brown fox jumps over the lazy dog')),
            utf8Hex: CryptoJS.enc.Hex.stringify(CryptoJS.enc.Utf8.parse('中')),
            utf8Round: CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Utf8.parse('中文🙂')),
            base64: CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('abc')),
            base64Round: CryptoJS.enc.Base64.parse('YWJj').toString(CryptoJS.enc.Utf8),
            hexParse: CryptoJS.SHA256(CryptoJS.enc.Hex.parse('616263')).toString(),
            words: CryptoJS.lib.WordArray.create([0x61, 0x62, 0x63]).toString(),
            latin1: CryptoJS.enc.Latin1.stringify(CryptoJS.lib.WordArray.create([0x61, 0xff])),
            latin1Back: CryptoJS.enc.Hex.stringify(CryptoJS.enc.Latin1.parse('a\u00ff')),
        };
    },
};
"#,
    );

    let json = host.call(COMPAT_ID, "search", "[]").expect("crypto-js 垫片应能算哈希");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["md5"], "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(value["sha256"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(value["foxMd5"], "9e107d9d372bb6826bd81d3542a419d6");
    assert_eq!(value["foxSha"], "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
    assert_eq!(value["utf8Hex"], "e4b8ad");
    assert_eq!(value["utf8Round"], "中文🙂");
    assert_eq!(value["base64"], "YWJj");
    assert_eq!(value["base64Round"], "abc");
    assert_eq!(value["hexParse"], value["sha256"]);
    assert_eq!(value["words"], "616263");
    assert_eq!(value["latin1"], "a\u{ff}");
    assert_eq!(value["latin1Back"], "61ff");

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn crypto_js_subset_reports_algorithms_it_does_not_have() {
    let (paths, dir) = temp_paths("shim-crypto-missing");
    let host = load_compat(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        r#"
const CryptoJS = require('crypto-js');
module.exports = {
    async search() { return CryptoJS.SHA1('abc').toString(); },
};
"#,
    );

    let err = host.call(COMPAT_ID, "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginRuntimeError, "{err:?}");
    assert!(err.message.contains("crypto-js 子集不包含 SHA1"), "错误要说清缺什么：{}", err.message);

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn axios_shim_builds_query_headers_and_response_shape() {
    let (paths, dir) = temp_paths("shim-axios");
    let url = "https://api.example.com/search?q=%E4%B8%AD%E6%96%87%20%26%20more&page=1&tags%5B%5D=a&tags%5B%5D=b";
    let transport = MockTransport::with_response(url, 200, "application/json; charset=utf-8", r#"{"ok":true}"#);
    let host = load_compat(
        &paths,
        transport.clone(),
        r#"
const axios = require('axios');
module.exports = {
    async search() {
        axios.interceptors.request.use((config) => {
            config.headers['X-Trace'] = 'yes';
            return config;
        });
        const res = await axios.get('https://api.example.com/search', {
            params: {q: '中文 & more', page: 1, tags: ['a', 'b'], skip: null},
            headers: {Referer: 'https://example.com'},
        });
        return {
            status: res.status,
            data: res.data,
            contentType: res.headers['content-type'],
            isAxiosError: axios.isAxiosError(res),
        };
    },
};
"#,
    );

    let json = host.call(COMPAT_ID, "search", "[]").expect("axios 垫片应能完成请求");
    let calls = transport.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].url, url, "params 要按 axios 语义拼进查询串");
    assert_eq!(calls[0].method, "GET");
    assert!(calls[0].body.is_none());
    let header = |name: &str| {
        calls[0].headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    };
    assert_eq!(header("Referer").as_deref(), Some("https://example.com"));
    assert_eq!(header("X-Trace").as_deref(), Some("yes"), "请求拦截器要真的生效");

    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["status"], 200);
    assert_eq!(value["data"]["ok"], true);
    assert_eq!(value["contentType"], "application/json; charset=utf-8");
    assert_eq!(value["isAxiosError"], false, "成功响应不是错误");

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn axios_shim_posts_json_bodies() {
    let (paths, dir) = temp_paths("shim-axios-post");
    let transport = MockTransport::with("https://api.example.com/submit", "{}");
    let host = load_compat(
        &paths,
        transport.clone(),
        r#"
const axios = require('axios');
module.exports = {
    async search() { await axios.post('https://api.example.com/submit', {a: 1, b: 'x'}); },
};
"#,
    );

    host.call(COMPAT_ID, "search", "[]").expect("POST 应能完成");
    let calls = transport.calls();
    assert_eq!(calls[0].method, "POST");
    assert_eq!(calls[0].body.as_deref(), Some(r#"{"a":1,"b":"x"}"#));
    assert!(
        calls[0].headers.iter().any(|(key, value)| key.eq_ignore_ascii_case("content-type")
            && value.contains("application/json")),
        "{:?}",
        calls[0].headers
    );

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn axios_shim_merges_defaults_instances_and_call_headers() {
    let (paths, dir) = temp_paths("shim-axios-headers");
    let url = "https://api.example.com/created";
    let transport = MockTransport::with(url, "{}");
    let host = load_compat(
        &paths,
        transport.clone(),
        r#"
const axios = require('axios');
module.exports = {
    async search() {
        // 三种写法都要生效：默认桶、create 的扁平 headers、单次调用的 headers
        axios.defaults.headers.common['X-Base'] = 'base';
        const client = axios.create({headers: {'X-Client': 'custom'}});
        await client.get('https://api.example.com/created', {headers: {'X-Call': 'call'}});
    },
};
"#,
    );

    host.call(COMPAT_ID, "search", "[]").expect("create 出来的实例应能发请求");
    let calls = transport.calls();
    let header = |name: &str| {
        calls[0].headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    };
    assert_eq!(header("X-Base").as_deref(), Some("base"));
    assert_eq!(header("X-Client").as_deref(), Some("custom"));
    assert_eq!(header("X-Call").as_deref(), Some("call"));

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn axios_shim_rejects_non_2xx_with_a_response() {
    let (paths, dir) = temp_paths("shim-axios-status");
    let transport = MockTransport::with_response(
        "https://api.example.com/search",
        503,
        "application/json",
        r#"{"error":"busy"}"#,
    );
    let host = load_compat(
        &paths,
        transport,
        r#"
const axios = require('axios');
module.exports = {
    async search() {
        try {
            await axios.get('https://api.example.com/search');
            return {rejected: false};
        } catch (err) {
            return {
                rejected: true,
                status: err.response && err.response.status,
                data: err.response && err.response.data,
                marker: err.isAxiosError === true,
            };
        }
    },
};
"#,
    );

    let json = host.call(COMPAT_ID, "search", "[]").expect("插件自己捕获了错误");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["rejected"], true);
    assert_eq!(value["status"], 503);
    assert_eq!(value["data"]["error"], "busy");
    assert_eq!(value["marker"], true);

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

/// 垫片绝不能成为绕过宿主策略的通道：白名单与「不打本机」都还在。
#[test]
fn axios_shim_cannot_bypass_host_policy() {
    // 1) 非兼容插件 + 白名单：垫片发出的请求同样要过白名单
    let (paths, dir) = temp_paths("shim-axios-denied");
    let denied_source = r#"
// @id axios-denied
// @name 白名单外
// @version 1.0.0
// @author tester
// @hosts api.example.com
const axios = require('axios');
async function search() { await axios.get('https://evil.example.net/x'); }
"#;
    let manifest = install_source(&paths, denied_source);
    let host = host_with(
        &paths,
        MockTransport::with("https://evil.example.net/x", "{}"),
        Arc::new(MemoryCredentialStore::new()),
        Duration::from_secs(5),
    );
    host.load(manifest).unwrap();
    let err = host.call("axios-denied", "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginPermissionDenied, "{err:?}");
    assert!(err.message.contains("白名单"), "错误要说清白名单：{}", err.message);
    host.unload("axios-denied");

    // 2) 兼容模式：公网放行，但本机/内网仍然拒绝
    let local = load_compat(
        &paths,
        MockTransport::with("https://127.0.0.1/x", "{}"),
        r#"
const axios = require('axios');
module.exports = {
    async search() { await axios.get('https://127.0.0.1/x'); },
};
"#,
    );
    let err = local.call(COMPAT_ID, "search", "[]").unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginPermissionDenied, "{err:?}");
    assert!(err.message.contains("本机"), "错误要说清本机：{}", err.message);

    local.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn dayjs_shim_formats_parses_and_computes() {
    let (paths, dir) = temp_paths("shim-dayjs");
    let host = load_compat(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        r#"
const dayjs = require('dayjs');
module.exports = {
    async search() {
        const d = dayjs('2024-03-05 06:07:08');
        return {
            iso: d.format('YYYY-MM-DDTHH:mm:ss'),
            msMatchesLocalParse: d.valueOf() === new Date(2024, 2, 5, 6, 7, 8).getTime(),
            names: d.format('ddd dddd MMM MMMM'),
            pad: d.format('YY/M/D H:m:s'),
            ampm: d.format('YYYY-MM-DD h:mm A'),
            addDay: d.add(1, 'day').format('YYYY-MM-DD HH:mm:ss'),
            subMonth: d.subtract(1, 'month').format('YYYY-MM-DD'),
            endOfMonth: d.endOf('month').format('YYYY-MM-DD HH:mm:ss'),
            startOfWeek: d.startOf('week').format('YYYY-MM-DD'),
            immutable: d.hour(0).format('HH:mm') + '|' + d.format('HH:mm'),
            diffDay: d.diff(dayjs('2024-03-04'), 'day'),
            diffMonth: dayjs('2024-03-31').diff(dayjs('2024-01-31'), 'month'),
            getters: [d.year(), d.month(), d.date(), d.day()].join(','),
            unix: dayjs.unix(0).unix(),
            invalid: dayjs('not a date').format('YYYY'),
            escape: d.format('[今天是]YYYY年MM月'),
        };
    },
};
"#,
    );

    let json = host.call(COMPAT_ID, "search", "[]").expect("dayjs 垫片应能算日期");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["iso"], "2024-03-05T06:07:08");
    assert_eq!(value["msMatchesLocalParse"], true);
    assert_eq!(value["names"], "Tue Tuesday Mar March");
    assert_eq!(value["pad"], "24/3/5 6:7:8");
    assert_eq!(value["ampm"], "2024-03-05 6:07 AM");
    assert_eq!(value["addDay"], "2024-03-06 06:07:08");
    assert_eq!(value["subMonth"], "2024-02-05");
    assert_eq!(value["endOfMonth"], "2024-03-31 23:59:59");
    assert_eq!(value["startOfWeek"], "2024-03-03");
    assert_eq!(value["immutable"], "00:07|06:07", "dayjs 实例不可变");
    assert_eq!(value["diffDay"], 1);
    assert_eq!(value["diffMonth"], 2);
    assert_eq!(value["getters"], "2024,2,5,2");
    assert_eq!(value["unix"], 0);
    assert_eq!(value["invalid"], "Invalid Date");
    assert_eq!(value["escape"], "今天是2024年03月");

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn he_shim_decodes_and_encodes_entities() {
    let (paths, dir) = temp_paths("shim-he");
    let host = load_compat(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        r#"
const he = require('he');
module.exports = {
    async search() {
        return {
            decoded: he.decode('a&amp;b&#39;c&nbsp;d'),
            round: he.decode(he.encode('<b>"x"</b>')),
        };
    },
};
"#,
    );

    let json = host.call(COMPAT_ID, "search", "[]").expect("he 垫片应能解码实体");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["decoded"], "a&b'c d");
    assert_eq!(value["round"], "<b>\"x\"</b>");

    host.unload(COMPAT_ID);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn unknown_modules_fail_with_an_actionable_message() {
    let (paths, dir) = temp_paths("shim-unknown");
    let source = format!(
        "{COMPAT_HEADER}const _ = require('lodash');\nasync function search() {{ return []; }}\n"
    );
    let manifest = install_source(&paths, &source);
    let host = host_with(
        &paths,
        MockTransport::with("https://api.example.com/", "{}"),
        Arc::new(MemoryCredentialStore::new()),
        Duration::from_secs(5),
    );

    // require 发生在顶层 → 加载期就报错，而不是等调用时才炸
    let err = host.load(manifest).unwrap_err();
    assert_eq!(err.code, ErrorCode::PluginRuntimeError, "{err:?}");
    assert!(err.message.contains("lodash"), "要说清缺哪个模块：{}", err.message);
    assert!(
        err.message.contains("he, axios, dayjs, crypto-js"),
        "要列出可用清单：{}",
        err.message
    );
    assert!(err.message.contains("单文件 ABI"), "要给出移植路径：{}", err.message);

    std::fs::remove_dir_all(&dir).ok();
}