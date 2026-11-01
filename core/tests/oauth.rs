//! 第三方授权（OAuth 2.0 授权码 + PKCE）的集成测试。
//!
//! 这里**不连任何真实第三方**：授权端点与令牌端点都是本机回环上的假设实现
//! （`http://127.0.0.1` 是契约里允许的占位地址，也正好是「本机回调」要用的形态）。
//!
//! 盯住六件事：
//! 1. 完整链路：`auth.begin` → 浏览器回调（本测试用 TCP 直接打过去）→ 换令牌 → 存凭据库
//!    → `auth.status` 变成已授权；
//! 2. **state 校验**：state 不一致的回调被拒，且不会留下令牌；
//! 3. 令牌**不进命令返回值**：`auth.status` 只有状态与过期时间；
//! 4. 沙箱里 `oauth.getAccessToken()` 拿得到，而 `credentials.get('__oauth_token')` 拿不到；
//! 5. 过期令牌用 refresh token 自动续期（`auth.status` 之后仍是已授权）；
//! 6. `auth.cancel` / `auth.signOut` 的收尾语义。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gently_core::commands::dispatch;
use gently_core::contract::Fallible;
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 假传输层：令牌端点返回预设 JSON（并记录请求体，用来断言 PKCE / grant_type）。
struct FakeHttp {
    token_body: Mutex<String>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl FakeHttp {
    fn new(token_body: &str) -> Arc<Self> {
        Arc::new(Self {
            token_body: Mutex::new(token_body.to_string()),
            requests: Mutex::new(Vec::new()),
        })
    }

    fn bodies(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter_map(|request| request.body.clone())
            .collect()
    }
}

impl HttpTransport for FakeHttp {
    fn send(&self, request: &HttpRequest) -> Fallible<HttpResponse> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(HttpResponse {
            status: 200,
            headers: vec![],
            body: self.token_body.lock().unwrap().clone(),
            truncated: false,
        })
    }
}

/// 声明了 `@oauth` 的插件：把「令牌 / 保留键」原样写进返回值，方便断言。
const OAUTH_SOURCE: &str = r#"
// @id auth-source
// @name 授权源
// @version 1.0.0
// @author tester
// @hosts id.example.com
// @oauth authorize=https://id.example.com/authorize,token=https://id.example.com/token,client=demo,scopes=fav
async function search() { return []; }
async function getMediaSource() { return null; }
async function getTrackInfo() {
    const token = (globalThis.oauth && globalThis.oauth.getAccessToken()) || null;
    return {
        id: 'probe',
        title: token === null ? '(no-token)' : 'has-token',
        artist: typeof credentials.get('__oauth_token'),
    };
}
"#;

/// 没有声明授权的插件（`auth.*` 应当明确拒绝，而不是静默返回空）。
const PLAIN_SOURCE: &str = r#"
// @id plain-source
// @name 普通源
// @version 1.0.0
// @author tester
async function search() { return []; }
async function getMediaSource() { return null; }
"#;

const TOKEN_OK: &str = r#"{"access_token":"token-1","refresh_token":"refresh-1","expires_in":3600,"scope":"fav","token_type":"Bearer"}"#;

fn setup(tag: &str, http: Arc<dyn HttpTransport>) -> (CoreContext, std::path::PathBuf) {
    let dir = common::temp_dir(&format!("gently-oauth-{tag}"));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths).with_store(store).with_http(http);
    (ctx, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn install(ctx: &CoreContext, source: &str) -> String {
    let value = call(
        ctx,
        "plugin.import",
        json!({ "from": { "kind": "paste", "content": source }, "consent": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    value["data"]["plugin"]["id"].as_str().unwrap().to_string()
}

/// 模拟浏览器：把 `code` + `state` 打到本机回调地址上（`127.0.0.1` 只在测试里出现）。
/// 连上本机回调端口。
///
/// 回调监听是 `auth.begin` 里新起的线程，绑端口是异步的：机器忙的时候
/// （比如 verify 里同时在编译别的 crate）`begin` 刚返回、端口还没在监听，
/// 直接 `connect` 会失败一次——所以这里重试，最多等 3 秒。
fn connect_callback(address: &str) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match TcpStream::connect(address) {
            Ok(stream) => return stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => panic!("连接本机回调端口失败：{err}"),
        }
    }
}

fn deliver_callback(redirect_uri: &str, query: &str) {
    let address = redirect_uri
        .trim_start_matches("http://")
        .trim_end_matches("/callback")
        .to_string();
    let mut stream = connect_callback(&address);
    let request = format!(
        "GET /callback?{query} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    // 回调页很小：读到 EOF 即可（服务端会主动关闭连接）
    let _ = stream.read_to_string(&mut response);
    assert!(response.starts_with("HTTP/1.1 200"), "回调页应返回 200：{response}");
}

fn wait_until_authorized(ctx: &CoreContext, plugin_id: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let status = call(ctx, "auth.status", json!({ "pluginId": plugin_id }));
        if status["data"]["authorized"] == json!(true) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn full_authorization_code_flow_stores_token_and_hides_it_from_commands() {
    let http = FakeHttp::new(TOKEN_OK);
    let (ctx, _dir) = setup("flow", Arc::clone(&http) as Arc<dyn HttpTransport>);
    let plugin_id = install(&ctx, OAUTH_SOURCE);

    let begin = call(&ctx, "auth.begin", json!({ "pluginId": plugin_id }));
    assert_eq!(begin["ok"], json!(true), "{begin}");
    let redirect_uri = begin["data"]["redirectUri"].as_str().unwrap().to_string();
    let state = begin["data"]["state"].as_str().unwrap().to_string();
    let authorize_url = begin["data"]["authorizeUrl"].as_str().unwrap().to_string();

    // 授权地址必须带上 PKCE 与 state，且端点来自清单（核心不内置地址）
    assert!(authorize_url.starts_with("https://id.example.com/authorize?"), "{authorize_url}");
    assert!(authorize_url.contains("code_challenge_method=S256"), "{authorize_url}");
    assert!(authorize_url.contains(&format!("state={state}")), "{authorize_url}");
    assert!(authorize_url.contains("scope=fav"), "{authorize_url}");

    // 浏览器回调（state 正确）
    deliver_callback(&redirect_uri, &format!("code=abc&state={state}"));
    assert!(wait_until_authorized(&ctx, &plugin_id), "回调后应变为已授权");

    // 换令牌时带上了 code_verifier / redirect_uri / client_id（PKCE 完整性）
    let bodies = http.bodies();
    let body = bodies.first().expect("应发生一次令牌请求");
    assert!(body.contains("grant_type=authorization_code"), "{body}");
    assert!(body.contains("code=abc"), "{body}");
    assert!(body.contains("code_verifier="), "PKCE 应带 verifier：{body}");
    assert!(body.contains("client_id=demo"), "{body}");

    // 令牌**不出现在命令返回值里**
    let status = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
    let serialized = serde_json::to_string(&status).unwrap();
    assert!(!serialized.contains("token-1"), "命令不得回令牌：{serialized}");
    assert!(!serialized.contains("refresh-1"), "命令不得回 refresh token：{serialized}");
    assert_eq!(status["data"]["declared"], json!(true));
    assert_eq!(status["data"]["authorized"], json!(true));
    assert_eq!(status["data"]["scopes"], json!(["fav"]));
    assert!(status["data"]["expiresAt"].as_i64().unwrap() > 0);
    assert_eq!(status["data"]["pending"], json!(false));

    // 沙箱里拿得到令牌；`__` 保留键读不到（typeof 为 "undefined"）
    let record = ctx.store.as_ref().unwrap().get_plugin(&plugin_id).unwrap().unwrap();
    let capabilities = ctx.plugins.load(record.manifest.clone()).expect("加载插件");
    assert!(capabilities.contains(&gently_core::plugin::PluginCapability::GetTrackInfo));
    let raw = ctx.plugins.call(&plugin_id, "getTrackInfo", "[\"probe\"]").expect("调用插件");
    let track: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(track["title"], json!("has-token"), "插件应能取到令牌");
    assert_eq!(track["artist"], json!("undefined"), "保留键不可被插件直接读取");

    // 退出登录：令牌删除，状态回到未授权
    let out = call(&ctx, "auth.signOut", json!({ "pluginId": plugin_id }));
    assert_eq!(out["ok"], json!(true), "{out}");
    let status = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
    assert_eq!(status["data"]["authorized"], json!(false));
}

#[test]
fn callback_with_wrong_state_is_rejected() {
    let http = FakeHttp::new(TOKEN_OK);
    let (ctx, _dir) = setup("state", Arc::clone(&http) as Arc<dyn HttpTransport>);
    let plugin_id = install(&ctx, OAUTH_SOURCE);

    let begin = call(&ctx, "auth.begin", json!({ "pluginId": plugin_id }));
    let redirect_uri = begin["data"]["redirectUri"].as_str().unwrap().to_string();

    // state 对不上：回调页面返回 400，且绝不换令牌
    let address = redirect_uri
        .trim_start_matches("http://")
        .trim_end_matches("/callback")
        .to_string();
    let mut stream = connect_callback(&address);
    stream
        .write_all(
            format!("GET /callback?code=abc&state=forged HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    assert!(response.starts_with("HTTP/1.1 400"), "{response}");

    // 给线程一点时间收尾，然后断言：没有令牌、没有令牌请求
    std::thread::sleep(Duration::from_millis(300));
    assert!(http.bodies().is_empty(), "state 不匹配时不该发起令牌请求");
    let status = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
    assert_eq!(status["data"]["authorized"], json!(false));
    let stored = ctx.plugins.credentials().get(&plugin_id, "__oauth_token");
    assert!(stored.is_none(), "state 不匹配不得落令牌");
}

#[test]
fn cancel_stops_waiting_and_sign_out_is_idempotent() {
    let http = FakeHttp::new(TOKEN_OK);
    let (ctx, _dir) = setup("cancel", Arc::clone(&http) as Arc<dyn HttpTransport>);
    let plugin_id = install(&ctx, OAUTH_SOURCE);

    let begin = call(&ctx, "auth.begin", json!({ "pluginId": plugin_id }));
    assert_eq!(begin["data"]["state"].as_str().unwrap().len(), 32);
    // 进行中：status 报告 pending
    let pending = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
    assert_eq!(pending["data"]["pending"], json!(true));

    let cancelled = call(&ctx, "auth.cancel", json!({ "pluginId": plugin_id }));
    assert_eq!(cancelled["ok"], json!(true), "{cancelled}");

    // 取消之后：登记表清空，状态不再 pending
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut cleared = false;
    while Instant::now() < deadline {
        let status = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
        if status["data"]["pending"] == json!(false) {
            cleared = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(cleared, "取消后应结束等待");

    // 未授权时退出登录是幂等的空操作，不报错
    let out = call(&ctx, "auth.signOut", json!({ "pluginId": plugin_id }));
    assert_eq!(out["ok"], json!(true), "{out}");
}

#[test]
fn expired_token_is_refreshed_before_being_handed_to_the_plugin() {
    let http = FakeHttp::new(r#"{"access_token":"token-2","expires_in":3600}"#);
    let (ctx, _dir) = setup("refresh", Arc::clone(&http) as Arc<dyn HttpTransport>);
    let plugin_id = install(&ctx, OAUTH_SOURCE);

    // 直接塞一张过期令牌（模拟「昨天授权过」），保留 refresh token
    ctx.plugins.credentials().set(
        &plugin_id,
        "__oauth_token",
        Some(r#"{"accessToken":"old","refreshToken":"refresh-1","expiresAt":1,"scopes":["fav"]}"#),
    );

    let token = gently_core::oauth::access_token(&ctx, &plugin_id);
    assert_eq!(token.as_deref(), Some("token-2"), "过期后应自动用 refresh token 续期");

    let bodies = http.bodies();
    let body = bodies.last().expect("应有一次刷新请求");
    assert!(body.contains("grant_type=refresh_token"), "{body}");
    assert!(body.contains("refresh_token=refresh-1"), "{body}");

    // 新令牌已经写回凭据库（下次不必再刷新）
    let stored = ctx.plugins.credentials().get(&plugin_id, "__oauth_token").unwrap();
    assert!(stored.contains("token-2"), "{stored}");
}

#[test]
fn plugins_without_oauth_declaration_are_rejected_explicitly() {
    let http = FakeHttp::new(TOKEN_OK);
    let (ctx, _dir) = setup("plain", Arc::clone(&http) as Arc<dyn HttpTransport>);
    let plugin_id = install(&ctx, PLAIN_SOURCE);

    let status = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
    assert_eq!(status["data"]["declared"], json!(false));
    assert_eq!(status["data"]["authorized"], json!(false));

    let begin = call(&ctx, "auth.begin", json!({ "pluginId": plugin_id }));
    assert_eq!(begin["ok"], json!(false), "{begin}");
    assert_eq!(begin["error"]["code"], json!("common.invalid_argument"));

    // 未安装的插件：明确 not_found，而不是假装成功
    let missing = call(&ctx, "auth.status", json!({ "pluginId": "no-such-plugin" }));
    assert_eq!(missing["error"]["code"], json!("common.not_found"));
}

#[test]
fn token_endpoint_failure_keeps_the_plugin_unauthorized() {
    // 400 invalid_grant：按「登录态失效」报，且不落令牌
    let http = FakeHttp::new(r#"{"error":"invalid_grant"}"#);
    let (ctx, _dir) = setup("failure", Arc::clone(&http) as Arc<dyn HttpTransport>);
    let plugin_id = install(&ctx, OAUTH_SOURCE);

    // FakeHttp 固定回 200，这里换成「成功但缺 access_token」——同样必须拒绝落库
    let begin = call(&ctx, "auth.begin", json!({ "pluginId": plugin_id }));
    let redirect_uri = begin["data"]["redirectUri"].as_str().unwrap().to_string();
    let state = begin["data"]["state"].as_str().unwrap().to_string();
    deliver_callback(&redirect_uri, &format!("code=abc&state={state}"));

    std::thread::sleep(Duration::from_millis(400));
    let status = call(&ctx, "auth.status", json!({ "pluginId": plugin_id }));
    assert_eq!(status["data"]["authorized"], json!(false), "换令牌失败不应算已授权");

    // 未授权时插件拿不到令牌
    assert!(gently_core::oauth::access_token(&ctx, &plugin_id).is_none());
}



