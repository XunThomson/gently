//! 订阅与社区仓库（M1c）的集成测试。
//!
//! 全部走 mock 传输层（不发真实请求），重点是把索引当作**不可信输入**对待：
//! 路径穿越、私网地址、校验和不符、刷新失败保留旧索引。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::ErrorCode;
use gently_core::plugin::{sha256_hex, HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

#[derive(Default)]
struct MockTransport {
    responses: Mutex<HashMap<String, String>>,
    fail: Mutex<bool>,
}

impl MockTransport {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn serve(&self, url: &str, body: &str) {
        self.responses.lock().unwrap().insert(url.to_string(), body.to_string());
    }

    fn fail_all(&self, fail: bool) {
        *self.fail.lock().unwrap() = fail;
    }
}

impl HttpTransport for MockTransport {
    fn send(&self, request: &HttpRequest) -> gently_core::contract::Fallible<HttpResponse> {
        if *self.fail.lock().unwrap() {
            return Err(gently_core::CoreError::new(
                ErrorCode::SourceUpstreamFailed,
                "mock：网络不可用",
            ));
        }
        match self.responses.lock().unwrap().get(&request.url) {
            Some(body) => Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: body.clone(),
                truncated: false,
            }),
            None => Err(gently_core::CoreError::new(
                ErrorCode::NotFound,
                format!("mock：未预设 {}", request.url),
            )),
        }
    }
}

const INDEX_URL: &str = "https://example.com/index/repository.json";
const PLUGIN_URL: &str = "https://example.com/plugins/demo.js";
const PLUGIN_SOURCE: &str = r#"
// @id demo-source
// @name 示例音源
// @version 1.0.0
// @author someone
// @hosts api.example.com
async function search(keyword) { return []; }
async function getMediaSource(track, quality) { return null; }
"#;

fn index_json(sha256: Option<&str>, file_name: &str, download_url: &str) -> String {
    let sha = match sha256 {
        Some(value) => format!(r#","sha256":"{value}""#),
        None => String::new(),
    };
    format!(
        r#"{{"name":"示例社区仓库","version":"1.0.0","updatedAt":"2026-10-07T00:00:00Z",
            "url":"https://example.com/index",
            "sources":[{{"name":"示例音源","fileName":"{file_name}","downloadUrl":"{download_url}",
            "version":"1.0.0","author":"someone","tags":["示例"],"enabled":true,"fileSize":200{sha}}}]}}"#
    )
}

fn ctx_with(transport: Arc<MockTransport>) -> (CoreContext, std::path::PathBuf) {
    let dir = common::temp_dir("sub");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths).with_store(store).with_http(transport);
    (ctx, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn add_subscription(ctx: &CoreContext) -> Value {
    call(ctx, "plugin.subscriptions.add", json!({ "url": INDEX_URL }))
}

#[test]
fn add_refresh_and_list_catalog_entries() {
    let transport = MockTransport::new();
    let good_sha = sha256_hex(PLUGIN_SOURCE.as_bytes());
    transport.serve(INDEX_URL, &index_json(Some(&good_sha), "demo.js", PLUGIN_URL));
    let (ctx, dir) = ctx_with(transport);

    let added = add_subscription(&ctx);
    assert_eq!(added["ok"], json!(true), "{added}");
    assert_eq!(added["data"]["count"], json!(1), "添加时应立即刷新一次索引");
    assert_eq!(added["data"]["error"], json!(null));

    // 缓存落盘：断网也能列出条目
    let cache = ctx.paths.subscriptions.join(format!("{}.json", added["data"]["id"].as_str().unwrap()));
    assert!(cache.is_file(), "索引应写入缓存：{}", cache.display());

    let list = call(&ctx, "plugin.catalog.list", json!({}));
    let entries = list["data"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["fileName"], json!("demo.js"));
    assert_eq!(entries[0]["installed"], json!(false));
    assert_eq!(entries[0]["updateAvailable"], json!(false));
    assert_eq!(entries[0]["subscriptionName"], json!("示例社区仓库"));

    // 按标签/关键词过滤
    let filtered = call(&ctx, "plugin.catalog.list", json!({ "query": "不存在的关键词" }));
    assert_eq!(filtered["data"].as_array().unwrap().len(), 0);
    let by_tag = call(&ctx, "plugin.catalog.list", json!({ "tags": ["示例"] }));
    assert_eq!(by_tag["data"].as_array().unwrap().len(), 1);

    // 移除订阅同时清缓存
    let removed = call(&ctx, "plugin.subscriptions.remove", json!({ "id": added["data"]["id"] }));
    assert_eq!(removed["ok"], json!(true));
    assert!(!cache.exists(), "移除订阅应清掉索引缓存");
    assert_eq!(call(&ctx, "plugin.subscriptions.list", json!({}))["data"], json!([]));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn refresh_failure_keeps_previous_index_and_records_error() {
    let transport = MockTransport::new();
    let sha = sha256_hex(PLUGIN_SOURCE.as_bytes());
    transport.serve(INDEX_URL, &index_json(Some(&sha), "demo.js", PLUGIN_URL));
    let (ctx, dir) = ctx_with(transport.clone());

    let added = add_subscription(&ctx);
    let id = added["data"]["id"].as_str().unwrap().to_string();

    // 断网后再刷新：必须报 subscription.fetch_failed，且旧索引仍然可用
    transport.fail_all(true);
    let failed = call(&ctx, "plugin.subscriptions.refresh", json!({ "id": id }));
    assert_eq!(failed["error"]["code"], ErrorCode::SubscriptionFetchFailed.as_str(), "{failed}");

    let subscriptions = call(&ctx, "plugin.subscriptions.list", json!({}));
    let record = &subscriptions["data"][0];
    assert_eq!(record["count"], json!(1), "旧索引条目数应保留");
    assert!(record["error"].as_str().unwrap().contains("网络不可用"), "{record}");

    // 条目列表仍能列出（用户可继续安装已缓存索引里的插件）
    assert_eq!(call(&ctx, "plugin.catalog.list", json!({}))["data"].as_array().unwrap().len(), 1);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn catalog_install_verifies_sha256_and_records_origin() {
    let transport = MockTransport::new();
    let sha = sha256_hex(PLUGIN_SOURCE.as_bytes());
    transport.serve(INDEX_URL, &index_json(Some(&sha), "demo.js", PLUGIN_URL));
    transport.serve(PLUGIN_URL, PLUGIN_SOURCE);
    let (ctx, dir) = ctx_with(transport);
    let added = add_subscription(&ctx);
    let id = added["data"]["id"].as_str().unwrap().to_string();

    // 校验和不符 → 拒绝安装
    let transport_bad = MockTransport::new();
    transport_bad.serve(INDEX_URL, &index_json(Some(&"0".repeat(64)), "demo.js", PLUGIN_URL));
    transport_bad.serve(PLUGIN_URL, PLUGIN_SOURCE);
    let (ctx_bad, dir_bad) = ctx_with(transport_bad);
    let bad_id = add_subscription(&ctx_bad)["data"]["id"].as_str().unwrap().to_string();
    let rejected = call(
        &ctx_bad,
        "plugin.import",
        json!({ "from": { "kind": "catalog", "subscriptionId": bad_id, "fileName": "demo.js" }, "consent": true }),
    );
    assert_eq!(rejected["error"]["code"], ErrorCode::PluginImportFailed.as_str(), "{rejected}");
    assert!(rejected["error"]["details"]["actual"].is_string(), "应给出实际校验和");

    // 正常安装：来源记为 catalog（含 subscriptionId 与 fileName）
    let installed = call(
        &ctx,
        "plugin.import",
        json!({ "from": { "kind": "catalog", "subscriptionId": id, "fileName": "demo.js" }, "consent": true }),
    );
    assert_eq!(installed["ok"], json!(true), "{installed}");
    let summary = &installed["data"]["plugin"];
    assert_eq!(summary["origin"]["kind"], json!("catalog"));
    assert_eq!(summary["origin"]["subscriptionId"], json!(id));
    assert_eq!(summary["origin"]["fileName"], json!("demo.js"));
    assert_eq!(summary["sha256"], json!(sha));

    // 再次列出条目：应标记为已安装
    let entries = call(&ctx, "plugin.catalog.list", json!({}));
    assert_eq!(entries["data"][0]["installed"], json!(true));
    assert_eq!(entries["data"][0]["updateAvailable"], json!(false));

    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&dir_bad).ok();
}

#[test]
fn index_with_path_traversal_is_rejected_at_refresh() {
    let transport = MockTransport::new();
    transport.serve(
        INDEX_URL,
        &index_json(None, "../../evil.js", "https://example.com/plugins/evil.js"),
    );
    let (ctx, dir) = ctx_with(transport);

    let added = add_subscription(&ctx);
    // 添加本身成功（订阅登记了），但索引被拒 → 条目数为 0 且带错误
    assert_eq!(added["ok"], json!(true));
    assert_eq!(added["data"]["count"], json!(0));
    assert!(added["data"]["error"].as_str().unwrap().contains("fileName"), "{added}");
    assert_eq!(call(&ctx, "plugin.catalog.list", json!({}))["data"], json!([]));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn subscription_url_must_be_https_and_public() {
    let transport = MockTransport::new();
    let (ctx, dir) = ctx_with(transport);

    for url in [
        "http://example.com/index.json",
        "https://127.0.0.1/index.json",
        "https://192.168.1.5/index.json",
        "https://localhost/index.json",
    ] {
        let value = call(&ctx, "plugin.subscriptions.add", json!({ "url": url }));
        assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{url}: {value}");
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn url_import_downloads_parses_and_records_origin() {
    let transport = MockTransport::new();
    transport.serve(PLUGIN_URL, PLUGIN_SOURCE);
    let (ctx, dir) = ctx_with(transport);

    // 预览：下载但不落盘
    let preview = call(&ctx, "plugin.preview", json!({ "from": { "kind": "url", "url": PLUGIN_URL } }));
    assert_eq!(preview["ok"], json!(true), "{preview}");
    assert_eq!(preview["data"]["manifest"]["id"], json!("demo-source"));
    assert!(!ctx.paths.plugins.join("demo-source").exists(), "预览不应落盘");

    // 安装：来源记为 url
    let installed = call(
        &ctx,
        "plugin.import",
        json!({ "from": { "kind": "url", "url": PLUGIN_URL }, "consent": true }),
    );
    assert_eq!(installed["ok"], json!(true), "{installed}");
    assert_eq!(installed["data"]["plugin"]["origin"]["kind"], json!("url"));
    assert_eq!(installed["data"]["plugin"]["origin"]["url"], json!(PLUGIN_URL));
    assert!(ctx.paths.plugins.join("demo-source").join("plugin.js").is_file());

    // 非 HTTPS / 内网地址：核心主动下载前就拒绝（防 SSRF）
    for url in ["http://example.com/a.js", "https://127.0.0.1/a.js", "https://192.168.0.9/a.js"] {
        let value = call(&ctx, "plugin.preview", json!({ "from": { "kind": "url", "url": url } }));
        assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{url}: {value}");
    }

    std::fs::remove_dir_all(&dir).ok();
}