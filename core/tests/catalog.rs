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

mod common;

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

/// MusicFree 风格的兼容插件：`module.exports` + `{isEnd, data}`，
/// `duration` 是**数字秒**（社区协议的 `IMusicItem.duration`）。
const PLUGIN_MUSICFREE: &str = r#"
// @id source-musicfree
// @name MusicFree 风格源
// @version 1.0.0
// @author tester
// @compat
module.exports = {
    platform: 'musicfree-style',
    async search(query, page, type) {
        return {
            isEnd: false,
            data: [
                {id: 'mf-1', title: '只存在于 MusicFree 源', artist: '歌手丁', album: '专辑', duration: 226, artwork: 'https://cdn.example.com/mf-1.jpg'},
                {id: 'mf-2', title: '时长是数字字符串', artist: '歌手戊', duration: '185', coverImg: 'https://cdn.example.com/mf-2.jpg'},
                {id: 'mf-3', title: '没有时长', artist: '歌手己'},
                {id: 'mf-4', artist: '缺标题'},
            ],
        };
    },
    async getMediaSource() { return null; },
};
"#;

fn setup() -> (CoreContext, Arc<RecordingSink>, std::path::PathBuf) {
    let dir = common::temp_dir("catalog");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let sink = Arc::new(RecordingSink::default());

    let ctx = CoreContext::new(paths)
        .with_store(store)
        .with_events(sink.clone())
        .with_http(Arc::new(OfflineTransport));
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
        let done = sink.find("catalog:search:done");
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
    let partials = sink.find("catalog:search:partial");
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
fn musicfree_wrapped_results_are_normalized() {
    let (ctx, sink, dir) = setup();
    install(&ctx, PLUGIN_MUSICFREE);

    let started = call(&ctx, "catalog.search", json!({ "keyword": "x" }));
    assert_eq!(started["ok"], json!(true), "{started}");
    let done = wait_done(&sink, 5_000);
    assert_eq!(done["failedSources"], json!([]), "{done}");

    let partial = sink
        .find("catalog:search:partial")
        .into_iter()
        .find(|p| p["source"] == json!("source-musicfree"))
        .expect("该源应有 partial");
    let tracks = partial["tracks"].as_array().unwrap();
    // `{isEnd, data}` 被拆开：3 条合法（第 4 条缺 title 被丢弃）
    assert_eq!(tracks.len(), 3, "{tracks:?}");
    assert_eq!(partial["dropped"], json!(1));

    let by_title = |title: &str| {
        tracks.iter().find(|track| track["title"] == json!(title)).unwrap().clone()
    };
    // MusicFree：duration 是数字秒
    let numeric = by_title("只存在于 MusicFree 源");
    assert_eq!(numeric["durationSec"], json!(226));
    assert_eq!(numeric["duration"], json!("3:46"));
    assert_eq!(numeric["artist"], json!("歌手丁"));
    assert_eq!(numeric["album"], json!("专辑"));
    // 数字字符串也按秒
    assert_eq!(by_title("时长是数字字符串")["durationSec"], json!(185));
    // 缺时长 → 0（不猜）
    assert_eq!(by_title("没有时长")["durationSec"], json!(0));
    // 引用仍是 source:rawId
    assert_eq!(numeric["id"], json!("source-musicfree:mf-1"));

    // 封面：字段名不统一（MusicFree 是 `artwork`，HTML 解析常见 `coverImg`），都要认
    assert_eq!(numeric["artwork"], json!("https://cdn.example.com/mf-1.jpg"));
    assert_eq!(
        by_title("时长是数字字符串")["artwork"],
        json!("https://cdn.example.com/mf-2.jpg")
    );
    // 没给封面就是空串——前端退回渐变占位，而不是渲染半个破图
    assert_eq!(by_title("没有时长")["artwork"], json!(""));

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
        .find("catalog:search:partial")
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
    let before = sink.find("catalog:search:done").len();
    let started = call(&ctx, "catalog.search", json!({ "keyword": "x" }));
    assert_eq!(started["data"]["sourceCount"], json!(0));
    let done = wait_done(&sink, 5_000);
    assert_eq!(sink.find("catalog:search:done").len(), before + 1);
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

#[test]
fn cancelled_search_still_settles_with_a_done_event() {
    // 前端中止搜索后仍然在等 `catalog:search:done`（`coreSearch` 的 Promise 由它兑现）。
    // 契约因此必须保证：**取消不会让 done 永远不来**——否则界面会一直转圈到超时。
    let (ctx, sink, dir) = setup();
    install(&ctx, PLUGIN_A);
    install(&ctx, PLUGIN_B);

    let started = call(&ctx, "catalog.search", json!({ "keyword": "夜曲" }));
    let search_id = started["data"]["searchId"].as_str().unwrap().to_string();

    // 立刻取消（线程可能已经开跑，也可能还没跑——两种情况都必须在有限时间内收敛）
    let cancelled = call(&ctx, "catalog.searchCancel", json!({ "searchId": search_id }));
    assert_eq!(cancelled["ok"], json!(true), "{cancelled}");

    let done = wait_done(&sink, 5_000);
    assert_eq!(done["searchId"], json!(search_id));
    assert!(done["items"].is_array(), "done 必须带上（可能为空的）结果数组：{done}");
    assert!(done["failedSources"].is_array(), "{done}");

    // 已经结束的搜索再取消 → `common.not_found`（「搜索已结束或不存在」是准确的；
    // 调用方是 fire-and-forget，不需要为它加一套「已结束」状态）
    let again = call(&ctx, "catalog.searchCancel", json!({ "searchId": search_id }));
    assert_eq!(again["error"]["code"], ErrorCode::NotFound.as_str(), "{again}");

    std::fs::remove_dir_all(&dir).ok();
}
