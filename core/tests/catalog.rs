//! 跨源搜索聚合的集成测试（M2 第一片）。
//!
//! 用两个真实的（但完全本地的）示例插件跑完整链路：
//! 安装 → 按需加载 → 并发调用各源 → 归一化 → 合并 → 事件推送。
//! 断言重点是**契约里的承诺**：部分结果逐源到达、合并只在核心完成、
//! 候选顺序 = 优先级、非法条目被丢弃、单源失败不影响整体。

use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::events::EventSink;
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

/// 记录事件的 sink（真实实现会把事件推给前端）。
#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
}

impl RecordingSink {
    fn find(&self, event: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == event)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}

/// 不联网的传输层：任何请求都应失败（搜索只用到本地插件）。
struct OfflineTransport;

impl HttpTransport for OfflineTransport {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

const PLUGIN_A: &str = r#"
// @id source-a
// @name 源 A
// @version 1.0.0
// @author tester
async function search(keyword) {
    return [
        {id: '1', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', durationSec: 226},
        {id: '2', title: '只存在于 A', artist: '歌手甲', durationSec: 100},
        {id: '3', artist: '缺标题的条目'},
        {id: '4', title: '时长用 mm:ss', artist: '歌手乙', duration: '3:05'},
    ];
}
"#;

const PLUGIN_B: &str = r#"
// @id source-b
// @name 源 B
// @version 1.0.0
// @author tester
async function search(keyword) {
    return {items: [
        {id: 'x', title: '夜曲', artist: '周杰伦', durationSec: 227},
        {id: 'y', title: '只存在于 B', artist: '歌手丙', durationSec: 120},
    ]};
}
"#;

const PLUGIN_BROKEN: &str = r#"
// @id source-broken
// @name 坏源
// @version 1.0.0
// @author tester
async function search(keyword) { throw new Error('上游挂了'); }
"#;

fn setup() -> (CoreContext, Arc<RecordingSink>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "gently-catalog-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let sink = Arc::new(RecordingSink::default());

    let mut ctx = CoreContext::new(paths).with_store(store).with_events(sink.clone());
    ctx.http = Arc::new(OfflineTransport);
    (ctx, sink, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn install(ctx: &CoreContext, source: &str) -> String {
    let value = call(ctx, "plugin.import", json!({ "from": { "kind": "paste", "content": source }, "consent": true }));
    assert_eq!(value["ok"], json!(true), "{value}");
    value["data"]["plugin"]["id"].as_str().unwrap().to_string()
}

/// 等待 done 事件（搜索是异步的；真实前端也是订阅事件）。
fn wait_done(sink: &RecordingSink, timeout_ms: u64) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let done = sink.find("catalog.search.done");
        if let Some(last) = done.last() {
            return last.clone();
        }
        assert!(std::time::Instant::now() < deadline, "等待 done 事件超时");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn search_streams_per_source_and_merges_in_core() {
    let (ctx, sink, dir) = setup();
    let a = install(&ctx, PLUGIN_A);
    let b = install(&ctx, PLUGIN_B);
    assert_eq!((a.as_str(), b.as_str()), ("source-a", "source-b"));

    // 让 B 优先（数值越小越优先）→ 合并结果的候选顺序应为 B、A
    assert_eq!(call(&ctx, "plugin.setPriority", json!({ "id": b, "priority": 10 }))["ok"], json!(true));

    let started = call(&ctx, "catalog.search", json!({ "keyword": "夜曲" }));
    assert_eq!(started["ok"], json!(true), "{started}");
    let search_id = started["data"]["searchId"].as_str().unwrap().to_string();
    assert_eq!(started["data"]["sourceCount"], json!(2), "两个源都应参与");

    let done = wait_done(&sink, 5_000);
    assert_eq!(done["searchId"], json!(search_id));
    assert_eq!(done["failedSources"], json!([]));

    // 逐源 partial：每个源一条，且带上了该源的原始结果
    let partials = sink.find("catalog.search.partial");
    assert_eq!(partials.len(), 2, "{partials:?}");
    let sources: Vec<&str> = partials.iter().map(|p| p["source"].as_str().unwrap()).collect();
    assert!(sources.contains(&"source-a") && sources.contains(&"source-b"));

    // A 源的非法条目被丢弃（缺 title），合法条目保留（含 mm:ss 解析）
    let partial_a = partials.iter().find(|p| p["source"] == json!("source-a")).unwrap();
    assert_eq!(partial_a["tracks"].as_array().unwrap().len(), 3);
    assert_eq!(partial_a["dropped"], json!(1));
    let mmss = partial_a["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["title"] == json!("时长用 mm:ss"))
        .unwrap();
    assert_eq!(mmss["durationSec"], json!(185));
    assert_eq!(mmss["duration"], json!("3:05"));

    // 合并结果：4 条（夜曲合并 + A 的两条独有 + B 的一条独有），夜曲有 2 个候选且顺序为 B、A
    let items = done["items"].as_array().unwrap();
    assert_eq!(items.len(), 4, "{items:?}");
    let merged = items.iter().find(|item| item["title"] == json!("夜曲")).unwrap();
    assert_eq!(merged["sourceCount"], json!(2));
    let candidates = merged["candidates"].as_array().unwrap();
    assert_eq!(candidates[0]["source"], json!("source-b"), "优先级小的在前");
    assert_eq!(candidates[1]["source"], json!("source-a"));
    // 统一引用格式：source:rawId
    assert_eq!(candidates[0]["track"]["id"], json!("source-b:x"));
    assert_eq!(candidates[1]["track"]["id"], json!("source-a:1"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_failing_source_does_not_break_the_search() {
    let (ctx, sink, dir) = setup();
    install(&ctx, PLUGIN_A);
    install(&ctx, PLUGIN_BROKEN);
    // 坏源没有 playable 能力问题，但有 search；调用时抛错
    let started = call(&ctx, "catalog.search", json!({ "keyword": "x" }));
    let search_id = started["data"]["searchId"].as_str().unwrap().to_string();
    let done = wait_done(&sink, 5_000);

    assert_eq!(done["searchId"], json!(search_id));
    assert_eq!(done["failedSources"], json!(["source-broken"]));
    assert_eq!(done["sources"], json!(["source-a"]));
    assert!(done["items"].as_array().unwrap().len() >= 3);

    // 失败源也要有一条 partial（带 failed 说明），UI 才能标「该源不可用」
    let partial = sink
        .find("catalog.search.partial")
        .into_iter()
        .find(|p| p["source"] == json!("source-broken"))
        .expect("失败源应有 partial");
    assert_eq!(partial["failed"]["code"], json!("plugin.runtime_error"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn plugins_are_loaded_on_demand_and_filter_by_source() {
    let (ctx, sink, dir) = setup();
    install(&ctx, PLUGIN_A);
    // 安装只落盘：此时运行时里没有它
    assert!(ctx.plugins.loaded_ids().is_empty(), "安装不应建立运行时");

    // 搜索会按需加载（这样用户不必手动点重载）
    let started = call(&ctx, "catalog.search", json!({ "keyword": "x", "sources": ["source-a"] }));
    assert_eq!(started["data"]["sourceCount"], json!(1));
    let _ = wait_done(&sink, 5_000);
    assert_eq!(ctx.plugins.loaded_ids(), vec!["source-a".to_string()]);
    assert_eq!(installed_priority_snapshot(&ctx), 100);

    // 禁用后再搜：没有可用源 → done 事件带空结果（而不是报错）
    assert_eq!(call(&ctx, "plugin.setEnabled", json!({ "id": "source-a", "enabled": false }))["ok"], json!(true));
    let before = sink.find("catalog.search.done").len();
    let started = call(&ctx, "catalog.search", json!({ "keyword": "x" }));
    assert_eq!(started["data"]["sourceCount"], json!(0));
    let done = wait_done(&sink, 5_000);
    assert_eq!(sink.find("catalog.search.done").len(), before + 1);
    assert_eq!(done["items"], json!([]));

    std::fs::remove_dir_all(&dir).ok();
}

fn installed_priority_snapshot(ctx: &CoreContext) -> i64 {
    ctx.store.as_ref().unwrap().get_plugin("source-a").unwrap().unwrap().priority
}

#[test]
fn cancel_reports_unknown_search_ids() {
    let (ctx, _sink, dir) = setup();
    let value = call(&ctx, "catalog.searchCancel", json!({ "searchId": "search-nope" }));
    assert_eq!(value["error"]["code"], ErrorCode::NotFound.as_str(), "{value}");

    // 空关键词直接拒绝（不发事件、不建搜索）
    let value = call(&ctx, "catalog.search", json!({ "keyword": "   " }));
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str());

    std::fs::remove_dir_all(&dir).ok();
}
