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

/// mock 传输：按 URL 返回预设响应，并记录收到的请求（含插件设置的请求头）。
#[derive(Default)]
struct MockTransport {
    responses: Mutex<HashMap<String, HttpResponse>>,
    calls: Mutex<Vec<HttpRequest>>,
}

impl MockTransport {
    fn with(url: &str, body: &str) -> Arc<Self> {
        let transport = Self::default();
        transport.responses.lock().unwrap().insert(
            url.to_string(),
            HttpResponse { status: 200, headers: vec![], body: body.to_string(), truncated: false },
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
    let dir = std::env::temp_dir().join(format!(
        "gently-host-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
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

#[test]
fn missing_capability_reports_not_implemented() {
    let (paths, dir) = temp_paths("capability");
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
    credentials.set("cred-source", "apiKey", "secret-value");
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