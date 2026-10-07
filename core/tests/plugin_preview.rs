//! `plugin.preview` 的集成测试：安装链路的第一步必须**只看不写、不执行代码**。

use gently_core::commands::{dispatch, implemented_count, is_implemented};
use gently_core::contract::ErrorCode;
use gently_core::{AppPaths, CoreContext};
use serde_json::json;

const SOURCE: &str = r#"
// @id demo-source
// @name 示例音源
// @version 1.0.0
// @author someone
// @description 仅用于测试的模拟插件
// @tags 示例,测试
// @qualities high,standard
// @hosts api.example.com
// @credentials apiKey:API Key:required
async function search(keyword, page) { return []; }
async function getMediaSource(track, quality) { return null; }
"#;

fn ctx() -> CoreContext {
    let dir = std::env::temp_dir().join(format!(
        "gently-preview-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    let paths = AppPaths::resolve(dir);
    paths.ensure().expect("建目录");
    CoreContext::new(paths)
}

fn preview(ctx: &CoreContext, from: serde_json::Value) -> serde_json::Value {
    serde_json::to_value(dispatch(ctx, "plugin.preview", json!({ "from": from }))).unwrap()
}

#[test]
fn paste_source_reports_manifest_permissions_and_credentials() {
    let ctx = ctx();
    let value = preview(&ctx, json!({ "kind": "paste", "content": SOURCE }));

    assert_eq!(value["ok"], json!(true), "{value}");
    let data = &value["data"];
    assert_eq!(data["manifest"]["id"], json!("demo-source"));
    assert_eq!(data["manifest"]["qualities"], json!(["high", "standard"]));
    assert_eq!(data["manifest"]["hosts"], json!(["api.example.com"]));
    assert_eq!(data["manifest"]["tags"], json!(["示例", "测试"]));
    // 声明的 hosts/credentials 必须同时体现在 permissions 上（同意界面据此展示）
    assert_eq!(data["permissions"], json!(["network", "credentials"]));
    assert_eq!(data["credentials"][0]["key"], json!("apiKey"));
    assert_eq!(data["credentials"][0]["required"], json!(true));
    assert_eq!(data["replacesExisting"], json!(false));
    // 能力预扫描结果：预览阶段就能看出这插件能不能搜、能不能取流
    let capabilities = data["manifest"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("search")));
    assert!(capabilities.contains(&json!("getMediaSource")));
}

#[test]
fn preview_never_writes_anything() {
    let ctx = ctx();
    let value = preview(&ctx, json!({ "kind": "paste", "content": SOURCE }));
    assert_eq!(value["ok"], json!(true));

    // 关键约束：preview 只读。插件目录必须仍然为空（落盘发生在 import + 用户同意之后）
    let entries: Vec<_> = std::fs::read_dir(&ctx.paths.plugins).unwrap().collect();
    assert!(entries.is_empty(), "preview 不应写入任何文件");
}

#[test]
fn file_source_is_read_from_disk() {
    let ctx = ctx();
    let path = ctx.paths.data.join("incoming.js");
    std::fs::write(&path, SOURCE).unwrap();

    let value = preview(&ctx, json!({ "kind": "file", "path": path.to_string_lossy() }));
    assert_eq!(value["data"]["manifest"]["id"], json!("demo-source"), "{value}");

    // 不存在的文件 → IO 错误码（library.io_error 是本地读写统一码）
    let missing = preview(&ctx, json!({ "kind": "file", "path": ctx.paths.data.join("nope.js").to_string_lossy() }));
    assert_eq!(missing["error"]["code"], json!("library.io_error"));
}

#[test]
fn dir_source_reads_plugin_json_and_scans_entry() {
    let ctx = ctx();
    let dir = ctx.paths.plugins.join("dir-source");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("plugin.json"),
        r#"{"id":"dir-source","name":"目录包","version":"1.0.0","author":"someone","entry":"main.js","qualities":["lossless"]}"#,
    )
    .unwrap();
    std::fs::write(dir.join("main.js"), "async function search(k) { return []; }\n").unwrap();

    let value = preview(&ctx, json!({ "kind": "dir", "path": dir.to_string_lossy() }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["manifest"]["entry"], json!("main.js"));
    assert_eq!(value["data"]["manifest"]["qualities"], json!(["lossless"]));
    assert_eq!(value["data"]["manifest"]["capabilities"], json!(["search"]));

    // 同 id 目录已存在 → 覆盖提示（同意界面要明确告诉用户会替换）
    assert_eq!(value["data"]["replacesExisting"], json!(true));

    let no_manifest = ctx.paths.plugins.join("empty-dir");
    std::fs::create_dir_all(&no_manifest).unwrap();
    let err = preview(&ctx, json!({ "kind": "dir", "path": no_manifest.to_string_lossy() }));
    assert_eq!(err["error"]["code"], json!("plugin.invalid_manifest"));
}

#[test]
fn invalid_source_returns_details_for_the_ui() {
    let ctx = ctx();
    let value = preview(&ctx, json!({ "kind": "paste", "content": "// @name 缺少 id 与版本\n" }));
    assert_eq!(value["error"]["code"], ErrorCode::PluginInvalidSource.as_str(), "{value}");
    let missing = value["error"]["details"]["missing"].as_array().unwrap();
    assert!(missing.contains(&json!("id")));
    assert!(missing.contains(&json!("version")));
}

#[test]
fn unimplemented_sources_say_so_explicitly() {
    let ctx = ctx();
    for from in [
        json!({ "kind": "url", "url": "https://example.com/plugin.js" }),
        json!({ "kind": "archive", "path": "C:/tmp/plugin.zip" }),
        json!({ "kind": "catalog", "subscriptionId": "sub-1", "fileName": "a.js" }),
    ] {
        let value = preview(&ctx, from.clone());
        assert_eq!(
            value["error"]["code"],
            ErrorCode::NotImplemented.as_str(),
            "{from} 应明确报未实现而不是静默失败：{value}"
        );
    }
}

#[test]
fn too_large_paste_is_rejected() {
    let ctx = ctx();
    let huge = "a".repeat((gently_core::plugin::MAX_SOURCE_BYTES + 1) as usize);
    let value = preview(&ctx, json!({ "kind": "paste", "content": huge }));
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str());
    assert!(value["error"]["details"]["limit"].is_number());
}

#[test]
fn preview_is_registered_as_implemented() {
    assert!(is_implemented("plugin.preview"));
    assert_eq!(implemented_count(), 10);
}
