//! 浏览器窗口登录：**插件声明「打开哪个登录页、读哪些 Cookie、写进哪个凭据键」，
//! 桌面层负责开窗口与读 Cookie**。
//!
//! 为什么这样切：
//! - 登录页地址是**具体第三方的**，核心一旦知道就违反 ADR-0005；因此它来自清单的 `@login`，
//!   核心只做校验与转手（和 `@oauth` 同一套思路）。
//! - 读 webview 的 Cookie 需要宿主能力（Tauri 的 `cookies_for_url`），核心不依赖 Tauri，
//!   所以这里**只出计划**：`{url, cookieNames, credentialKey}`。
//! - 会话值由桌面层读出来直接交给 `plugin.credentials.set` 落库，**不经过前端**，
//!   界面上永远只看得到状态与键名。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, Fallible};

#[derive(Deserialize)]
struct Params {
    source: String,
}

/// `catalog.loginWeb{source}`：给出「用浏览器窗口登录」所需的计划。
///
/// 未声明 `@login` 的插件一律 `common.not_implemented`（不是错误码新造一个：能力缺失的语义一致）。
pub fn login_web(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: Params = parse_params(params)?;
    let manifest = ctx
        .plugins
        .manifest_of(&params.source)
        .ok_or_else(|| CoreError::not_found(format!("插件未加载：{}", params.source)))?;

    let plan = manifest.web_login.clone().ok_or_else(|| {
        CoreError::not_implemented(&format!("插件没有声明浏览器窗口登录（@login）：{}", params.source))
    })?;

    Ok(json!({
        "source": params.source,
        "title": manifest.name,
        "url": plan.url,
        "cookieNames": plan.cookie_names,
        "credentialKey": plan.credential_key,
    }))
}
