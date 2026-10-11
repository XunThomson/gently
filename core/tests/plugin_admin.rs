//! 插件管理命令的集成测试（M5 收尾）：配置 / 凭据 / 检查更新。
//!
//! 盯住五件事：
//! 1. **配置乐观并发**：revision 不匹配 → `common.conflict`，且**不改动**已存的值；
//! 2. **凭据只读写清单声明过的键**：未声明的键 → `common.invalid_argument`；
//!    `status` 只回「是否已配置」、**永不回值**（没有任何命令能把值读回来）；
//! 3. 凭据写进 store（内存实现），插件沙箱里 `credentials.get` 能读到；
//! 4. **检查更新不自动更新**：`url` 来源比对版本与 sha256；本地来源返回 `null`；
//! 5. 未安装插件一律 `common.not_found`。

use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 假传输层：按 URL 返回预设文本（检查更新用）。
struct FakeHttp {
    responses: Mutex<Vec<(String, String)>>,
}

impl FakeHttp {
    fn new(responses: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(
                responses.iter().map(|(url, body)| (url.to_string(), body.to_string())).collect(),
            ),
        })
    }
}

impl HttpTransport for FakeHttp {
    fn send(&self, request: &HttpRequest) -> Fallible<HttpResponse> {
        let responses = self.responses.lock().unwrap();
        match responses.iter().find(|(url, _)| *url == request.url) {
            Some((_, body)) => Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: body.clone(),
                truncated: false,
            }),
            None => Err(gently_core::CoreError::new(
                ErrorCode::SourceUpstreamFailed,
                format!("测试：未预设 {}", request.url),
            )),
        }
    }
}

/// 插件源（含两个凭据字段；M5 的配置/凭据命令要认清单）。
const SOURCE_V1: &str = r#"
// @id admin-source
// @name 管理源
// @version 1.0.0
// @author tester
// @hosts api.example.com
// @credentials cookie:Cookie:required
// @credentials user:账号:optional:plain
async function search() { return []; }
async function getMediaSource() { return null; }
"#;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-admin-{tag}"))
}

fn setup(tag: &str, http: Arc<dyn HttpTransport>) -> (CoreContext, std::path::PathBuf) {
    let dir = temp_dir(tag);
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths).with_store(store).with_http(http);
    (ctx, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn install(ctx: &CoreContext, source: &str) -> String {
    let value = call(
        ctx,
        "plugin.import",
        json!({ "from": { "kind": "paste", "content": source }, "consent": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    value["data"]["plugin"]["id"].as_str().unwrap().to_string()
}

#[test]
fn config_round_trips_with_optimistic_concurrency() {
    let (ctx, dir) = setup("config", FakeHttp::new(&[]));
    install(&ctx, SOURCE_V1);

    // 从未存过：空对象 + revision 0
    let value = call(&ctx, "plugin.config.get", json!({ "id": "admin-source" }));
    assert_eq!(value["data"], json!({ "values": {}, "revision": 0 }), "{value}");

    let saved = call(
        &ctx,
        "plugin.config.put",
        json!({ "id": "admin-source", "values": { "region": "cn", "auto": true }, "revision": 0 }),
    );
    assert_eq!(saved["ok"], json!(true), "{saved}");
    assert_eq!(saved["data"]["revision"], json!(1));

    let read = call(&ctx, "plugin.config.get", json!({ "id": "admin-source" }));
    assert_eq!(read["data"]["values"]["region"], json!("cn"));
    assert_eq!(read["data"]["revision"], json!(1));

    // 用旧 revision 写入 → 冲突，且**值不变**
    let conflict = call(
        &ctx,
        "plugin.config.put",
        json!({ "id": "admin-source", "values": { "region": "us" }, "revision": 0 }),
    );
    assert_eq!(conflict["error"]["code"], ErrorCode::Conflict.as_str(), "{conflict}");
    assert_eq!(conflict["error"]["details"]["current"], json!(1), "冲突要带上当前 revision");
    assert_eq!(
        call(&ctx, "plugin.config.get", json!({ "id": "admin-source" }))["data"]["values"]["region"],
        json!("cn"),
        "冲突时不能改动已存的值"
    );

    // 用正确 revision 写入 → 成功并自增
    let saved = call(
        &ctx,
        "plugin.config.put",
        json!({ "id": "admin-source", "values": { "region": "us" }, "revision": 1 }),
    );
    assert_eq!(saved["data"]["revision"], json!(2));

    // 非对象 / 超大 / 未安装
    let bad = call(
        &ctx,
        "plugin.config.put",
        json!({ "id": "admin-source", "values": [1, 2], "revision": 2 }),
    );
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad}");
    let huge = call(
        &ctx,
        "plugin.config.put",
        json!({ "id": "admin-source", "values": { "blob": "x".repeat(70_000) }, "revision": 2 }),
    );
    assert_eq!(huge["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{huge}");
    let missing = call(&ctx, "plugin.config.get", json!({ "id": "nope" }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn credentials_only_accept_declared_keys_and_never_return_values() {
    let (ctx, dir) = setup("credentials", FakeHttp::new(&[]));
    install(&ctx, SOURCE_V1);

    // 状态：两个声明字段，都还没配置（且不含任何值）
    let value = call(&ctx, "plugin.credentials.status", json!({ "id": "admin-source" }));
    let fields = value["data"].as_array().unwrap();
    assert_eq!(fields.len(), 2, "{value}");
    assert_eq!(fields[0]["key"], json!("cookie"));
    assert_eq!(fields[0]["present"], json!(false));
    assert_eq!(fields[0]["secret"], json!(true));
    assert_eq!(fields[1]["key"], json!("user"));
    assert_eq!(fields[1]["secret"], json!(false));
    assert!(value["data"].to_string().find("secret-value").is_none());

    // 写入（清单声明过的键）
    assert_eq!(
        call(
            &ctx,
            "plugin.credentials.set",
            json!({ "id": "admin-source", "key": "cookie", "value": "secret-value" })
        )["ok"],
        json!(true)
    );

    let value = call(&ctx, "plugin.credentials.status", json!({ "id": "admin-source" }));
    assert_eq!(value["data"][0]["present"], json!(true));
    // 关键：状态里**永不出现值**
    assert!(!value["data"].to_string().contains("secret-value"), "{value}");

    // 未声明的键 → 参数非法，并列出可用键
    let unknown = call(
        &ctx,
        "plugin.credentials.set",
        json!({ "id": "admin-source", "key": "token", "value": "x" }),
    );
    assert_eq!(unknown["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{unknown}");
    assert_eq!(unknown["error"]["details"]["declared"], json!(["cookie", "user"]));

    // 空值 → 参数非法（清除请用 clear）
    let empty = call(
        &ctx,
        "plugin.credentials.set",
        json!({ "id": "admin-source", "key": "cookie", "value": "   " }),
    );
    assert_eq!(empty["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{empty}");

    // 清除单个键
    assert_eq!(
        call(&ctx, "plugin.credentials.clear", json!({ "id": "admin-source", "key": "cookie" }))["ok"],
        json!(true)
    );
    assert_eq!(
        call(&ctx, "plugin.credentials.status", json!({ "id": "admin-source" }))["data"][0]["present"],
        json!(false)
    );

    // 清空全部（不明说 key）
    assert_eq!(
        call(&ctx, "plugin.credentials.set", json!({ "id": "admin-source", "key": "user", "value": "me" }))["ok"],
        json!(true)
    );
    assert_eq!(call(&ctx, "plugin.credentials.clear", json!({ "id": "admin-source" }))["ok"], json!(true));
    let value = call(&ctx, "plugin.credentials.status", json!({ "id": "admin-source" }));
    assert!(value["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|field| field["present"] == json!(false)));

    // 凭据确实进了 store：插件沙箱的 credentials.get 能读到（插件的只读入口）
    ctx.plugins.credentials().set("admin-source", "cookie", Some("hidden"));
    assert_eq!(ctx.plugins.credentials().get("admin-source", "cookie").as_deref(), Some("hidden"));
    // 但命令层没有「读值」的出口
    let listed = call(&ctx, "plugin.list", json!({}));
    assert!(!listed.to_string().contains("hidden"), "列表也不该带出凭据值");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn check_update_compares_against_the_origin_and_never_updates() {
    let newer = SOURCE_V1.replace("@version 1.0.0", "@version 2.0.0").replace("管理源", "管理源 2");
    let http = FakeHttp::new(&[("https://example.com/plugin.js", newer.as_str())]);
    let (ctx, dir) = setup("update", http);

    // 本地来源（粘贴）→ 无从比对，返回 null
    install(&ctx, SOURCE_V1);
    let local = call(&ctx, "plugin.checkUpdate", json!({ "id": "admin-source" }));
    assert_eq!(local["ok"], json!(true), "{local}");
    assert_eq!(local["data"], json!(null), "粘贴来源无从比对：{local}");

    // URL 来源 → 下载新版本比对（不落盘、不自动更新）
    let installed = call(
        &ctx,
        "plugin.import",
        json!({
            "from": { "kind": "url", "url": "https://example.com/plugin.js" },
            "consent": true,
        }),
    );
    assert_eq!(installed["ok"], json!(true), "{installed}");
    let id = installed["data"]["plugin"]["id"].as_str().unwrap().to_string();
    // URL 来源装的就是 2.0.0；把库里的版本改回 1.0.0 模拟「装的是旧版」
    {
        let conn = rusqlite::Connection::open(&ctx.paths.db).unwrap();
        let manifest: String = conn
            .query_row("SELECT manifest FROM plugin_state WHERE id = ?1", [&id], |row| row.get(0))
            .unwrap();
        let patched = manifest.replace("\"version\":\"2.0.0\"", "\"version\":\"1.0.0\"");
        conn.execute("UPDATE plugin_state SET manifest = ?1 WHERE id = ?2", rusqlite::params![patched, id])
            .unwrap();
    }

    let value = call(&ctx, "plugin.checkUpdate", json!({ "id": id }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["current"], json!("1.0.0"));
    assert_eq!(value["data"]["latest"], json!("2.0.0"));
    assert_eq!(value["data"]["changed"], json!(true));
    // **不自动更新**：库里的版本仍是旧版
    let listed = call(&ctx, "plugin.list", json!({}));
    let listed_version = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == json!(id))
        .unwrap()["version"]
        .clone();
    assert_eq!(listed_version, json!("1.0.0"), "checkUpdate 不该改动已装版本");

    // 未安装 → not_found
    let missing = call(&ctx, "plugin.checkUpdate", json!({ "id": "nope" }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");

    std::fs::remove_dir_all(&dir).ok();
}
