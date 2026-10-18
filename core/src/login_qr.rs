//! 二维码登录：**插件出二维码内容、核心轮询会话并落凭据**。
//!
//! 为什么这样切：
//! - 登录 URL / 轮询接口是**具体第三方的**，核心一旦知道就违反 ADR-0005（对第三方资源中立）。
//!   所以二维码内容由插件的 `getLoginQr()` 给出，核心只做转手（并在缺字段时如实报错）。
//! - 会话值必须落进凭据库，而插件**没有写凭据的能力**（`credentials.get` 只读，R59 定下的硬线）。
//!   因此由核心在 `pollLoginQr(key)` 报 `confirmed` 时写入，并且**只认清单声明过的凭据键**——
//!   一个插件不能借登录之名覆盖别的字段（也绝不能写 `__oauth_token`）。
//! - 会话值**永不回给前端**：命令只回状态与键名，界面拿不到令牌。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::PluginCapability;

#[derive(Deserialize)]
struct QrParams {
    source: String,
}

#[derive(Deserialize)]
struct PollParams {
    source: String,
    key: String,
}

/// `catalog.loginQr{source}`：让插件开一次登录会话，把二维码要编码的内容交给界面。
///
/// 返回 `{source, key, content, tip?}`：`content` 是要画成二维码的字符串（通常是登录 URL），
/// `key` 是后续轮询用的会话标识，`tip` 是插件给的提示语（可选，界面原样展示）。
pub fn login_qr(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: QrParams = parse_params(params)?;
    crate::catalog_detail::ready_source(ctx, &params.source, PluginCapability::LoginQr)?;

    let raw = ctx
        .plugins
        .call(&params.source, "getLoginQr", "[]")
        .map_err(|err| {
            // 能力探测说支持、调用却失败：如实报运行时错误，别让界面以为「没有二维码」
            CoreError::new(ErrorCode::PluginRuntimeError, format!("getLoginQr 调用失败：{}", err.message))
                .with_details(json!({ "source": params.source }))
        })?;
    let value: Value = serde_json::from_str(&raw).map_err(|err| {
        CoreError::new(ErrorCode::PluginRuntimeError, format!("getLoginQr 返回的不是合法 JSON：{err}"))
    })?;

    let content = value.get("content").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err(CoreError::new(
            ErrorCode::PluginRuntimeError,
            "getLoginQr 没有给出二维码内容（content 为空）",
        )
        .with_details(json!({ "source": params.source })));
    }
    let key = value.get("key").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let tip = value.get("tip").and_then(Value::as_str).map(str::to_string);

    Ok(json!({
        "source": params.source,
        "key": key,
        "content": content,
        "tip": tip,
    }))
}

/// `catalog.loginQrPoll{source, key}`：问一次登录状态。
///
/// 状态：`waiting`（还没扫） / `scanned`（扫了，待确认） / `confirmed`（确认了） / `expired`（过期）。
/// **只有 `confirmed` 会写凭据**：插件必须同时给出 `credentialKey` 与 `value`，且 `credentialKey`
/// 必须是清单声明过的凭据键；否则按 `plugin.permission_denied` 拒绝。
pub fn login_qr_poll(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PollParams = parse_params(params)?;
    crate::catalog_detail::ready_source(ctx, &params.source, PluginCapability::LoginQr)?;
    if params.key.trim().is_empty() {
        return Err(CoreError::invalid_argument("登录会话标识（key）不能为空"));
    }

    let args = json!([params.key.trim()]).to_string();
    let raw = ctx.plugins.call(&params.source, "pollLoginQr", &args)?;
    let value: Value = serde_json::from_str(&raw).map_err(|err| {
        CoreError::new(ErrorCode::PluginRuntimeError, format!("pollLoginQr 返回的不是合法 JSON：{err}"))
    })?;

    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("waiting")
        .trim()
        .to_string();

    if state != "confirmed" {
        return Ok(json!({ "source": params.source, "state": normalize_state(&state) }));
    }

    // 确认登录：校验回写键 + 落凭据，且**绝不回传会话值**
    let credential_key = value
        .get("credentialKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let session = value.get("value").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if session.is_empty() {
        return Err(CoreError::new(
            ErrorCode::PluginRuntimeError,
            "登录已确认，但插件没有给出会话值（value 为空）",
        ));
    }
    let declared = declared_credential_keys(ctx, &params.source)?;
    if credential_key.is_empty() || !declared.iter().any(|key| key == &credential_key) {
        return Err(CoreError::new(
            ErrorCode::PluginPermissionDenied,
            format!("插件想把登录会话写进未声明的凭据键：{credential_key}"),
        )
        .with_details(json!({ "declared": declared })));
    }
    ctx.plugins
        .credentials()
        .set(&params.source, &credential_key, Some(&session));
    /* 审计：**只记键名**，会话值永不进日志（红线 14） */
    tracing::info!(plugin = %params.source, key = %credential_key, "插件凭据已写入（二维码登录）");

    Ok(json!({
        "source": params.source,
        "state": "confirmed",
        "credentialKey": credential_key,
    }))
}

/// 只认四个状态；插件给别的一律当「还没扫」（界面继续轮询，不会误判成登录成功）
fn normalize_state(state: &str) -> &'static str {
    match state {
        "scanned" => "scanned",
        "expired" => "expired",
        "confirmed" => "confirmed",
        _ => "waiting",
    }
}


/// 插件清单里**声明过的凭据键**（未声明的一律不许写）
fn declared_credential_keys(ctx: &CoreContext, source: &str) -> Fallible<Vec<String>> {
    let manifest = ctx
        .plugins
        .manifest_of(source)
        .ok_or_else(|| CoreError::not_found(format!("插件未加载：{source}")))?;
    Ok(manifest.credentials.into_iter().map(|field| field.key).collect())
}
