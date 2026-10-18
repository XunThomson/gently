//! 「在登录窗口里登录，然后自动读取 web 会话」（`catalog.loginWeb` 的**桌面层实现**）。
//!
//! 分工：
//! - 核心（`catalog.loginWeb`）只回答**计划**：登录页、要读的 Cookie 名、写进哪个凭据键。
//!   地址来自插件清单的 `@login`，核心不内置任何第三方地址（ADR-0005）。
//! - 这一层负责**宿主能力**：开一个 webview 窗口加载登录页、轮询它自己的 Cookie 罐、
//!   拿到会话后调 `plugin.credentials.set` 落库。
//!
//! 为什么这样比「让用户自己去开发者工具里翻 Cookie」好：
//! - 用户面对的是站点自己的页面，登录过程（含扫码）都由站点完成，不经过我们仿写的接口；
//! - 会话值**不经过前端**：命令只回 `{state, credentialKey}`，界面拿不到令牌。
//!
//! 边界：窗口是应用自己的 WebView2 实例（与主窗口共用数据目录），**不是**用户系统浏览器
//! （浏览器 profile 里的 Cookie 属于另一个应用，读它是越权、而且新版 Chromium 的
//! app-bound 加密也读不出来）。

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::state::AppState;

/// 等用户登录的上限：够慢吞吞地扫码/输密码，又不至于把窗口永远挂在那里
const WAIT_TIMEOUT: Duration = Duration::from_secs(300);
/// 轮询 Cookie 的间隔（读的是内存里的 Cookie 罐，几乎零成本）
const POLL_INTERVAL: Duration = Duration::from_millis(700);
/// 登录窗口的标签：固定一个，重复点击复用/重置
const WINDOW_LABEL: &str = "plugin-web-login";

/// 打开登录窗口并在登录完成后自动把会话写进凭据库。
///
/// 返回契约信封：`{ok:true, data:{state, credentialKey?, source}}`。
/// `state` 只有三种：`confirmed`（已写入）/ `canceled`（用户关掉了窗口）/ `timeout`（超时）。
#[tauri::command]
pub async fn web_login(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source: String,
) -> Result<Value, String> {
    let core = std::sync::Arc::clone(&state.core);

    // 1) 问核心要计划（登录页 / Cookie 名 / 凭据键）——地址来自插件清单，不在代码里
    let plan = {
        let core = std::sync::Arc::clone(&core);
        let source = source.clone();
        tauri::async_runtime::spawn_blocking(move || {
            envelope(gently_core::dispatch(&core, "catalog.loginWeb", json!({ "source": source })))
        })
        .await
        .map_err(|err| format!("命令执行被中止：{err}"))?
    };
    if plan.get("ok").and_then(Value::as_bool) != Some(true) {
        /* 没声明 / 插件不存在：原样把信封交回去，界面按错误码说话 */
        return Ok(plan);
    }
    let plan = plan.get("data").cloned().unwrap_or(Value::Null);

    let url_text = plan.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    let credential_key = plan.get("credentialKey").and_then(Value::as_str).unwrap_or("").to_string();
    let title = plan.get("title").and_then(Value::as_str).unwrap_or("登录").to_string();
    let cookie_names: Vec<String> = plan
        .get("cookieNames")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|one| one.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let url = tauri::Url::parse(&url_text).map_err(|err| format!("登录页地址不合法：{err}"))?;

    // 2) 开一个真正的登录页窗口（重复调用时先把旧的关掉，避免叠窗）
    if let Some(old) = app.get_webview_window(WINDOW_LABEL) {
        let _ = old.close();
    }
    let window = tauri::WebviewWindowBuilder::new(&app, WINDOW_LABEL, tauri::WebviewUrl::External(url.clone()))
        .title(format!("登录 · {title}"))
        .inner_size(1040.0, 780.0)
        .center()
        .build()
        .map_err(|err| format!("打开登录窗口失败：{err}"))?;

    // 3) 轮询 Cookie 罐：等「要求的名字」都出现
    let poll_window = window.clone();
    let poll_url = url.clone();
    let poll_names = cookie_names.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        loop {
            // 用户关掉窗口 = 放弃
            if poll_window.app_handle().get_webview_window(WINDOW_LABEL).is_none() {
                return None;
            }
            if let Ok(cookies) = poll_window.cookies() {
                let session = pick(&cookies, &poll_url, &poll_names);
                if !session.is_empty() {
                    return Some(session);
                }
            }
            if started.elapsed() > WAIT_TIMEOUT {
                return None;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    })
    .await
    .map_err(|err| format!("等待登录被中止：{err}"))?;

    // 4) 收尾：关窗口
    if let Some(open) = app.get_webview_window(WINDOW_LABEL) {
        let _ = open.close();
    }

    let Some(session) = found else {
        /* 没拿到会话：**什么都不写**（宁可失败，也不留一份假凭据） */
        let canceled = app.get_webview_window(WINDOW_LABEL).is_none();
        return Ok(json!({
            "ok": true,
            "data": {
                "source": source,
                "state": "canceled",
                "canceled": canceled,
                "credentialKey": credential_key,
            }
        }));
    };

    // 5) 落库（走核心的凭据命令：它自己会校验「这个键是插件声明过的」）
    let set_result = {
        let core = std::sync::Arc::clone(&state.core);
        let source = source.clone();
        let key = credential_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            envelope(gently_core::dispatch(
                &core,
                "plugin.credentials.set",
                json!({ "id": source, "key": key, "value": session }),
            ))
        })
        .await
        .map_err(|err| format!("命令执行被中止：{err}"))?
    };
    if set_result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(json!({
            "ok": true,
            "data": { "source": source, "state": "confirmed", "credentialKey": credential_key }
        }))
    } else {
        /* 核心拒绝了这次写入（比如键没声明）：把它的错误码原样交回去，界面据此说人话 */
        Ok(set_result)
    }
}

/// `CoreResult` → 契约信封 `{ok, data|error, traceId}`（与本层唯一入口命令保持同一形状）。
fn envelope<T: serde::Serialize>(result: gently_core::CoreResult<T>) -> Value {
    serde_json::to_value(&result).unwrap_or_else(|err| {
        json!({
            "ok": false,
            "error": { "code": "common.internal", "message": format!("信封序列化失败：{err}") },
        })
    })
}

/// 从 Cookie 罐里挑出「登录页域名下、名字在清单里」的那些，按清单顺序拼成 `name=value; …`。
///
/// 只认名字白名单：会话里还会有一堆统计/埋点 Cookie，把它们一起写进凭据库既没用又会误导。
/// **缺一个就整体返回空**：半份 Cookie 写进去只会让人以为「已登录」。
fn pick(cookies: &[tauri::webview::Cookie<'static>], url: &tauri::Url, names: &[String]) -> String {
    let host = url.host_str().unwrap_or("");
    let mut pairs: Vec<String> = Vec::new();
    for name in names {
        let hit = cookies
            .iter()
            .find(|cookie| {
                cookie.name() == name && {
                    let domain = cookie.domain().unwrap_or("");
                    domain.is_empty() || host.ends_with(domain.trim_start_matches('.'))
                }
            })
            .or_else(|| cookies.iter().find(|cookie| cookie.name() == name));
        match hit {
            Some(cookie) => pairs.push(format!("{}={}", cookie.name(), cookie.value())),
            None => return String::new(),
        }
    }
    pairs.join("; ")
}

#[cfg(test)]
mod tests {
    use super::pick;
    use tauri::webview::Cookie;

    fn cookie(name: &str, value: &str, domain: &str) -> Cookie<'static> {
        let mut builder = Cookie::build((name.to_string(), value.to_string()));
        if !domain.is_empty() {
            builder = builder.domain(domain.to_string());
        }
        builder.path("/").build()
    }

    /// 只挑清单里点名的 Cookie，顺序照清单；别的（埋点、游客令牌）一律不带。
    #[test]
    fn picks_only_named_cookies_in_declared_order() {
        let jar = vec![
            cookie("NMTID", "n1", ".example.com"),
            cookie("MUSIC_U", "session", ".example.com"),
            cookie("__csrf", "csrf", ".example.com"),
            cookie("_ntes_nuid", "tracking", ".example.com"),
        ];
        let url = tauri::Url::parse("https://example.com/login").expect("url");
        let picked = pick(&jar, &url, &["MUSIC_U".to_string(), "__csrf".to_string()]);
        assert_eq!(picked, "MUSIC_U=session; __csrf=csrf");
    }

    /// 一个都没登录上时返回空串（调用方据此**不写凭据**）。
    #[test]
    fn empty_when_session_cookie_is_missing() {
        let jar = vec![cookie("NMTID", "n1", ".example.com")];
        let url = tauri::Url::parse("https://example.com/login").expect("url");
        assert_eq!(pick(&jar, &url, &["MUSIC_U".to_string()]), "");
    }

    /// 缺一个就整体不合格：半份 Cookie 写进去只会让人以为「已登录」。
    #[test]
    fn partial_cookies_are_rejected() {
        let jar = vec![cookie("MUSIC_U", "session", ".example.com")];
        let url = tauri::Url::parse("https://example.com/login").expect("url");
        let picked = pick(&jar, &url, &["MUSIC_U".to_string(), "__csrf".to_string()]);
        assert!(picked.is_empty(), "{picked}");
    }
}
