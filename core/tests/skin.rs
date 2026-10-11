//! 皮肤域的集成测试（M4b）：预览 / 安装 / 列表 / 激活 / 导出 / 卸载。
//!
//! 校验逻辑本身在 `core/src/skin.rs` 的单测里覆盖；这里盯**链路**：
//! 1. 白名单来自主题配置（`include_str!`），未知键名整份拒绝并列出；
//! 2. 预览**不落盘**；安装按 id 覆盖；列表带 `active` 标记；
//! 3. 激活/取消激活（`null` 回默认主题）；删掉激活中的皮肤要顺手清标记；
//! 4. 导出：`json` 返回文本、`file` 写到 `<data>/skins/<id>.json`；
//! 5. 未实现的来源与非法来源给明确错误。

use std::sync::Arc;

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

struct Offline;

impl HttpTransport for Offline {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-skin-{tag}"))
}

fn setup(tag: &str) -> (CoreContext, std::path::PathBuf) {
    let dir = temp_dir(tag);
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths).with_store(store).with_http(Arc::new(Offline));
    (ctx, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

/// 一份合法皮肤（只覆盖真实存在的令牌）。
const SKIN: &str = r##"{
    "id": "demo-skin",
    "name": "演示皮肤",
    "description": "测试用",
    "author": "tester",
    "version": "1.0.0",
    "tags": ["配色"],
    "swatches": ["#111111", "#eeeeee"],
    "palette": {"brand": "#ff5500"},
    "scheme": {"dark": {"app": "#101010"}},
    "radius": {"md": "2px"},
    "components": {"sidebar": {"width": 220}}
}"##;

fn preview(ctx: &CoreContext, content: &str) -> Value {
    call(ctx, "skin.preview", json!({ "from": { "kind": "paste", "content": content } }))
}

fn install(ctx: &CoreContext, content: &str) -> Value {
    call(ctx, "skin.install", json!({ "from": { "kind": "paste", "content": content } }))
}

#[test]
fn preview_validates_without_writing_and_rejects_unknown_tokens() {
    let (ctx, dir) = setup("preview");

    let value = preview(&ctx, SKIN);
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["skin"]["id"], json!("demo-skin"));
    assert_eq!(value["data"]["skin"]["builtin"], json!(false));
    assert_eq!(value["data"]["skin"]["palette"]["brand"], json!("#ff5500"));
    // 预览只读：库与目录都不该有东西
    assert_eq!(call(&ctx, "skin.list", json!({}))["data"], json!([]));

    // 未知令牌键名 → 整份拒绝并列出（不是静默忽略）
    let bad = SKIN.replace(r##""brand": "#ff5500""##, r##""brand": "#ff5500", "nope": "#000""##);
    let value = preview(&ctx, &bad);
    assert_eq!(value["error"]["code"], ErrorCode::SkinTokenRejected.as_str(), "{value}");
    let rejected = value["error"]["details"]["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0], json!("palette.nope"));

    // 结构错误 → skin.invalid_document
    let value = preview(&ctx, "{不是 JSON");
    assert_eq!(value["error"]["code"], ErrorCode::SkinInvalidDocument.as_str(), "{value}");
    let value = preview(&ctx, r#"{"id": "x", "name": "x"}"#);
    assert_eq!(value["error"]["code"], ErrorCode::SkinInvalidDocument.as_str(), "id 太短：{value}");

    // 文件来源同样可用
    let file = dir.join("skin.json");
    std::fs::write(&file, SKIN).unwrap();
    let value = call(&ctx, "skin.preview", json!({ "from": { "kind": "file", "path": file.to_string_lossy() } }));
    assert_eq!(value["ok"], json!(true), "{value}");
    // 目录包 / 压缩包来源尚未实现（要说清支持哪些）
    let value = call(&ctx, "skin.preview", json!({ "from": { "kind": "archive", "path": "x.zip" } }));
    assert_eq!(value["error"]["code"], ErrorCode::NotImplemented.as_str(), "{value}");
    assert_eq!(value["error"]["details"]["supported"], json!(["paste", "file", "url"]));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn install_replaces_by_id_and_lists_with_active_flag() {
    let (ctx, dir) = setup("install");

    let installed = install(&ctx, SKIN);
    assert_eq!(installed["ok"], json!(true), "{installed}");
    assert_eq!(installed["data"]["name"], json!("演示皮肤"));

    // 同 id 再装一次（改了名字）→ 覆盖而不是新增
    let renamed = SKIN.replace("演示皮肤", "演示皮肤 v2");
    assert_eq!(install(&ctx, &renamed)["ok"], json!(true));
    let listed = call(&ctx, "skin.list", json!({}));
    let items = listed["data"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{listed}");
    assert_eq!(items[0]["name"], json!("演示皮肤 v2"));
    assert_eq!(items[0]["active"], json!(false), "没激活过就不该是 active");

    // 另一份皮肤
    let second = SKIN.replace("demo-skin", "second-skin").replace("演示皮肤 v2", "第二皮肤");
    assert_eq!(install(&ctx, &second)["ok"], json!(true));
    assert_eq!(call(&ctx, "skin.list", json!({}))["data"].as_array().unwrap().len(), 2);

    // 激活 / 切换 / 回默认
    assert_eq!(call(&ctx, "skin.setActive", json!({ "id": "demo-skin" }))["ok"], json!(true));
    let items = call(&ctx, "skin.list", json!({}))["data"].clone();
    let active: Vec<&str> = items
        .as_array()
        .unwrap()
        .iter()
        .filter(|skin| skin["active"] == json!(true))
        .map(|skin| skin["id"].as_str().unwrap())
        .collect();
    assert_eq!(active, vec!["demo-skin"]);

    assert_eq!(call(&ctx, "skin.setActive", json!({ "id": "second-skin" }))["ok"], json!(true));
    assert_eq!(call(&ctx, "skin.setActive", json!({ "id": null }))["ok"], json!(true));
    assert!(call(&ctx, "skin.list", json!({}))["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|skin| skin["active"] == json!(false)));

    // 激活不存在的皮肤 → not_found
    let value = call(&ctx, "skin.setActive", json!({ "id": "nope" }));
    assert_eq!(value["error"]["code"], ErrorCode::NotFound.as_str(), "{value}");

    // 删除激活中的皮肤：标记必须一起清掉（否则每次启动都找不到主题）
    assert_eq!(call(&ctx, "skin.setActive", json!({ "id": "demo-skin" }))["ok"], json!(true));
    assert_eq!(call(&ctx, "skin.remove", json!({ "id": "demo-skin" }))["ok"], json!(true));
    let store = ctx.store.as_ref().unwrap();
    assert_eq!(store.active_skin().unwrap(), None, "删掉激活皮肤后应回到默认主题");
    // 重复删除 → not_found
    let value = call(&ctx, "skin.remove", json!({ "id": "demo-skin" }));
    assert_eq!(value["error"]["code"], ErrorCode::NotFound.as_str(), "{value}");

    // 重启（重新打开库）后仍在
    let reopened = Store::open(&ctx.paths.db).unwrap();
    assert_eq!(reopened.list_skins().unwrap().len(), 1);
    assert!(reopened.get_skin("second-skin").unwrap().is_some());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn export_returns_json_or_writes_a_file() {
    let (ctx, dir) = setup("export");
    install(&ctx, SKIN);

    let as_json = call(&ctx, "skin.export", json!({ "id": "demo-skin" }));
    assert_eq!(as_json["ok"], json!(true), "{as_json}");
    let text = as_json["data"]["json"].as_str().unwrap();
    // 导出的就是可以再导入回去的原文
    let reparsed: Value = serde_json::from_str(text).unwrap();
    assert_eq!(reparsed["id"], json!("demo-skin"));
    assert!(text.contains('\n'), "导出用 pretty 格式，便于人读与分享");

    let as_file = call(&ctx, "skin.export", json!({ "id": "demo-skin", "format": "file" }));
    let path = as_file["data"]["path"].as_str().unwrap().to_string();
    assert!(path.ends_with("demo-skin.json"), "{path}");
    let written = std::fs::read_to_string(&path).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&written).unwrap()["name"], json!("演示皮肤"));

    // 不支持的格式 / 不存在的皮肤
    let value = call(&ctx, "skin.export", json!({ "id": "demo-skin", "format": "yaml" }));
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");
    let value = call(&ctx, "skin.export", json!({ "id": "nope" }));
    assert_eq!(value["error"]["code"], ErrorCode::NotFound.as_str(), "{value}");

    std::fs::remove_dir_all(&dir).ok();
}

/// `skin.install` 的 URL 来源沿用「公网 HTTPS + 非内网」校验（核心主动发起，防 SSRF）。
#[test]
fn url_import_rejects_plain_http_and_private_hosts() {
    let (ctx, dir) = setup("url");
    for url in ["http://example.com/skin.json", "https://127.0.0.1/skin.json"] {
        let value = call(&ctx, "skin.install", json!({ "from": { "kind": "url", "url": url } }));
        assert_eq!(value["error"]["code"], ErrorCode::MediaBlockedAddress.as_str(), "{url} → {value}");
    }
    // 数据库不可用时要明确报错（而不是假装装上）
    let paths = AppPaths::resolve(&temp_dir("no-store"));
    paths.ensure().unwrap();
    let bare = CoreContext::new(paths).with_http(Arc::new(Offline));
    let value = call(&bare, "skin.list", json!({}));
    assert_eq!(value["error"]["code"], ErrorCode::LibraryIoError.as_str(), "{value}");

    std::fs::remove_dir_all(&dir).ok();
}
