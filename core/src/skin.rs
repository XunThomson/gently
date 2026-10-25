//! 皮肤域：结构校验（含**令牌键名白名单**）+ 存储 + 导入导出（M4b）。
//!
//! # 白名单的唯一来源
//!
//! 令牌名的唯一数据源是 `src/config/theme/theme.config.json`（AGENTS 约束 1）。
//! 校验必须在**核心**完成（前端传来的白名单不可信，等于没校验），
//! 因此这里用 `include_str!` 把那份配置编进核心并按需解析——不抄一份令牌名列表，
//! 否则主题配置一演进，白名单就会悄悄过期。
//!
//! # 校验分三层
//!
//! 1. **结构**：必须是对象；`id` 形状合法（id 会当文件名用，必须拒绝路径分隔符）；
//!    `name` 非空；各组必须是对象；
//! 2. **键名**：组内的键必须存在于主题配置对应位置，否则 → `skin.token_rejected`
//!    （**列出被拒键名**，而不是静默忽略——这正是 v0.1 之前的缺口）；
//! 3. **值类型**：令牌值的类型必须与主题配置里的一致（`radius.md` 是字符串，
//!    写成数字就是明确的结构错误），否则 → `skin.invalid_document`。
//!
//! 令牌的**合并与 CSS 变量注入留在前端**（渲染管线）；核心只管校验、存储、导入导出。

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};

/// 主题配置（令牌白名单的唯一来源）。
///
/// 跨目录 `include_str!`：核心与前端共用同一份配置，构建时把它编进二进制，
/// 因此**不需要在 Rust 里再维护一份令牌名清单**。
const THEME_CONFIG: &str = include_str!("../../src/config/theme/theme.config.json");

/// 皮肤能覆盖的令牌组（与前端 `SkinOverrides` 一致）。
const OVERRIDE_GROUPS: [&str; 9] = [
    "palette", "scheme", "typography", "radius", "spacing", "shadow", "motion", "zIndex",
    "components",
];

/// 元数据字段（不是令牌组）。
const META_FIELDS: [&str; 8] =
    ["id", "name", "description", "author", "version", "tags", "swatches", "builtin"];

fn theme_config() -> &'static Value {
    static CONFIG: OnceLock<Value> = OnceLock::new();
    CONFIG.get_or_init(|| serde_json::from_str(THEME_CONFIG).unwrap_or(Value::Null))
}

#[derive(Debug, serde::Deserialize)]
struct PreviewParams {
    from: crate::contract::ImportSource,
}

#[derive(Debug, serde::Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Debug, serde::Deserialize)]
struct ActiveParams {
    /// `null` = 恢复默认主题
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ExportParams {
    id: String,
    /// `json`（缺省）返回文本；`file` 写到 `<data>/skins/<id>.json`
    #[serde(default)]
    format: Option<String>,
}

// ---------------------------------------------------------------- 命令

/// `skin.list`：已安装的用户皮肤（**不含**随包发布的内置预设）。
///
/// 每项多带一个 `active` 字段：前端合并「内置预设 + 用户皮肤」时用它标出当前选择。
pub fn list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let _ = parse_params::<Value>(params)?;
    let store = require_store(ctx)?;
    let active = store.active_skin()?;
    let rows = store.list_skins()?;
    Ok(Value::Array(
        rows.iter()
            .map(|row| {
                let mut skin = row.document.clone();
                if !skin.is_object() {
                    skin = json!({ "id": row.id, "name": row.name });
                }
                skin["id"] = json!(row.id);
                skin["active"] = json!(active.as_deref() == Some(row.id.as_str()));
                skin["builtin"] = json!(false);
                skin
            })
            .collect(),
    ))
}

/// `skin.preview{from}`：读清楚但**不落盘**（结构 + 令牌白名单校验）。
pub fn preview(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PreviewParams = parse_params(params)?;
    let source = read_source(ctx, params.from)?;
    let (skin, warnings) = validate(&source.document)?;
    Ok(json!({ "skin": skin, "warnings": warnings }))
}

/// `skin.install{from}`：校验后落盘（同 id 即覆盖安装）。
pub fn install(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PreviewParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let source = read_source(ctx, params.from)?;
    let (skin, _warnings) = validate(&source.document)?;

    let text = skin.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let name = skin.get("name").and_then(Value::as_str).unwrap_or(&text).to_string();
    let author = skin.get("author").and_then(Value::as_str).unwrap_or_default().to_string();
    let version = skin.get("version").and_then(Value::as_str).map(str::to_string);

    let row = store.upsert_skin(
        &text,
        &name,
        &author,
        version.as_deref(),
        &skin,
        source.origin_kind,
        &source.origin_value,
        source.sha256.as_deref(),
    )?;
    tracing::info!(skin = %row.id, name = %row.name, "皮肤已安装");
    Ok(skin)
}

/// `skin.remove{id}`：删除皮肤；若它正被激活则回到默认主题。
pub fn remove(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    if !store.delete_skin(&params.id)? {
        return Err(CoreError::not_found(format!("皮肤未安装：{}", params.id)));
    }
    if store.active_skin()?.as_deref() == Some(params.id.as_str()) {
        // 皮肤没了还留着激活 id，会让前端每次启动都找不到主题
        store.set_active_skin(None)?;
    }
    Ok(Value::Null)
}

/// `skin.setActive{id|null}`：切换当前皮肤（`null` 恢复默认主题）。
pub fn set_active(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: ActiveParams = parse_params(params)?;
    let store = require_store(ctx)?;
    match params.id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => {
            if store.get_skin(id)?.is_none() {
                return Err(CoreError::not_found(format!("皮肤未安装：{id}")));
            }
            store.set_active_skin(Some(id))?;
        }
        None => store.set_active_skin(None)?,
    }
    Ok(Value::Null)
}

/// `skin.export{id, format}`：导出即分享（返回 JSON 文本，或写到 `<data>/skins/<id>.json`）。
pub fn export(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: ExportParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let row = store
        .get_skin(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("皮肤未安装：{}", params.id)))?;

    let format = params.format.as_deref().unwrap_or("json");
    match format {
        "json" => {
            let text = serde_json::to_string_pretty(&row.document)
                .map_err(|err| CoreError::internal(format!("皮肤序列化失败：{err}")))?;
            Ok(json!({ "json": text }))
        }
        "file" => {
            // 文件名固定为 `<id>.json`：id 在导入时已校验过（无路径分隔符）
            let path = ctx.paths.skins.join(format!("{}.json", row.id));
            let text = serde_json::to_string_pretty(&row.document)
                .map_err(|err| CoreError::internal(format!("皮肤序列化失败：{err}")))?;
            std::fs::write(&path, text).map_err(|err| {
                CoreError::new(ErrorCode::LibraryIoError, format!("写入皮肤文件失败：{err}"))
                    .with_details(json!({ "path": path.to_string_lossy() }))
            })?;
            Ok(json!({ "path": path.to_string_lossy().replace('\\', "/") }))
        }
        other => Err(CoreError::invalid_argument(format!("不支持的导出格式：{other}"))
            .with_details(json!({ "format": other, "supported": ["json", "file"] }))),
    }
}

// ---------------------------------------------------------------- 导入来源

/// 一份待安装的皮肤文档 + 来源信息。
struct SkinSource {
    document: Value,
    origin_kind: &'static str,
    origin_value: String,
    sha256: Option<String>,
}

/// 读入皮肤文档：粘贴 / 文件 / URL 三种来源（与插件同构的 `ImportSource`）。
fn read_source(ctx: &CoreContext, from: crate::contract::ImportSource) -> Fallible<SkinSource> {
    use crate::contract::ImportSource as Source;

    let (text, origin_kind, origin_value) = match from {
        Source::Paste { content } => (content, "paste", String::new()),
        Source::File { path } => {
            let text = std::fs::read_to_string(&path).map_err(|err| {
                CoreError::new(ErrorCode::LibraryIoError, format!("读取皮肤文件失败：{err}"))
                    .with_details(json!({ "path": path }))
            })?;
            (text, "file", path)
        }
        Source::Url { url } => {
            let bytes = download_url(ctx, &url)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                CoreError::new(ErrorCode::SkinInvalidDocument, "下载的皮肤不是 UTF-8 文本")
            })?;
            (text, "url", url)
        }
        other => {
            // 明确说清「哪个来源还没实现」，而不是笼统的 not_implemented
            let kind = source_kind(&other);
            return Err(CoreError::not_implemented(&format!("skin.preview({kind})")).with_details(
                json!({ "kind": kind, "supported": ["paste", "file", "url"] }),
            ));
        }
    };

    let sha256 = crate::plugin::sha256_hex(text.as_bytes());
    let document: Value = serde_json::from_str(&text).map_err(|err| {
        CoreError::new(ErrorCode::SkinInvalidDocument, format!("皮肤不是合法 JSON：{err}"))
            .with_details(json!({ "reason": err.to_string() }))
    })?;

    Ok(SkinSource { document, origin_kind, origin_value, sha256: Some(sha256) })
}

fn source_kind(from: &crate::contract::ImportSource) -> &'static str {
    use crate::contract::ImportSource as Source;
    match from {
        Source::File { .. } => "file",
        Source::Dir { .. } => "dir",
        Source::Archive { .. } => "archive",
        Source::Url { .. } => "url",
        Source::Paste { .. } => "paste",
        Source::Catalog { .. } => "catalog",
    }
}

/// 下载皮肤：与插件下载同一套公网 HTTPS / 防内网校验（核心主动发起，防 SSRF）。
fn download_url(ctx: &CoreContext, url: &str) -> Fallible<Vec<u8>> {
    crate::plugin::require_public_https(url, "皮肤地址")?;
    let response = ctx.http.send(&crate::plugin::HttpRequest {
        method: "GET".into(),
        url: url.to_string(),
        headers: vec![],
        body: None,
    })?;
    if response.truncated {
        return Err(CoreError::invalid_argument("皮肤超过体积上限"));
    }
    Ok(response.body.into_bytes())
}

// ---------------------------------------------------------------- 校验

/// 已退役的组件令牌：旧版皮肤仍可能带它们。
///
/// **不能直接当未知键拒绝**：`validate` 对任何 `rejected` 都返回整份 `skin.token_rejected`，
/// 那样 R84 之前合法、只是后来删掉的视觉键会让用户皮肤整份导不进来。
/// 这里按明确名单接受但丢弃（并给 warning），名单只增不减、不得放宽成「未知键都接受」。
const RETIRED_COMPONENT_TOKENS: &[&str] = &[
    "components.lyrics.activeFontSize",
    "components.lyrics.activeBg",
    "components.lyrics.guideColor",
    "components.lyrics.guideWidth",
];

/// 校验并规范化一份皮肤文档；被拒的键名走 `skin.token_rejected`。
pub fn validate(document: &Value) -> Fallible<(Value, Vec<String>)> {
    let Some(object) = document.as_object() else {
        return Err(invalid("皮肤顶层必须是对象"));
    };
    let mut warnings: Vec<String> = Vec::new();

    // ---- 元数据 ----
    let id = object.get("id").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if !is_valid_skin_id(&id) {
        return Err(invalid("皮肤 id 不合法（小写字母/数字/`.`/`-`/`_`，2~64 位，不能含路径分隔符）")
            .with_details(json!({ "field": "id", "value": id })));
    }
    let name = object.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(invalid("皮肤缺少 name").with_details(json!({ "field": "name" })));
    }
    for field in ["description", "author"] {
        if object.get(field).and_then(Value::as_str).unwrap_or_default().trim().is_empty() {
            warnings.push(format!("皮肤未声明 {field}，界面会显示为空"));
        }
    }
    if let Some(swatches) = object.get("swatches") {
        let ok = swatches
            .as_array()
            .is_some_and(|items| items.iter().all(|item| item.as_str().is_some()));
        if !ok {
            return Err(invalid("swatches 必须是字符串数组").with_details(json!({ "field": "swatches" })));
        }
    } else {
        warnings.push("皮肤未声明 swatches（主题卡片的预览色块会留空）".into());
    }
    if object.get("builtin").and_then(Value::as_bool) == Some(true) {
        // 内置标记由应用自己决定，用户皮肤不能自称内置
        warnings.push("皮肤声明了 builtin，已按用户皮肤处理（内置预设随包发布）".into());
    }

    // ---- 顶层键：只允许元数据字段与已知令牌组 ----
    let config = theme_config();
    let mut rejected: Vec<String> = Vec::new();
    let mut unknown_top: Vec<String> = Vec::new();
    for key in object.keys() {
        if META_FIELDS.contains(&key.as_str()) {
            continue;
        }
        if !OVERRIDE_GROUPS.contains(&key.as_str()) {
            unknown_top.push(key.clone());
        }
    }
    if !unknown_top.is_empty() {
        return Err(invalid("皮肤包含未知的令牌组").with_details(json!({ "unknown": unknown_top })));
    }

    // ---- 各组令牌：键名白名单 + 值类型 ----
    let mut skin = serde_json::Map::new();
    for key in object.keys().filter(|key| META_FIELDS.contains(&key.as_str())) {
        if key == "builtin" {
            continue; // 下面统一写 false
        }
        skin.insert(key.clone(), object[key].clone());
    }
    // 用户皮肤**永远**不是内置的：显式写 false 而不是省略，
    // 这样前端不必区分「没这个字段」与「false」
    skin.insert("builtin".into(), json!(false));

    for group in OVERRIDE_GROUPS {
        let Some(value) = object.get(group) else { continue };
        let expected = config.get(group).unwrap_or(&Value::Null);
        // 空组不进结果（避免皮肤里出现一堆没用的空对象）
        if let Some(normalized) = validate_group(group, value, expected, &mut rejected, &mut warnings)? {
            skin.insert(group.to_string(), normalized);
        }
    }

    if !rejected.is_empty() {
        return Err(CoreError::new(
            ErrorCode::SkinTokenRejected,
            format!("皮肤包含未允许的令牌键名：{}", rejected.join("、")),
        )
        .with_details(json!({ "rejected": rejected, "skinId": id })));
    }

    Ok((Value::Object(skin), warnings))
}

/// 校验一个令牌组；返回规范化后的组（`None` = 该组为空）。
///
/// `scheme` 与 `components` 是嵌套结构，单独分支处理。
fn validate_group(
    group: &str,
    value: &Value,
    expected: &Value,
    rejected: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Fallible<Option<Value>> {
    if group == "scheme" {
        let Some(object) = value.as_object() else {
            return Err(invalid("scheme 必须是对象（含 light / dark）"));
        };
        let mut out = serde_json::Map::new();
        for (scheme, tokens) in object {
            if scheme != "light" && scheme != "dark" {
                rejected.push(format!("scheme.{scheme}"));
                continue;
            }
            let expected_scheme = expected.get(scheme).unwrap_or(&Value::Null);
            if let Some(normalized) = validate_tokens(&format!("scheme.{scheme}"), tokens, expected_scheme, rejected, warnings)? {
                out.insert(scheme.clone(), normalized);
            }
        }
        return Ok((!out.is_empty()).then(|| Value::Object(out)));
    }

    if group == "components" {
        let Some(object) = value.as_object() else {
            return Err(invalid("components 必须是对象"));
        };
        let mut out = serde_json::Map::new();
        for (component, fields) in object {
            // 组件名也走白名单：写错组件名等于皮肤静默失效
            let Some(expected_component) = expected.get(component) else {
                rejected.push(format!("components.{component}"));
                continue;
            };
            if let Some(normalized) =
                validate_tokens(&format!("components.{component}"), fields, expected_component, rejected, warnings)?
            {
                out.insert(component.clone(), normalized);
            }
        }
        return Ok((!out.is_empty()).then(|| Value::Object(out)));
    }

    validate_tokens(group, value, expected, rejected, warnings)
}

/// 校验一组「令牌名 → 值」：键名必须在白名单里，值类型必须与主题配置一致。
fn validate_tokens(
    path: &str,
    value: &Value,
    expected: &Value,
    rejected: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Fallible<Option<Value>> {
    let Some(tokens) = value.as_object() else {
        return Err(invalid(&format!("{path} 必须是对象")));
    };
    let Some(allowed) = expected.as_object() else {
        // 主题配置里没有这一组（理论上不会发生；白名单来源本身有问题时要说清）
        return Err(CoreError::internal(format!("主题配置缺少令牌组 {path}")));
    };

    let mut out = serde_json::Map::new();
    for (token, token_value) in tokens {
        let full_path = format!("{path}.{token}");
        if RETIRED_COMPONENT_TOKENS.contains(&full_path.as_str()) {
            // 旧皮肤里仍可能出现：丢弃但不让整份皮肤失败
            warnings.push(format!("{full_path} 已废弃，已忽略"));
            continue;
        }
        let Some(reference) = allowed.get(token) else {
            rejected.push(full_path);
            continue;
        };
        if !same_type(reference, token_value) {
            return Err(invalid(&format!(
                "{path}.{token} 的值类型不对（期望 {}）",
                type_name(reference)
            ))
            .with_details(json!({ "token": format!("{path}.{token}"), "expected": type_name(reference) })));
        }
        out.insert(token.clone(), token_value.clone());
    }
    // 空对象不进结果：避免皮肤里出现一堆没用的空组
    Ok((!out.is_empty()).then(|| Value::Object(out)))
}

/// 类型是否一致（数字不区分整数/浮点；对象只要求同为对象）。
fn same_type(reference: &Value, value: &Value) -> bool {
    match reference {
        Value::String(_) => value.is_string(),
        Value::Number(_) => value.is_number(),
        Value::Bool(_) => value.is_boolean(),
        Value::Array(_) => value.is_array(),
        Value::Object(_) => value.is_object(),
        Value::Null => true,
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "字符串",
        Value::Number(_) => "数字",
        Value::Bool(_) => "布尔",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
        Value::Null => "任意",
    }
}

/// 皮肤 id：小写字母/数字/`.`/`-`/`_`，2~64 位。
///
/// **必须拒绝路径分隔符**：导出时 id 会当文件名用（`skins/<id>.json`）。
fn is_valid_skin_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_'))
}

/// 结构错误统一走 `skin.invalid_document`。
fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::SkinInvalidDocument, message)
}

fn require_store(ctx: &CoreContext) -> Fallible<&crate::store::Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写皮肤").with_details(
            json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单必须真的来自主题配置：include_str! 的路径写错会静默得到 null，
    /// 那样所有键名都会被判「未允许」——用最小皮肤守住这条。
    #[test]
    fn whitelist_comes_from_the_theme_config() {
        let config = theme_config();
        assert!(config.is_object(), "主题配置没被编进来：{config}");
        assert!(config["palette"]["brand"].is_string());
        assert!(config["components"]["sidebar"]["width"].is_number());

        let skin = json!({
            "id": "demo-skin",
            "name": "演示",
            "palette": {"brand": "#ff0000"},
            "radius": {"md": "2px"},
            "components": {"sidebar": {"width": 200}},
        });
        let (normalized, _warnings) = validate(&skin).expect("合法皮肤应通过");
        assert_eq!(normalized["palette"]["brand"], json!("#ff0000"));
        assert_eq!(normalized["components"]["sidebar"]["width"], json!(200));
    }

    #[test]
    fn retired_lyric_tokens_are_accepted_but_dropped() {
        // R84 删掉的四个键在旧皮肤里仍然合法过：不能因为一个废弃键拒绝整份皮肤。
        let skin = json!({
            "id": "legacy-skin",
            "name": "旧皮肤",
            "components": {
                "lyrics": {
                    "fontSize": 17,
                    "activeFontSize": 19,
                    "activeBg": "{brand.soft}",
                    "guideColor": "#fff",
                    "guideWidth": 1
                }
            }
        });
        let (normalized, warnings) = validate(&skin).expect("旧皮肤应能导入");
        assert_eq!(normalized["components"]["lyrics"]["fontSize"], json!(17));
        let lyrics = &normalized["components"]["lyrics"];
        assert!(lyrics.get("activeFontSize").is_none(), "{lyrics}");
        assert!(lyrics.get("activeBg").is_none(), "{lyrics}");
        assert!(lyrics.get("guideColor").is_none(), "{lyrics}");
        assert!(lyrics.get("guideWidth").is_none(), "{lyrics}");
        assert!(
            warnings.iter().any(|warning| warning.contains("activeFontSize")),
            "{warnings:?}"
        );
    }

    #[test]
    fn unknown_tokens_are_listed_not_ignored() {
        let skin = json!({
            "id": "demo-skin",
            "name": "演示",
            "palette": {"brand": "#fff", "nope": "#000"},
            "components": {"sidebar": {"widht": 10}, "nope": {"x": 1}},
        });
        let error = validate(&skin).unwrap_err();
        assert_eq!(error.code, ErrorCode::SkinTokenRejected);
        let rejected: Vec<String> = error.details.as_ref().unwrap()["rejected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        // 被拒键名必须**全部列出**（拼错的键名是最常见的皮肤 bug）
        assert!(rejected.contains(&"palette.nope".to_string()), "{rejected:?}");
        assert!(rejected.contains(&"components.sidebar.widht".to_string()), "{rejected:?}");
        assert!(rejected.contains(&"components.nope".to_string()), "{rejected:?}");
    }

    #[test]
    fn structure_and_value_types_are_checked() {
        // 顶层不是对象
        assert_eq!(validate(&json!([])).unwrap_err().code, ErrorCode::SkinInvalidDocument);
        // id 会当文件名用：路径分隔符必须拒绝
        for id in ["../evil", "a/b", "a\\b", "A-big", "x"] {
            let skin = json!({"id": id, "name": "x"});
            assert_eq!(validate(&skin).unwrap_err().code, ErrorCode::SkinInvalidDocument, "id={id}");
        }
        // 缺 name
        assert_eq!(
            validate(&json!({"id": "ok-skin"})).unwrap_err().code,
            ErrorCode::SkinInvalidDocument
        );
        // 未知令牌组
        let skin = json!({"id": "ok-skin", "name": "x", "colors": {"brand": "#fff"}});
        let error = validate(&skin).unwrap_err();
        assert!(error.details.unwrap()["unknown"].as_array().unwrap().contains(&json!("colors")));
        // 值类型不对（radius.md 是字符串）
        let skin = json!({"id": "ok-skin", "name": "x", "radius": {"md": 8}});
        let error = validate(&skin).unwrap_err();
        assert_eq!(error.code, ErrorCode::SkinInvalidDocument);
        assert!(error.message.contains("radius.md"), "{}", error.message);
        // swatches 形状
        let skin = json!({"id": "ok-skin", "name": "x", "swatches": "red"});
        assert_eq!(validate(&skin).unwrap_err().code, ErrorCode::SkinInvalidDocument);
    }

    #[test]
    fn user_skins_cannot_claim_builtin() {
        let skin = json!({"id": "ok-skin", "name": "x", "builtin": true});
        let (normalized, warnings) = validate(&skin).unwrap();
        assert_eq!(normalized["builtin"], json!(false));
        assert!(warnings.iter().any(|warning| warning.contains("builtin")), "{warnings:?}");
    }
}
