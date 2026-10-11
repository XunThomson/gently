//! 插件管理命令的收尾（M5）：配置、凭据、检查更新。
//!
//! 三块各自的取舍：
//!
//! - **配置**：值存 SQLite（**不含凭据**）+ `revision` 乐观并发。两个窗口同时改配置时，
//!   后写的那个会拿到 `common.conflict`，而不是静默覆盖对方的设置；
//! - **凭据**：只读写**清单声明过**的键（清单是用户同意时看到的那份，不允许偷偷多存），
//!   落到 `CredentialStore`（当前是内存实现，见 `plugin/credentials.rs`），
//!   **永不落库、永不回日志**；`status` 只回「是否已配置」，没有任何命令能把值读回来；
//! - **检查更新**：**不自动更新**。`url` 来源下载并比对版本与 sha256；`catalog` 来源比对
//!   **本地缓存的订阅索引**（订阅刷新是用户动作）；`paste`/`file`/`dir` 无从比对 → 返回 `null`
//!   （用户的文件自己更新，应用不该假装知道）。

use serde_json::{json, Value};

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::{parse_index, parse_source, sha256_hex, PluginPermission};

/// 配置值的体积上限：插件配置是「几个开关和账号名」，不该拿来存数据。
const MAX_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Debug, serde::Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Debug, serde::Deserialize)]
struct ConfigPutParams {
    id: String,
    values: Value,
    revision: i64,
}

#[derive(Debug, serde::Deserialize)]
struct CredentialSetParams {
    id: String,
    key: String,
    value: String,
}

#[derive(Debug, serde::Deserialize)]
struct CredentialClearParams {
    id: String,
    /// 缺省清空该插件的**全部**凭据
    #[serde(default)]
    key: Option<String>,
}

// ---------------------------------------------------------------- 配置

/// `plugin.config.get{id}`：`{values, revision}`（从未存过时 `{values: {}, revision: 0}`）。
pub fn config_get(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    installed(ctx, &params.id)?;
    match store.get_plugin_config(&params.id)? {
        Some((values, revision)) => Ok(json!({ "values": values, "revision": revision })),
        None => Ok(json!({ "values": {}, "revision": 0 })),
    }
}

/// `plugin.config.put{id, values, revision}`：revision 不匹配 → `common.conflict`。
pub fn config_put(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: ConfigPutParams = parse_params(params)?;
    let store = require_store(ctx)?;
    installed(ctx, &params.id)?;
    if !params.values.is_object() {
        return Err(CoreError::invalid_argument("插件配置必须是对象")
            .with_details(json!({ "id": params.id })));
    }
    // 配置是「几个开关和账号名」，不是数据仓库：给个上限，避免把库撑坏
    let bytes = serde_json::to_string(&params.values).map(|text| text.len()).unwrap_or(0);
    if bytes > MAX_CONFIG_BYTES {
        return Err(CoreError::invalid_argument(format!(
            "插件配置超过 {MAX_CONFIG_BYTES} 字节上限"
        ))
        .with_details(json!({ "bytes": bytes, "limit": MAX_CONFIG_BYTES })));
    }
    let revision = store.put_plugin_config(&params.id, &params.values, params.revision)?;

    // 配置变了要让运行时看到新值：卸载后按需重载（下次使用时会重建）
    ctx.plugins.unload(&params.id);
    Ok(json!({ "revision": revision }))
}

// ---------------------------------------------------------------- 凭据

/// `plugin.credentials.set{id, key, value}`：只接受清单声明过的键。
pub fn credentials_set(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: CredentialSetParams = parse_params(params)?;
    let record = installed(ctx, &params.id)?;
    declared_key(&record.manifest.credentials, &params.key)?;

    if params.value.trim().is_empty() {
        // 空值几乎总是误操作；要清除请用 clear
        return Err(CoreError::invalid_argument("凭据值不能为空（清除请用 plugin.credentials.clear）")
            .with_details(json!({ "key": params.key })));
    }
    ctx.plugins.credentials().set(&params.id, &params.key, Some(&params.value));
    tracing::info!(plugin = %params.id, key = %params.key, "插件凭据已写入");
    Ok(Value::Null)
}

/// `plugin.credentials.clear{id, key?}`：清一个键或清空该插件的全部凭据。
pub fn credentials_clear(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: CredentialClearParams = parse_params(params)?;
    let record = installed(ctx, &params.id)?;

    match params.key.as_deref().filter(|key| !key.is_empty()) {
        Some(key) => {
            declared_key(&record.manifest.credentials, key)?;
            ctx.plugins.credentials().set(&params.id, key, None);
        }
        None => {
            // 清空：以清单为准（已配置但清单里没有的历史键也一并清掉）
            for field in &record.manifest.credentials {
                ctx.plugins.credentials().set(&params.id, &field.key, None);
            }
            for key in ctx.plugins.credentials().keys(&params.id) {
                ctx.plugins.credentials().set(&params.id, &key, None);
            }
        }
    }
    Ok(Value::Null)
}

/// `plugin.credentials.status{id}`：**只回「是否已配置」**，永不返回值。
pub fn credentials_status(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = parse_params(params)?;
    let record = installed(ctx, &params.id)?;
    let present = ctx.plugins.credentials().keys(&params.id);

    Ok(Value::Array(
        record
            .manifest
            .credentials
            .iter()
            .map(|field| {
                json!({
                    "key": field.key,
                    "label": field.label,
                    // 敏感值在界面上掩码显示（契约里的 secret 标记）
                    "secret": field.secret,
                    "present": present.contains(&field.key),
                })
            })
            .collect(),
    ))
}

// ---------------------------------------------------------------- 检查更新

/// `plugin.checkUpdate{id}`：与来源比对版本/校验和（**不自动更新**）。
///
/// - `url` 来源：下载新版本 → 解析清单 → 比对版本与 sha256；
/// - `catalog` 来源：与**本地缓存的**订阅索引比对（订阅刷新由用户触发）；
/// - `paste` / `file` / `dir`：无从比对 → `null`（用户的文件自己更新）。
pub fn check_update(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = parse_params(params)?;
    let record = installed(ctx, &params.id)?;
    let current = record.manifest.version.clone();

    match record.origin_kind.as_str() {
        "url" => {
            let bytes = download_url(ctx, &record.origin_value)?;
            let text = String::from_utf8(bytes.clone()).map_err(|_| {
                CoreError::new(ErrorCode::PluginInvalidSource, "下载的插件不是 UTF-8 文本")
            })?;
            let parsed = parse_source(&text)?;
            let latest = parsed.manifest.version.clone();
            let latest_sha = sha256_hex(&bytes);
            Ok(json!({
                "current": current,
                "latest": latest,
                "changed": latest != current || Some(latest_sha) != record.sha256,
                "source": "url",
            }))
        }
        "catalog" => {
            // origin_value 形如 `<subscriptionId>::<fileName>`
            let (subscription_id, file_name) =
                record.origin_value.split_once("::").unwrap_or((record.origin_value.as_str(), ""));
            let path = ctx.paths.subscriptions.join(format!("{subscription_id}.json"));
            let Some(text) = std::fs::read_to_string(&path).ok() else {
                // 索引还没缓存过：让用户先刷新订阅，而不是报一个含糊的错误
                return Err(CoreError::new(
                    ErrorCode::SubscriptionFetchFailed,
                    "订阅索引尚未缓存，请先刷新订阅",
                )
                .with_details(json!({ "subscriptionId": subscription_id })));
            };
            let index = parse_index(&text)?;
            let entry = index
                .sources
                .iter()
                .find(|entry| entry.file_name == file_name)
                .ok_or_else(|| {
                    CoreError::not_found(format!("订阅索引里已没有这个条目：{file_name}")).with_details(
                        json!({ "subscriptionId": subscription_id, "fileName": file_name }),
                    )
                })?;
            let latest = entry.version.clone();
            let latest_sha = entry.sha256.clone();
            Ok(json!({
                "current": current,
                "latest": latest,
                "changed": latest != current
                    || (latest_sha.is_some() && latest_sha != record.sha256),
                "source": "catalog",
            }))
        }
        // 本地来源：应用无从知道用户手上有没有更新的文件
        _ => Ok(Value::Null),
    }
}

// ---------------------------------------------------------------- 内部

fn require_store(ctx: &CoreContext) -> Fallible<&crate::store::Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写插件状态").with_details(
            json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

/// 取已安装插件的记录（不存在 → `common.not_found`）。
fn installed(ctx: &CoreContext, id: &str) -> Fallible<crate::plugin::InstalledPlugin> {
    require_store(ctx)?
        .get_plugin(id)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{id}")))
}

/// 键必须在清单里声明过：清单是用户同意时看到的那份，不允许偷偷多存。
fn declared_key(
    fields: &[crate::plugin::CredentialField],
    key: &str,
) -> Fallible<()> {
    if fields.iter().any(|field| field.key == key) {
        return Ok(());
    }
    Err(CoreError::invalid_argument(format!("插件未声明这个凭据字段：{key}")).with_details(json!({
        "key": key,
        "declared": fields.iter().map(|field| field.key.clone()).collect::<Vec<_>>(),
    })))
}

/// 下载（复用插件 URL 导入那一套：仅公网 HTTPS、限体积、防 SSRF）。
fn download_url(ctx: &CoreContext, url: &str) -> Fallible<Vec<u8>> {
    crate::commands::download_url_checked(ctx, url)
}

/// 让编译器检查 `PluginPermission` 仍被引用（凭据命令依赖清单权限推导）。
#[allow(dead_code)]
fn requires_credentials_permission(record: &crate::plugin::InstalledPlugin) -> bool {
    record.manifest.permissions.contains(&PluginPermission::Credentials)
}
