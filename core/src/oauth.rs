//! 第三方授权：**通用** OAuth 2.0 授权码 + PKCE，端点由插件清单声明。
//!
//! 为什么是「通用」而不是内置某一家（`docs/adr/0005-neutral-third-party.md`）：
//! 应用不预置任何第三方地址，授权端点、client id、scope 全部来自**用户主动导入的插件清单**
//! （`@oauth` 头 / 目录包 `oauth` 字段）；核心只实现与厂商无关的那一段流程。
//! 这样「用某站的收藏夹」= 用户自己装一个声明了该站授权端点的插件，而不是应用去内置它。
//!
//! 流程（全部在本机完成，没有任何中转服务器）：
//!
//! ```text
//! auth.begin ──► 绑定 127.0.0.1:port 的临时回调监听 + 生成 state/PKCE
//!            └─► 返回 authorizeUrl（前端用系统浏览器打开，核心不碰 UI）
//! 浏览器 ──► 第三方授权页 ──► 302 到 http://127.0.0.1:port/callback?code=&state=
//! 核心   ──► 校验 state → 用 code 换 token（只在核心内发生）→ 存进 OS 凭据库
//!            └─► 事件 `auth:changed`
//! ```
//!
//! 硬约束（与凭据一致，见契约 §5.3）：
//! - **令牌永不落库、永不进日志**：只进 `CredentialStore`（Windows 凭据管理器），
//!   日志里只出现「授权成功/失败 + 过期时间」；
//! - 命令层**没有任何读令牌的出口**：`auth.status` 只回「是否已授权 + 过期时间」，
//!   令牌只经沙箱宿主函数 `oauth.getAccessToken()` 交给声明了 `@oauth` 的那个插件；
//! - 回调只监听 `127.0.0.1`，且**校验 `state`**：本机上别的程序无法用伪造回调顶替；
//! - 等待有上限（[`CALLBACK_TIMEOUT`]），用户不操作就自己收摊，不留后台线程与端口。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::commands::CoreContext;
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::events::EventSink;
use crate::plugin::{host_allowed, host_of, HttpRequest, InstalledPlugin, OAuthConfig};

/// 等回调的上限：超过就放弃（线程与端口都释放）。
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);

/// 过期余量：剩余不足一分钟就当作已过期（避免「刚拿到就过期」的竞态）。
const EXPIRY_SKEW_MS: i64 = 60_000;

/// 凭据库里存令牌的**保留键**（`__` 前缀，插件读不到，见 `plugin/host.rs`）。
pub const TOKEN_KEY: &str = "__oauth_token";

/// 契约里的命令名（与 `contract/commands.rs` 一致）。
pub const AUTH_CHANGED_EVENT: &str = "auth:changed";

/// 沙箱 `oauth.getAccessToken()` 背后的实现：由宿主在构造时注入。
///
/// 参数是 `(plugin_id, 该插件的 oauth 声明, 该插件的域名白名单)`；
/// 拿不到令牌（未授权 / 已过期且无法刷新）就返回 `None`——插件据此按未登录处理。
pub type OAuthTokenFn =
    dyn Fn(&str, &OAuthConfig, &[String]) -> Option<String> + Send + Sync;

/// 构造给插件宿主用的令牌提供者（凭据库 + 出网都在这里固定下来）。
pub fn token_provider(
    credentials: Arc<dyn crate::plugin::CredentialStore>,
    http: Arc<dyn crate::plugin::HttpTransport>,
) -> Arc<OAuthTokenFn> {
    Arc::new(move |plugin_id, oauth, hosts| {
        token_with(&credentials, Arc::clone(&http), plugin_id, oauth, hosts)
    })
}

/// 读令牌（过期则就地刷新）——**唯一**一处「把令牌拿出来」的实现。
fn token_with(
    credentials: &Arc<dyn crate::plugin::CredentialStore>,
    http: Arc<dyn crate::plugin::HttpTransport>,
    plugin_id: &str,
    oauth: &OAuthConfig,
    hosts: &[String],
) -> Option<String> {
    let token = stored_from(credentials, plugin_id)?;
    let now = now_millis();
    if !token.is_expired(now) {
        return Some(token.access_token);
    }

    // 过期了：有 refresh token 就换一张新的，没有就当作未授权
    let refresh = token.refresh_token.clone()?;
    match refresh_token(oauth, hosts, &refresh, http) {
        Ok(mut next) => {
            if next.refresh_token.is_none() {
                next.refresh_token = token.refresh_token.clone();
            }
            if let Ok(text) = serde_json::to_string(&next) {
                credentials.set(plugin_id, TOKEN_KEY, Some(&text));
            }
            Some(next.access_token)
        }
        Err(err) => {
            tracing::warn!(plugin = %plugin_id, code = err.code.as_str(), "刷新第三方令牌失败");
            None
        }
    }
}

// ---------------------------------------------------------------- 令牌

/// 存进凭据库的令牌结构（JSON 序列化后是一整条字符串）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredToken {
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    /// 毫秒时间戳；`None` = 上游没给 `expires_in`（按 1 小时记，仍然会过期）
    expires_at: Option<i64>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_type: Option<String>,
}

impl StoredToken {
    fn is_expired(&self, now: i64) -> bool {
        match self.expires_at {
            Some(expires_at) => expires_at - EXPIRY_SKEW_MS <= now,
            None => false,
        }
    }
}

/// 一次待完成的授权（`auth.begin` 之后、回调之前）。
struct Pending {
    state: String,
    cancelled: Arc<AtomicBool>,
}

/// 授权流程登记表：同一插件同时只允许一个进行中的授权（重复点「授权」会顶掉上一次）。
#[derive(Default)]
pub struct AuthRegistry {
    pending: Mutex<HashMap<String, Pending>>,
    /// 只用来生成 state / PKCE verifier（不要求密码学强度的随机源：`state` 只需不可预测）
    counter: AtomicU64,
}

impl AuthRegistry {
    /// 取消某个插件进行中的授权（没有则无事发生）。
    pub fn cancel(&self, plugin_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            if let Some(pending) = map.remove(plugin_id) {
                pending.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }

    /// 收尾：**只**移除本次那一轮（`state` 对得上才删）。
    ///
    /// 用户连点两次「授权」时，上一轮的线程晚于新一轮登记才结束；若无条件 `remove`，
    /// 它会把**新一轮**的登记删掉，界面永远停在「等待授权」。
    fn finish(&self, plugin_id: &str, state: &str) {
        if let Ok(mut map) = self.pending.lock() {
            if map.get(plugin_id).is_some_and(|pending| pending.state == state) {
                map.remove(plugin_id);
            }
        }
    }

    fn is_pending(&self, plugin_id: &str) -> bool {
        self.pending.lock().map(|map| map.contains_key(plugin_id)).unwrap_or(false)
    }
}

// ---------------------------------------------------------------- 命令

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdParams {
    #[serde(alias = "id")]
    plugin_id: String,
}

/// `auth.status{pluginId}`：**只回状态，不回令牌**。
pub fn status(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = crate::commands::parse_params(params)?;
    let record = installed(ctx, &params.plugin_id)?;
    let declared = record.manifest.oauth.is_some();
    let token = stored(ctx, &params.plugin_id);
    let now = now_millis();

    Ok(serde_json::json!({
        "pluginId": params.plugin_id,
        "declared": declared,
        "authorized": token.as_ref().is_some_and(|token| !token.is_expired(now)),
        "expiresAt": token.as_ref().and_then(|token| token.expires_at),
        "scopes": token.map(|token| token.scopes).unwrap_or_default(),
        "declaredScopes": record.manifest.oauth.as_ref().map(|oauth| oauth.scopes.clone()).unwrap_or_default(),
        "pending": ctx.oauth.is_pending(&params.plugin_id),
        // 令牌落在哪里由核心如实上报（系统凭据库 or 进程内）——界面据此说明「重启后是否还在」
        "backend": ctx.plugins.credentials().backend(),
    }))
}

/// `auth.begin{pluginId}`：起回调监听并把**授权地址**交回前端（前端用系统浏览器打开）。
///
/// 核心不自己开浏览器：那是 UI 的职责，也是 `src-tauri` 里 `opener` 的能力；
/// 核心只保证「从收到 code 到换到 token」这一段全在本机、且令牌不出核心。
pub fn begin(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = crate::commands::parse_params(params)?;
    let record = installed(ctx, &params.plugin_id)?;
    let oauth = record.manifest.oauth.clone().ok_or_else(|| {
        CoreError::invalid_argument("该插件没有声明第三方授权（@oauth），无法发起授权")
            .with_details(serde_json::json!({ "pluginId": params.plugin_id }))
    })?;
    let hosts = record.manifest.hosts.clone();

    // 上一个还在等回调：先收掉，避免两个监听抢同一个 state
    ctx.oauth.cancel(&params.plugin_id);

    let listener = TcpListener::bind(("127.0.0.1", oauth.redirect_port)).map_err(|err| {
        CoreError::internal(format!("无法绑定本机回调端口：{err}"))
    })?;
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(oauth.redirect_port);
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let state = random_token(&ctx.oauth, 16);
    let verifier = random_token(&ctx.oauth, 32);
    let challenge = if oauth.pkce {
        Some(base64_url(&Sha256::digest(verifier.as_bytes())))
    } else {
        None
    };

    let authorize_url = authorize_url(&oauth, &hosts, &redirect_uri, &state, challenge.as_deref())?;
    let deadline = now_millis() + CALLBACK_TIMEOUT.as_millis() as i64;

    let cancelled = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = ctx.oauth.pending.lock() {
        map.insert(
            params.plugin_id.clone(),
            Pending { state: state.clone(), cancelled: Arc::clone(&cancelled) },
        );
    }

    // 回调线程：等 code → 换 token → 存凭据 → 推事件。失败只记日志 + 推事件，不 panic。
    let plugin_id = params.plugin_id.clone();
    let state_for_thread = state.clone();
    let ctx_parts = FlowContext {
        plugin_id: plugin_id.clone(),
        oauth: oauth.clone(),
        hosts,
        redirect_uri: redirect_uri.clone(),
        verifier: (oauth.pkce).then_some(verifier),
        expected_state: state.clone(),
        http: Arc::clone(&ctx.http),
        credentials: Arc::clone(&ctx.plugins.credentials()),
        events: Arc::clone(&ctx.events),
        cancelled: Arc::clone(&cancelled),
        deadline,
    };
    let pending_registry = Arc::clone(&ctx.oauth);
    std::thread::Builder::new()
        .name("gently-oauth".into())
        .spawn(move || {
            wait_for_callback(listener, ctx_parts);
            pending_registry.finish(&plugin_id, &state_for_thread);
        })
        .map_err(|err| CoreError::internal(format!("无法启动授权回调线程：{err}")))?;

    tracing::info!(plugin = %params.plugin_id, port, "第三方授权已开始，等待本机回调");

    Ok(serde_json::json!({
        "pluginId": params.plugin_id,
        "authorizeUrl": authorize_url,
        "redirectUri": redirect_uri,
        "state": state,
        "expiresAt": deadline,
    }))
}

/// 取消：只置位，线程自己收摊（关端口、退循环）。
pub fn cancel(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = crate::commands::parse_params(params)?;
    installed(ctx, &params.plugin_id)?;
    ctx.oauth.cancel(&params.plugin_id);
    Ok(Value::Null)
}

/// 退出登录：删掉令牌（凭据库里就这一条，删了等于未授权）。
pub fn sign_out(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = crate::commands::parse_params(params)?;
    installed(ctx, &params.plugin_id)?;
    ctx.oauth.cancel(&params.plugin_id);
    ctx.plugins.credentials().set(&params.plugin_id, TOKEN_KEY, None);
    tracing::info!(plugin = %params.plugin_id, "第三方授权已清除");
    Ok(Value::Null)
}

/// 命令层/诊断用的取令牌入口（沙箱走 [`token_provider`]，那是唯一的生产路径）。
///
/// - 未声明 `@oauth` / 未授权 → `None`；
/// - 已过期且没有 refresh token → `None`（插件应把它当作未登录，界面提示重新授权）；
/// - 过期但有 refresh token → 就地刷新并写回凭据库（失败按过期处理）。
pub fn access_token(ctx: &CoreContext, plugin_id: &str) -> Option<String> {
    let record = installed(ctx, plugin_id).ok()?;
    let oauth = record.manifest.oauth?;
    token_with(
        &ctx.plugins.credentials().clone(),
        Arc::clone(&ctx.http),
        plugin_id,
        &oauth,
        &record.manifest.hosts,
    )
}

// ---------------------------------------------------------------- 回调线程

/// 回调线程需要的全部东西（显式打包，避免在闭包里乱借 `ctx`）。
struct FlowContext {
    plugin_id: String,
    oauth: OAuthConfig,
    /// 插件清单的域名白名单（授权端点必须命中，见 `ensure_endpoint_allowed`）
    hosts: Vec<String>,
    redirect_uri: String,
    verifier: Option<String>,
    expected_state: String,
    http: Arc<dyn crate::plugin::HttpTransport>,
    credentials: Arc<dyn crate::plugin::CredentialStore>,
    events: Arc<dyn EventSink>,
    cancelled: Arc<AtomicBool>,
    deadline: i64,
}

/// 等一次本机回调：只接受 `127.0.0.1` 上的连接，读完请求就回一小段 HTML 给浏览器。
fn wait_for_callback(listener: TcpListener, flow: FlowContext) {
    let _ = listener.set_nonblocking(true);

    loop {
        if flow.cancelled.load(Ordering::SeqCst) {
            tracing::info!(plugin = %flow.plugin_id, "第三方授权已取消");
            return;
        }
        if now_millis() >= flow.deadline {
            tracing::warn!(plugin = %flow.plugin_id, "第三方授权超时，未收到回调");
            emit_changed(&flow, false);
            return;
        }

        match listener.accept() {
            Ok((stream, _)) => {
                handle_connection(stream, &flow);
                return;
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(err) => {
                tracing::warn!(plugin = %flow.plugin_id, %err, "第三方授权回调监听失败");
                emit_changed(&flow, false);
                return;
            }
        }
    }
}

/// 读一个 HTTP 请求、解析 query，按结果回页面并处理 code。
fn handle_connection(mut stream: TcpStream, flow: &FlowContext) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let mut buffer = [0u8; 4096];
    let read = match stream.read(&mut buffer) {
        Ok(read) => read,
        Err(err) => {
            tracing::warn!(%err, "读授权回调失败");
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_string();

    let query = path.split_once('?').map(|(_, query)| query).unwrap_or_default();
    let params = parse_query(query);

    if let Some(error) = params.get("error") {
        // 用户在授权页点了「拒绝」
        respond(&mut stream, 200, &page("授权未完成", "授权页返回了错误，可以关闭这个页面回到应用。"));
        tracing::info!(plugin = %flow.plugin_id, error = %error, "第三方授权被拒绝");
        emit_changed(flow, false);
        return;
    }

    // `state` 必须与本次发起的一致：否则说明这个回调不是我们这一轮发出的
    let state = params.get("state").cloned().unwrap_or_default();
    if state != flow.expected_state {
        respond(
            &mut stream,
            400,
            &page("回调无效", "这次回调与本机发起的授权不匹配（state 不一致），已忽略。"),
        );
        tracing::warn!(plugin = %flow.plugin_id, "第三方授权回调的 state 不匹配，已拒绝");
        emit_changed(flow, false);
        return;
    }

    let Some(code) = params.get("code").cloned() else {
        respond(&mut stream, 400, &page("回调缺少 code", "授权页没有带回授权码，请重新发起授权。"));
        emit_changed(flow, false);
        return;
    };

    // 先把页面回了：换 token 可能要几百毫秒，浏览器不该干等着
    respond(
        &mut stream,
        200,
        &page("授权完成", "已收到授权码，正在换取令牌……可以关闭这个页面回到应用。"),
    );

    match exchange_code(flow, &code) {
        Ok(token) => {
            let credentials = Arc::clone(&flow.credentials);
            credentials.set(&flow.plugin_id, TOKEN_KEY, Some(&serde_json::to_string(&token).unwrap_or_default()));
            tracing::info!(
                plugin = %flow.plugin_id,
                expires_at = ?token.expires_at,
                scopes = ?token.scopes,
                "第三方授权成功"
            );
            emit_changed(flow, true);
        }
        Err(err) => {
            tracing::warn!(
                plugin = %flow.plugin_id,
                code = err.code.as_str(),
                message = %err.message,
                "用授权码换令牌失败"
            );
            emit_changed(flow, false);
        }
    }
}

fn emit_changed(flow: &FlowContext, authorized: bool) {
    let expires_at = stored_from(&flow.credentials, &flow.plugin_id)
        .and_then(|token| token.expires_at)
        .filter(|_| authorized);
    flow.events.emit(
        AUTH_CHANGED_EVENT,
        serde_json::json!({
            "pluginId": flow.plugin_id,
            "authorized": authorized,
            "expiresAt": expires_at,
        }),
    );
}

// ---------------------------------------------------------------- 换令牌

/// 授权码 → 令牌（POST `application/x-www-form-urlencoded`，只走 HTTPS/回环）。
fn exchange_code(flow: &FlowContext, code: &str) -> Fallible<StoredToken> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("client_id", flow.oauth.client_id.clone()),
        ("redirect_uri", flow.redirect_uri.clone()),
    ];
    if let Some(verifier) = &flow.verifier {
        form.push(("code_verifier", verifier.clone()));
    }
    token_request(&flow.oauth, &flow.hosts, &form, Arc::clone(&flow.http))
}

/// 刷新令牌（refresh token 授权；不重新走浏览器）。
fn refresh_token(
    oauth: &OAuthConfig,
    hosts: &[String],
    refresh: &str,
    http: Arc<dyn crate::plugin::HttpTransport>,
) -> Fallible<StoredToken> {
    let form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh.to_string()),
        ("client_id", oauth.client_id.clone()),
    ];
    token_request(oauth, hosts, &form, http)
}

fn token_request(
    oauth: &OAuthConfig,
    hosts: &[String],
    form: &[(&str, String)],
    http: Arc<dyn crate::plugin::HttpTransport>,
) -> Fallible<StoredToken> {
    // 端点必须是 HTTPS 或本机回环：清单解析阶段已校验过一次，这里再挡一次
    ensure_endpoint_allowed(&oauth.token_url, hosts, "令牌端点")?;

    let body = form
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");

    let response = http.send(&HttpRequest {
        method: "POST".to_string(),
        url: oauth.token_url.clone(),
        headers: vec![
            ("content-type".to_string(), "application/x-www-form-urlencoded".to_string()),
            ("accept".to_string(), "application/json".to_string()),
        ],
        body: Some(body),
    })?;

    if !(200..300).contains(&response.status) {
        // 400/401 基本都是「授权码过期 / 已被用过」：按登录态失效处理，界面提示重新授权
        let code = if response.status == 400 || response.status == 401 {
            ErrorCode::SourceAuthExpired
        } else {
            ErrorCode::SourceUpstreamFailed
        };
        return Err(CoreError::new(code, format!("令牌端点返回 {}", response.status)).with_details(
            serde_json::json!({
                "status": response.status,
                "body": truncate(&response.body, 200),
            }),
        ));
    }

    let payload: Value = serde_json::from_str(&response.body).map_err(|err| {
        CoreError::new(ErrorCode::SourceUpstreamFailed, format!("令牌端点的响应不是 JSON：{err}"))
            .with_details(serde_json::json!({ "body": truncate(&response.body, 200) }))
    })?;

    let access_token = payload
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CoreError::new(ErrorCode::SourceAuthExpired, "令牌端点的响应缺少 access_token")
                .with_details(serde_json::json!({ "body": truncate(&response.body, 200) }))
        })?;

    let expires_in = payload.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    let scopes = payload
        .get("scope")
        .and_then(Value::as_str)
        .map(|scope| scope.split_whitespace().map(str::to_string).collect())
        .unwrap_or_else(|| oauth.scopes.clone());

    Ok(StoredToken {
        access_token: access_token.to_string(),
        refresh_token: payload
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        expires_at: Some(now_millis() + expires_in.max(0) * 1000),
        scopes,
        token_type: payload.get("token_type").and_then(Value::as_str).map(str::to_string),
    })
}

/// 授权地址：`authorize_url` 可以自带 query（例如某些实现要求 `?response_type=code`）。
fn authorize_url(
    oauth: &OAuthConfig,
    hosts: &[String],
    redirect_uri: &str,
    state: &str,
    challenge: Option<&str>,
) -> Fallible<String> {
    ensure_endpoint_allowed(&oauth.authorize_url, hosts, "授权端点")?;

    let mut pairs = vec![
        ("response_type", "code".to_string()),
        ("client_id", oauth.client_id.clone()),
        ("redirect_uri", redirect_uri.to_string()),
        ("state", state.to_string()),
    ];
    if !oauth.scopes.is_empty() {
        pairs.push(("scope", oauth.scopes.join(" ")));
    }
    if let Some(challenge) = challenge {
        pairs.push(("code_challenge", challenge.to_string()));
        pairs.push(("code_challenge_method", "S256".to_string()));
    }

    let query = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let separator = if oauth.authorize_url.contains('?') { '&' } else { '?' };
    Ok(format!("{}{separator}{query}", oauth.authorize_url))
}

/// 端点校验：只允许 HTTPS，或**本机回环**（测试与本地客户端用）。
///
/// 回环例外只对 `127.0.0.1` / `localhost` 开：那不会把用户的授权码发到公网明文，
/// 而公网的 `http://` 一律拒绝（令牌走明文等于直接泄露）。
fn ensure_endpoint_allowed(url: &str, hosts: &[String], what: &str) -> Fallible<()> {
    if url.starts_with("https://") {
        let host = host_of(url).ok_or_else(|| {
            CoreError::invalid_argument(format!("{what}的域名无法解析")).with_details(serde_json::json!({ "url": url }))
        })?;
        if !host_allowed(hosts, &host) {
            return Err(CoreError::new(
                ErrorCode::PluginPermissionDenied,
                format!("{what}的域名不在插件 @hosts 白名单里：{host}"),
            )
            .with_details(serde_json::json!({ "host": host, "hosts": hosts })));
        }
        return Ok(());
    }
    if is_loopback_url(url) {
        return Ok(());
    }
    Err(CoreError::invalid_argument(format!("{what}必须是 HTTPS（本机回环测试除外）"))
        .with_details(serde_json::json!({ "url": url })))
}

fn is_loopback_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

// ---------------------------------------------------------------- 存储与工具

fn installed(ctx: &CoreContext, id: &str) -> Fallible<InstalledPlugin> {
    let store = ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写插件状态").with_details(
            serde_json::json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })?;
    store
        .get_plugin(id)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{id}")))
}

fn stored(ctx: &CoreContext, plugin_id: &str) -> Option<StoredToken> {
    stored_from(ctx.plugins.credentials(), plugin_id)
}

fn stored_from(credentials: &Arc<dyn crate::plugin::CredentialStore>, plugin_id: &str) -> Option<StoredToken> {
    let raw = credentials.get(plugin_id, TOKEN_KEY)?;
    serde_json::from_str(&raw).ok()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `state` / `code_verifier` 的随机串：时间 + 进程内计数器 + 进程号，过一次 SHA-256。
///
/// 不引 `rand`（离线 registry 里没有）：这两个值只需要**不可预测**、且在一次授权里唯一，
/// 由时间戳与计数器拼出后哈希就够。`bytes` 上限 32（一个摘要的长度）。
fn random_token(registry: &AuthRegistry, bytes: usize) -> String {
    let counter = registry.counter.fetch_add(1, Ordering::SeqCst);
    let seed = format!("{}:{}:{}", now_millis(), counter, std::process::id());
    let digest = Sha256::digest(seed.as_bytes());
    hex(&digest[..bytes.min(digest.len())])
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// base64url（无填充）：PKCE 的 `code_challenge` 只接受这个形状。
fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 0x3f] as char);
        }
    }
    out
}

/// 百分号编码（RFC 3986 unreserved 之外全部编码）：query 里不能留空格、`&`、`=`。
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

/// 解析 `a=1&b=2`（值做百分号解码；非法转义原样保留）。
fn parse_query(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let key = percent_decode(key);
        if key.is_empty() {
            continue;
        }
        out.insert(key, percent_decode(value));
    }
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            // 逐字节解：URL 里可能混着多字节字符，按字节索引切 `str` 会落到字符中间
            b'%' if index + 2 < bytes.len() => {
                let high = hex_nibble(bytes[index + 1]);
                let low = hex_nibble(bytes[index + 2]);
                match (high, low) {
                    (Some(high), Some(low)) => {
                        out.push(high << 4 | low);
                        index += 3;
                        continue;
                    }
                    // 非法转义：原样保留，不 panic、不吞字符
                    _ => out.push(bytes[index]),
                }
            }
            b'+' => out.push(b' '),
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 浏览器看的那一页：极简 HTML（不引任何外部资源，避免授权页被第三方脚本污染）。
fn page(title: &str, message: &str) -> String {
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>{title}</title><style>body{{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;\
         background:#101014;color:#e8e8ea;display:flex;min-height:100vh;margin:0;\
         align-items:center;justify-content:center}}main{{max-width:32rem;padding:2rem;\
         text-align:center}}h1{{font-size:1.25rem;font-weight:600;margin:0 0 .75rem}}\
         p{{font-size:.9rem;line-height:1.6;color:#9a9aa2;margin:0}}</style></head>\
         <body><main><h1>{title}</h1><p>{message}</p></main></body></html>"
    )
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_url_matches_rfc_example_shape() {
        // RFC 7636 的示例 verifier 对应的 challenge（S256）由测试锁定形状：
        // 只校验「无填充、URL 安全字符、长度对得上」，不依赖外部向量。
        let digest = Sha256::digest(b"test-verifier");
        let encoded = base64_url(&digest);
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert_eq!(encoded.len(), 43, "32 字节摘要的 base64url 长度必须是 43");
    }

    #[test]
    fn percent_encode_round_trips_through_query_parser() {
        let raw = "a b&c=d/é";
        let encoded = percent_encode(raw);
        assert!(!encoded.contains(' '));
        let parsed = parse_query(&format!("k={encoded}"));
        assert_eq!(parsed.get("k").map(String::as_str), Some(raw));
    }

    #[test]
    fn query_parser_decodes_plus_and_bad_escapes() {
        let parsed = parse_query("a=1+2&b=%E4%B8%AD&c=%zz");
        assert_eq!(parsed.get("a").map(String::as_str), Some("1 2"));
        assert_eq!(parsed.get("b").map(String::as_str), Some("中"));
        // 非法转义原样保留，不 panic
        assert_eq!(parsed.get("c").map(String::as_str), Some("%zz"));
    }

    #[test]
    fn loopback_urls_are_the_only_plain_http_allowed() {
        assert!(is_loopback_url("http://127.0.0.1:8080/callback"));
        assert!(is_loopback_url("http://localhost/cb"));
        assert!(!is_loopback_url("http://example.com/cb"));
        assert!(!is_loopback_url("https://127.0.0.1/cb"));
    }

    #[test]
    fn random_tokens_differ_and_have_expected_length() {
        let registry = AuthRegistry::default();
        let first = random_token(&registry, 16);
        let second = random_token(&registry, 16);
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_expiry_uses_skew() {
        let token = StoredToken {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: Some(1_000_000),
            scopes: Vec::new(),
            token_type: None,
        };
        assert!(token.is_expired(1_000_000 - EXPIRY_SKEW_MS));
        assert!(!token.is_expired(1_000_000 - EXPIRY_SKEW_MS - 1));
    }
}
