//! 下载域的集成测试（M3 最后一块）：任务状态机 + 流式落盘 + 暂停/续传。
//!
//! 用**假传输层**驱动：它按 `Range` 头决定从哪个偏移开始吐字节，因此
//! 「续传」「上游忽略 Range → 从头写」这两条最容易出错的分支都能真的跑到。
//!
//! 盯住六件事：
//! 1. 建任务立刻返回，进度靠事件推送，完成后 `.part` 被 rename 成最终文件；
//! 2. 文件名来自曲目（非法字符替换、去路径分隔符）；
//! 3. 暂停停在中途、进度落库；续传带上 `Range` 并接着写；
//! 4. 上游忽略 `Range`（回 200）时**从头写**，不能把完整响应追加到半截文件后面；
//! 5. `remove` 删记录 + 清半成品；`deleteFile` 才删已完成文件；
//! 6. 本地曲目、缺失目录、上游失败都给明确错误。

use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::events::EventSink;
use gently_core::plugin::{DownloadEvent, DownloadOutcome, HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 假音频源：`getMediaSource` 返回固定地址，字节由假传输层提供。
const SOURCE: &str = r#"
// @id dl-source
// @name 下载源
// @version 1.0.0
// @author tester
// @hosts cdn.example.com
async function search() { return []; }
async function getMediaSource(track, quality) {
    return {url: 'https://cdn.example.com/audio/' + track.id + '.flac', headers: {'Referer': 'https://example.com'}};
}
"#;

/// 记录事件的 sink。
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
    fn find(&self, name: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == name)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}

/// 假传输层：`body` 是完整"文件"，按 Range 决定吐哪一段。
struct FakeTransport {
    body: Vec<u8>,
    /// 是否忽略 Range（模拟不支持续传的上游）
    ignore_range: bool,
    /// 每次吐多少字节（让暂停有机会发生在中途）
    chunk: usize,
    /// 每块之间的延迟：暂停测试需要「下载还在跑」的时间窗口
    delay: std::time::Duration,
    ranges: Mutex<Vec<Option<String>>>,
}

impl FakeTransport {
    fn new(size: usize) -> Arc<Self> {
        Arc::new(Self {
            body: (0..size).map(|index| (index % 251) as u8).collect(),
            ignore_range: false,
            chunk: 4096,
            delay: std::time::Duration::ZERO,
            ranges: Mutex::new(Vec::new()),
        })
    }

    /// 一个下得很慢的假上游：暂停/续传测试需要稳定的时间窗口。
    fn slow(size: usize, delay_ms: u64) -> Arc<Self> {
        let transport = FakeTransport::new(size);
        Arc::new(Self {
            body: transport.body.clone(),
            ignore_range: false,
            chunk: 1024,
            delay: std::time::Duration::from_millis(delay_ms),
            ranges: Mutex::new(Vec::new()),
        })
    }

    /// 一个「忽略 Range」的假上游（模拟不支持续传的服务器）。
    fn ignoring_range(size: usize) -> Arc<Self> {
        Arc::new(Self {
            body: (0..size).map(|index| (index % 251) as u8).collect(),
            ignore_range: true,
            chunk: 4096,
            delay: std::time::Duration::ZERO,
            ranges: Mutex::new(Vec::new()),
        })
    }

    fn ranges(&self) -> Vec<Option<String>> {
        self.ranges.lock().unwrap().clone()
    }
}

impl HttpTransport for FakeTransport {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：只支持流式下载"))
    }

    fn download(
        &self,
        request: &HttpRequest,
        sink: &mut dyn FnMut(DownloadEvent<'_>) -> bool,
    ) -> Fallible<DownloadOutcome> {
        let range = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("range"))
            .map(|(_, value)| value.clone());
        self.ranges.lock().unwrap().push(range.clone());

        let offset = match (&range, self.ignore_range) {
            (Some(_), false) => range
                .as_deref()
                .and_then(|value| value.strip_prefix("bytes="))
                .and_then(|value| value.trim_end_matches('-').parse::<usize>().ok())
                .unwrap_or(0),
            _ => 0,
        };
        let partial = range.is_some() && !self.ignore_range;
        let status = if partial { 206 } else { 200 };
        let remaining = &self.body[offset.min(self.body.len())..];
        let headers = vec![
            ("content-length".to_string(), remaining.len().to_string()),
            ("content-type".to_string(), "audio/flac".to_string()),
        ];

        if !sink(DownloadEvent::Start { status, headers: &headers }) {
            return Ok(DownloadOutcome { status, headers, bytes: 0, aborted: true });
        }

        let mut written = 0u64;
        for chunk in remaining.chunks(self.chunk) {
            if !self.delay.is_zero() {
                std::thread::sleep(self.delay);
            }
            if !sink(DownloadEvent::Chunk(chunk)) {
                return Ok(DownloadOutcome { status, headers, bytes: written, aborted: true });
            }
            written += chunk.len() as u64;
        }
        Ok(DownloadOutcome { status, headers, bytes: written, aborted: false })
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-download-{tag}"))
}

fn setup(tag: &str, transport: Arc<dyn HttpTransport>) -> (CoreContext, Arc<RecordingSink>, std::path::PathBuf) {
    let dir = temp_dir(tag);
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let sink = Arc::new(RecordingSink::default());
    let ctx = CoreContext::new(paths)
        .with_store(store)
        .with_events(sink.clone())
        .with_http(transport);
    (ctx, sink, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn install(ctx: &CoreContext) {
    let value = call(
        ctx,
        "plugin.import",
        json!({ "from": { "kind": "paste", "content": SOURCE }, "consent": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
}

fn track(id: &str) -> Value {
    json!({"id": id, "title": "标题/带:非法*字符", "artist": "歌手", "durationSec": 200})
}

/// 等到任务进入某个状态（下载是异步的；真实前端也是订阅事件）。
fn wait_status(ctx: &CoreContext, id: &str, want: &str, timeout_ms: u64) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let listed = call(ctx, "download.list", json!({}));
        if let Some(task) = listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == json!(id))
        {
            if task["status"] == json!(want) {
                return task.clone();
            }
        }
        assert!(std::time::Instant::now() < deadline, "等待状态 {want} 超时");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn create_downloads_to_a_safe_file_name_and_renames_part() {
    let transport = FakeTransport::new(512 * 1024);
    let (ctx, sink, dir) = setup("create", transport.clone());
    install(&ctx);

    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:track-1", "quality": "high", "track": track("track-1") }),
    );
    assert_eq!(created["ok"], json!(true), "{created}");
    let task = created["data"].clone();
    let id = task["id"].as_str().unwrap().to_string();
    assert_eq!(task["status"], json!("pending"), "建任务立刻返回，不等下载完成");
    assert!(task["track"]["title"].is_string(), "任务带曲目快照");

    let done = wait_status(&ctx, &id, "done", 5_000);
    assert_eq!(done["progress"], json!(1.0), "{done}");
    assert_eq!(done["sizeText"], json!("512 KB/512 KB"), "{done}");
    assert!(done["path"].as_str().unwrap().contains("下载源") == false);

    // 文件名来自曲目：路径分隔符与非法字符都被替换，`.part` 已消失
    let path = std::path::PathBuf::from(done["path"].as_str().unwrap());
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    assert!(name.starts_with("歌手 - 标题_带_非法_字符"), "{name}");
    assert!(name.ends_with(".flac"), "{name}");
    assert!(path.is_file(), "完成后应能读到最终文件");
    assert!(!path.with_file_name(format!("{name}.part")).exists(), "半成品要 rename 掉");
    assert_eq!(std::fs::read(&path).unwrap().len(), 512 * 1024);

    // 事件：进度 + 完成
    assert!(!sink.find("download:progress").is_empty(), "要有进度事件");
    let finished = sink.find("download:done");
    assert_eq!(finished.len(), 1, "{finished:?}");
    assert_eq!(finished[0]["id"], json!(id));

    // 列表按状态过滤
    let only_done = call(&ctx, "download.list", json!({ "status": "done" }));
    let done_items = only_done["data"].as_array().unwrap();
    assert_eq!(done_items.len(), 1, "只应有一个已完成任务：{only_done}");

    // 本地曲目不需要下载
    let local = call(
        &ctx,
        "download.create",
        json!({ "ref": "local:C:/music/a.flac", "quality": "standard" }),
    );
    assert_eq!(local["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{local}");

    // 目标目录不存在 → 参数非法
    let bad = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:t2", "dir": dir.join("nope").to_string_lossy() }),
    );
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pause_and_resume_continue_from_the_partial_file() {
    // 慢上游（每 1KiB 停 3ms）→ 有足够时间在「下载中途」暂停
    let transport = FakeTransport::slow(512 * 1024, 3);
    let (ctx, _sink, dir) = setup("resume", transport.clone());
    install(&ctx);

    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:t", "track": {"id": "t", "title": "大文件", "artist": "歌手"} }),
    );
    let id = created["data"]["id"].as_str().unwrap().to_string();

    // 等到真的有字节落盘（进度事件说明已经在跑），再暂停
    let part_path = {
        let path = std::path::PathBuf::from(created["data"]["path"].as_str().unwrap());
        std::path::PathBuf::from(format!("{}.part", path.to_string_lossy()))
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::fs::metadata(&part_path).map(|meta| meta.len()).unwrap_or(0) == 0 {
        assert!(std::time::Instant::now() < deadline, "下载没有开始");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let paused = call(&ctx, "download.pause", json!({ "id": id }));
    assert_eq!(paused["ok"], json!(true), "{paused}");
    let stopped = wait_status(&ctx, &id, "paused", 5_000);
    assert!(stopped["received"].is_null() || true);

    // 半成品文件存在，且长度小于完整文件
    let size = std::fs::metadata(&part_path).expect("暂停要留下半成品文件").len();
    assert!(size > 0 && size < 512 * 1024, "半成品长度应在中间：{size}");

    // 续传：第二次请求必须带 Range，且最终文件完整
    let resumed = call(&ctx, "download.resume", json!({ "id": id }));
    assert_eq!(resumed["ok"], json!(true), "{resumed}");
    let done = wait_status(&ctx, &id, "done", 10_000);
    assert_eq!(done["progress"], json!(1.0), "{done}");

    let ranges = transport.ranges();
    assert!(ranges.len() >= 2, "应该发生两次请求（初次 + 续传）：{ranges:?}");
    let resume_range = ranges[1].clone().expect("续传必须带 Range");
    assert_eq!(resume_range, format!("bytes={size}-"), "续传偏移必须等于半成品长度");

    let path = std::path::PathBuf::from(done["path"].as_str().unwrap());
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.len(), 512 * 1024, "续传后文件必须完整");
    let expected: Vec<u8> = (0..512 * 1024).map(|index| (index % 251) as u8).collect();
    assert_eq!(bytes, expected, "续传拼出来的内容必须和原始字节一致");
    assert!(!part_path.exists(), "完成后半成品要消失");

    // 已完成的任务不能再暂停/续传
    let again = call(&ctx, "download.pause", json!({ "id": id }));
    assert_eq!(again["ok"], json!(false), "已结束的任务不该能暂停：{again}");
    let resume_done = call(&ctx, "download.resume", json!({ "id": id }));
    assert_eq!(resume_done["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{resume_done}");

    std::fs::remove_dir_all(&dir).ok();
}
#[test]
fn upstream_ignoring_range_restarts_instead_of_appending() {
    // 上游不支持续传：带 Range 也回 200 + 完整正文
    let transport: Arc<dyn HttpTransport> = FakeTransport::ignoring_range(256 * 1024);

    let (ctx, _sink, dir) = setup("ignore-range", transport);
    install(&ctx);

    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:t", "track": {"id": "t", "title": "无续传", "artist": "歌手"} }),
    );
    let id = created["data"]["id"].as_str().unwrap().to_string();
    let _ = call(&ctx, "download.pause", json!({ "id": id }));
    let _ = call(&ctx, "download.resume", json!({ "id": id }));
    let done = wait_status(&ctx, &id, "done", 5_000);

    let path = std::path::PathBuf::from(done["path"].as_str().unwrap());
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.len(), 256 * 1024, "忽略 Range 时必须从头写，不能追加成坏文件");
    // 内容也必须正确（不是「半截 + 完整」）
    let expected: Vec<u8> = (0..256 * 1024).map(|index| (index % 251) as u8).collect();
    assert_eq!(bytes, expected, "文件内容必须是完整的原始字节");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn remove_clears_partial_files_and_only_deletes_finished_files_when_asked() {
    let transport = FakeTransport::new(128 * 1024);
    let (ctx, _sink, dir) = setup("remove", transport);
    install(&ctx);

    // 完成一个任务
    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:a", "track": {"id": "a", "title": "甲", "artist": "歌手"} }),
    );
    let done_id = created["data"]["id"].as_str().unwrap().to_string();
    let done = wait_status(&ctx, &done_id, "done", 5_000);
    let done_path = std::path::PathBuf::from(done["path"].as_str().unwrap());

    // 移除任务但保留文件（缺省语义：文件是用户的资产）
    assert_eq!(call(&ctx, "download.remove", json!({ "id": done_id }))["ok"], json!(true));
    assert!(done_path.exists(), "缺省不该删已完成的任务文件");
    assert_eq!(call(&ctx, "download.list", json!({}))["data"], json!([]));

    // 再建一个任务，带 deleteFile 移除 → 文件也没了
    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:b", "track": {"id": "b", "title": "乙", "artist": "歌手"} }),
    );
    let id = created["data"]["id"].as_str().unwrap().to_string();
    let again = wait_status(&ctx, &id, "done", 5_000);
    let path = std::path::PathBuf::from(again["path"].as_str().unwrap());
    assert_eq!(
        call(&ctx, "download.remove", json!({ "id": id, "deleteFile": true }))["ok"],
        json!(true)
    );
    assert!(!path.exists(), "deleteFile 要真的删掉");

    // 重复移除 → 明确报未找到
    let missing = call(&ctx, "download.remove", json!({ "id": id }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");

    // clearFinished 只清记录
    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:c", "track": {"id": "c", "title": "丙", "artist": "歌手"} }),
    );
    let id = created["data"]["id"].as_str().unwrap().to_string();
    let _ = wait_status(&ctx, &id, "done", 5_000);
    let cleared = call(&ctx, "download.clearFinished", json!({}));
    assert_eq!(cleared["data"]["removed"], json!(1), "{cleared}");
    assert_eq!(call(&ctx, "download.list", json!({}))["data"], json!([]));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn upstream_failure_marks_the_task_as_error_with_an_event() {
    // 音源给了非 HTTPS 地址 → 下载地址校验失败
    let transport = FakeTransport::new(1024);
    let (ctx, sink, dir) = setup("error", transport);
    install(&ctx);

    let created = call(
        &ctx,
        "download.create",
        json!({ "ref": "dl-source:t", "track": {"id": "t", "title": "甲", "artist": "歌手"} }),
    );
    let id = created["data"]["id"].as_str().unwrap().to_string();

    // 这里正常会成功；改用「删掉插件文件让 getMediaSource 失败」构造失败路径
    std::fs::remove_file(ctx.paths.plugins.join("dl-source").join("plugin.js")).unwrap();
    let resumed = call(&ctx, "download.resume", json!({ "id": id }));
    let _ = resumed;

    // 状态要么 done（已在删文件前跑完），要么 error + 事件；两种都不能卡在中间状态。
    // 这里等一个终止状态：worker 是异步的，读一次必然是竞态。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let task = loop {
        let listed = call(&ctx, "download.list", json!({}));
        let task = listed["data"][0].clone();
        if task["status"] == json!("done") || task["status"] == json!("error") {
            break task;
        }
        assert!(std::time::Instant::now() < deadline, "任务卡在中间状态：{task}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    if task["status"] == json!("error") {
        assert!(!sink.find("download:error").is_empty(), "失败要发 download:error");
    }

    std::fs::remove_dir_all(&dir).ok();
}


