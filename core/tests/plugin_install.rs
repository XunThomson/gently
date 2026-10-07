//! 插件安装/卸载/状态 的集成测试。
//!
//! 重点验证三件事：
//! 1. **同意是硬门槛**——没有 `consent: true` 不得写任何字节；
//! 2. **失败不留半成品**——暂存目录必须被清理，覆盖安装不能把旧版本弄丢；
//! 3. **文件与库一致**——卸载删库同时删文件，只删库时不误删文件。

use gently_core::commands::dispatch;
use gently_core::contract::ErrorCode;
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

const V1: &str = r#"
// @id demo-source
// @name 示例音源
// @version 1.0.0
// @author someone
// @qualities high,standard
// @hosts api.example.com
async function search(keyword, page) { return []; }
async function getMediaSource(track, quality) { return null; }
"#;

/// 同 id 的新版本（用于验证覆盖安装）
fn v2() -> String {
    V1.replace("@version 1.0.0", "@version 2.0.0")
}

fn temp_ctx(tag: &str) -> (CoreContext, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "gently-install-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");
    let store = Store::open(&paths.db).expect("打开库");
    (CoreContext::new(paths).with_store(store), dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn import_paste(ctx: &CoreContext, content: &str, consent: bool) -> Value {
    call(ctx, "plugin.import", json!({ "from": { "kind": "paste", "content": content }, "consent": consent }))
}

fn listed_ids(ctx: &CoreContext) -> Vec<String> {
    let value = call(ctx, "plugin.list", json!({}));
    value["data"]
        .as_array()
        .expect("list 应返回数组")
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn import_requires_explicit_consent() {
    let (ctx, dir) = temp_ctx("consent");

    for params in [
        json!({ "from": { "kind": "paste", "content": V1 } }),
        json!({ "from": { "kind": "paste", "content": V1 }, "consent": false }),
    ] {
        let value = call(&ctx, "plugin.import", params);
        assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");
        assert!(value["error"]["message"].as_str().unwrap().contains("同意"));
    }

    // 关键：未同意时磁盘与数据库都不得留下痕迹
    assert!(listed_ids(&ctx).is_empty());
    let entries: Vec<_> = std::fs::read_dir(&ctx.paths.plugins)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .collect();
    assert!(entries.is_empty(), "未同意时不应写入插件目录");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn paste_import_lands_on_disk_and_in_db() {
    let (ctx, dir) = temp_ctx("paste");

    let value = import_paste(&ctx, V1, true);
    assert_eq!(value["ok"], json!(true), "{value}");
    let summary = &value["data"]["plugin"];
    assert_eq!(summary["id"], json!("demo-source"));
    assert_eq!(summary["enabled"], json!(true));
    assert_eq!(summary["priority"], json!(100));
    assert_eq!(summary["builtin"], json!(false), "我们不内置任何插件（ADR-0005）");
    assert_eq!(summary["origin"]["kind"], json!("paste"));
    // 校验和用于「更新前后是否变化」的比对
    assert_eq!(summary["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(value["data"]["replaced"], json!(false));

    // 落盘：单文件形态归一化成 plugins/<id>/plugin.js
    let entry = ctx.paths.plugins.join("demo-source").join("plugin.js");
    assert!(entry.is_file(), "入口文件应存在：{}", entry.display());
    assert_eq!(std::fs::read_to_string(&entry).unwrap(), V1);

    assert_eq!(listed_ids(&ctx), vec!["demo-source"]);

    // 暂存与回收目录必须清理干净
    assert!(!ctx.paths.plugins.join(".staging").exists());
    assert!(!ctx.paths.plugins.join(".trash").exists());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn file_and_dir_sources_record_their_origin() {
    let (ctx, dir) = temp_ctx("origins");

    let file = ctx.paths.data.join("incoming.js");
    std::fs::write(&file, V1).unwrap();
    let value = call(
        &ctx,
        "plugin.import",
        json!({ "from": { "kind": "file", "path": file.to_string_lossy() }, "consent": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["plugin"]["origin"]["kind"], json!("file"));
    assert!(value["data"]["plugin"]["origin"]["path"].as_str().unwrap().ends_with("incoming.js"));

    // 目录包：plugin.json + entry，且 entry 必须真实存在
    let pkg = ctx.paths.data.join("pkg-dir");
    std::fs::create_dir_all(pkg.join("assets")).unwrap();
    std::fs::write(
        pkg.join("plugin.json"),
        r#"{"id":"dir-source","name":"目录包","version":"0.3.0","author":"someone","entry":"main.js","qualities":["lossless"],"hosts":["api.example.com"]}"#,
    )
    .unwrap();
    std::fs::write(pkg.join("main.js"), "async function search(k){return [];}\n").unwrap();
    std::fs::write(pkg.join("assets").join("logo.txt"), "x").unwrap();

    let value = call(
        &ctx,
        "plugin.import",
        json!({ "from": { "kind": "dir", "path": pkg.to_string_lossy() }, "consent": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["plugin"]["id"], json!("dir-source"));
    assert_eq!(value["data"]["plugin"]["origin"]["kind"], json!("dir"));
    // 多文件资产一并带过来
    assert!(ctx.paths.plugins.join("dir-source").join("assets").join("logo.txt").is_file());
    assert!(ctx.paths.plugins.join("dir-source").join("main.js").is_file());

    // 声明了 entry 但文件缺失 → 明确报清单非法
    let broken = ctx.paths.data.join("pkg-broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(
        broken.join("plugin.json"),
        r#"{"id":"broken","name":"缺入口","version":"1.0.0","author":"someone","entry":"missing.js"}"#,
    )
    .unwrap();
    let value = call(
        &ctx,
        "plugin.import",
        json!({ "from": { "kind": "dir", "path": broken.to_string_lossy() }, "consent": true }),
    );
    assert_eq!(value["error"]["code"], ErrorCode::PluginInvalidManifest.as_str(), "{value}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn reinstall_replaces_previous_version() {
    let (ctx, dir) = temp_ctx("replace");

    assert_eq!(import_paste(&ctx, V1, true)["data"]["replaced"], json!(false));
    let value = import_paste(&ctx, &v2(), true);

    assert_eq!(value["data"]["replaced"], json!(true), "{value}");
    assert_eq!(value["data"]["plugin"]["version"], json!("2.0.0"));

    // 库里只有一条，且版本已更新
    assert_eq!(listed_ids(&ctx), vec!["demo-source"]);
    let list = call(&ctx, "plugin.list", json!({}));
    assert_eq!(list["data"][0]["version"], json!("2.0.0"));
    // 磁盘上是新内容
    let entry = ctx.paths.plugins.join("demo-source").join("plugin.js");
    assert!(std::fs::read_to_string(&entry).unwrap().contains("2.0.0"));
    assert!(!ctx.paths.plugins.join(".trash").exists(), "替换后不应残留旧版本");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn enable_and_priority_are_persisted_and_ordered() {
    let (ctx, dir) = temp_ctx("order");

    import_paste(&ctx, V1, true);
    let second = V1.replace("demo-source", "other-source");
    import_paste(&ctx, &second, true);

    // 默认同优先级 → 按名称排序
    assert_eq!(listed_ids(&ctx), vec!["demo-source", "other-source"]);

    let value = call(&ctx, "plugin.setPriority", json!({ "id": "other-source", "priority": 10 }));
    assert_eq!(value["ok"], json!(true));
    assert_eq!(listed_ids(&ctx), vec!["other-source", "demo-source"], "数值小的排前面");

    let value = call(&ctx, "plugin.setEnabled", json!({ "id": "other-source", "enabled": false }));
    assert_eq!(value["data"]["enabled"], json!(false));

    // 越界优先级、未知 id 都要明确失败
    let bad = call(&ctx, "plugin.setPriority", json!({ "id": "other-source", "priority": -1 }));
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str());
    let missing = call(&ctx, "plugin.setEnabled", json!({ "id": "nope", "enabled": true }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn remove_deletes_db_row_and_files_by_default() {
    let (ctx, dir) = temp_ctx("remove");

    import_paste(&ctx, V1, true);
    let value = call(&ctx, "plugin.remove", json!({ "id": "demo-source" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert!(listed_ids(&ctx).is_empty());
    assert!(!ctx.paths.plugins.join("demo-source").exists(), "默认应连文件一起删");

    // 再删一次 → 明确报不存在
    let again = call(&ctx, "plugin.remove", json!({ "id": "demo-source" }));
    assert_eq!(again["error"]["code"], ErrorCode::NotFound.as_str());

    // deleteFiles:false 时保留文件（用户可能只是暂时移除）
    import_paste(&ctx, V1, true);
    let value = call(&ctx, "plugin.remove", json!({ "id": "demo-source", "deleteFiles": false }));
    assert_eq!(value["ok"], json!(true));
    assert!(ctx.paths.plugins.join("demo-source").join("plugin.js").is_file());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn reload_detects_capabilities_from_the_runtime_not_the_static_scan() {
    let (ctx, dir) = temp_ctx("reload");

    // 用箭头函数声明：安装期的静态预扫描（找 `function <name>(`）看不到它
    let source = r#"
// @id arrow-source
// @name 箭头函数写法
// @version 1.0.0
// @author someone
const search = async (keyword) => [{id: 'arrow-source:1', title: keyword}];
const getLyric = async (id) => ({format: 'plain', content: '…'});
"#;
    let installed = import_paste(&ctx, source, true);
    assert_eq!(installed["data"]["plugin"]["manifest"]["capabilities"], json!([]), "静态扫描应看不到箭头函数");

    let reloaded = call(&ctx, "plugin.reload", json!({ "id": "arrow-source" }));
    assert_eq!(reloaded["ok"], json!(true), "{reloaded}");
    let capabilities = reloaded["data"]["manifest"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("search")), "{capabilities:?}");
    assert!(capabilities.contains(&json!("getLyric")), "{capabilities:?}");

    // 探测结果写回清单快照：重新 list 也能看到
    let list = call(&ctx, "plugin.list", json!({}));
    let capabilities = list["data"][0]["manifest"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("search")), "{capabilities:?}");

    // 未安装的 id → 明确报不存在
    let missing = call(&ctx, "plugin.reload", json!({ "id": "nope" }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn degraded_database_blocks_install_instead_of_pretending() {
    let dir = std::env::temp_dir().join(format!("gently-install-nodb-{}", std::process::id()));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    // 模拟降级启动：没有库
    let ctx = CoreContext::new(paths).with_store_error("测试：故意不打开数据库");

    let value = import_paste(&ctx, V1, true);
    assert_eq!(value["error"]["code"], ErrorCode::LibraryIoError.as_str(), "{value}");
    assert_eq!(call(&ctx, "plugin.list", json!({}))["error"]["code"], json!("library.io_error"));

    std::fs::remove_dir_all(&dir).ok();
}
