//! **整链路端到端测试**（M5 退出标准的那条链：导入插件 → 播放 → 扫描 → 收藏）。
//!
//! 与逐模块测试的分工：那些测试各自盯住一个子系统（沙箱、扫描、代理、本机库），
//! 这里只回答一个问题——**它们拼起来能不能用**。因此全程走 `dispatch`（与前端同一条路径），
//! 并且真的开 HTTP 去取代理地址，而不是打桩。
//!
//! 链路（每一步都断言，不做「跑通就行」）：
//!
//! 1. **导入插件**：从磁盘上的单文件导入（真实读取 `examples/plugins/gently-demo.js`），
//!    `consent: true`，随后 `plugin.reload` 建运行时并真实探测能力；
//! 2. **搜索**：`catalog.search` 走沙箱调用插件函数，拿到流式结果（demo 插件不联网，内容是写死的）；
//! 3. **扫描本地曲库**：生成一个真 WAV，`library.local.scan` 入库，`library.local.list` 能查到；
//! 4. **播放解析**：`playback.resolve` 对本地曲目返回**回环代理**地址；
//! 5. **真的播一次**：按 `Range` 请求那个地址，断言 `206` + `Content-Range` + `audio/wav`
//!    且字节与磁盘一致（这条是「本地文件播放无需 Blob hack」的证据）；
//! 6. **收藏 / 歌单 / 历史**：写入后从库读回，确认整条闭环落到了 SQLite。
//!
//! 注意一个设计边界：代理发布令牌前会拒绝回环/内网 origin（SSRF 防护），
//! 所以这里**不能**用「本机起的 origin 服务器」做远端串流——那是防护生效，不是测试缺口。
//! 本地文件走的是同一个代理，但目标在本地，因此能完整验证。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::events::EventSink;
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 除本机回环代理外，测试里不允许任何出网（demo 插件本来也不联网）。
struct OfflineTransport;

impl HttpTransport for OfflineTransport {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

#[derive(Default)]
struct RecordingSink {
    events: std::sync::Mutex<Vec<(String, Value)>>,
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

impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
}

/// 等一个事件（搜索与扫描的进度都是异步推送的；真实前端也是订阅事件）。
fn wait_event(sink: &RecordingSink, name: &str, timeout_ms: u64) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if let Some(last) = sink.find(name).last() {
            return last.clone();
        }
        assert!(std::time::Instant::now() < deadline, "等待 {name} 事件超时");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-e2e-{tag}"))
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

/// 生成一个可被 symphonia 识别的 PCM WAV：`seconds` 秒、8kHz 单声道 8bit。
fn write_wav(path: &std::path::Path, seconds: u32) {
    let sample_rate: u32 = 8_000;
    let data_len = sample_rate * seconds;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes()); // 字节率
    bytes.extend_from_slice(&1u16.to_le_bytes()); // 块对齐
    bytes.extend_from_slice(&8u16.to_le_bytes()); // 位深
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    // 简易正弦，避免整段静音（内容本身不重要，但让文件是「真的音频」）
    for index in 0..data_len {
        let phase = (index as f32 / 32.0) * std::f32::consts::TAU;
        bytes.push(((phase.sin() * 96.0) as i32 + 128) as u8);
    }
    std::fs::write(path, bytes).unwrap();
}

/// `http://127.0.0.1:<port>/m/<token>...` → 取回原始响应（含状态行与头）。
fn get_stream(url: &str, range: Option<&str>) -> (String, Vec<u8>) {
    let rest = url.strip_prefix("http://").expect("代理地址应为本机 HTTP");
    let (authority, path) = rest.split_once('/').expect("应有路径");
    let mut stream = TcpStream::connect(authority).expect("连接回环代理");
    let mut request = format!("GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n");
    if let Some(range) = range {
        request.push_str(&format!("Range: {range}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    stream.flush().unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();

    // 头与体按首个 \r\n\r\n 切开
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("响应应有空行分隔头与体");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    (head, raw[split + 4..].to_vec())
}

#[test]
fn full_chain_import_search_scan_play_favorite() {
    let dir = temp_dir("chain");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let sink: Arc<RecordingSink> = Arc::new(RecordingSink::default());
    let ctx = CoreContext::new(paths.clone())
        .with_store(store)
        .with_events(Arc::clone(&sink) as Arc<dyn EventSink>)
        .with_http(Arc::new(OfflineTransport));

    /* ---------- 1. 导入示例插件（从磁盘上的真实文件） ---------- */
    let demo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../examples/plugins/gently-demo.js");
    let demo = demo.canonicalize().expect("示例插件应存在");
    let imported = call(
        &ctx,
        "plugin.import",
        json!({
            "from": { "kind": "file", "path": demo.to_string_lossy() },
            "consent": true,
        }),
    );
    assert_eq!(imported["ok"], json!(true), "{imported}");
    assert_eq!(imported["data"]["plugin"]["id"], json!("gently-demo"));
    // 来源与校验和都要记下来（更新判断与审计的依据）
    assert_eq!(imported["data"]["plugin"]["origin"]["kind"], json!("file"));
    assert!(imported["data"]["plugin"]["sha256"].is_string(), "{imported}");

    let reloaded = call(&ctx, "plugin.reload", json!({ "id": "gently-demo" }));
    assert_eq!(reloaded["ok"], json!(true), "{reloaded}");
    let capabilities = reloaded["data"]["manifest"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("search")), "{capabilities:?}");

    /* ---------- 2. 搜索：命令 → 宿主 → 沙箱 → 插件函数 → 结果 ---------- */
    let search = call(&ctx, "catalog.search", json!({ "keyword": "示例" }));
    assert_eq!(search["ok"], json!(true), "{search}");
    let search_id = search["data"]["searchId"].as_str().unwrap().to_string();

    // 搜索是**流式**的：命令立刻返回 searchId，结果经事件到达（前端也这么接）
    let done = wait_event(&sink, "catalog:search:done", 10_000);
    assert_eq!(done["searchId"], json!(search_id));
    assert_eq!(done["failedSources"], json!([]));
    let items = done["items"].as_array().expect("收敛结果应是数组");
    assert_eq!(items.len(), 3, "示例插件写死了 3 首：{items:?}");
    assert!(items.iter().all(|item| item["source"] == json!("gently-demo")));
    // 逐源结果也推给前端了（分源视图用）
    let partials = sink.find("catalog:search:partial");
    assert_eq!(partials.len(), 1, "{partials:?}");
    assert_eq!(partials[0]["source"], json!("gently-demo"));

    /* ---------- 3. 扫描本地曲库（真 WAV → symphonia 读取） ---------- */
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    write_wav(&music.join("chain-song.wav"), 2);

    let scan = call(
        &ctx,
        "library.local.scan",
        json!({ "dirs": [music.to_string_lossy()], "recursive": true }),
    );
    assert_eq!(scan["ok"], json!(true), "{scan}");
    assert_eq!(scan["data"]["added"], json!(1), "{scan}");

    let listed = call(&ctx, "library.local.list", json!({ "limit": 10 }));
    let local = listed["data"]["items"].as_array().unwrap();
    assert_eq!(local.len(), 1, "{listed}");
    let track = local[0].clone();
    let reference = track["id"].as_str().unwrap().to_string();
    assert!(reference.starts_with("local:"), "本地曲目引用以 local: 开头：{reference}");
    assert!(track["durationSec"].as_u64().unwrap() >= 1, "时长应被解析：{track}");
    // 扫描进度也走事件（前端据此显示进度）
    assert!(
        sink.events.lock().unwrap().iter().any(|(name, _)| name == "library:scan:progress"),
        "扫描应推送 library:scan:progress"
    );

    /* ---------- 4. 播放解析：本地文件 → 回环代理地址 ---------- */
    // 用契约里的参数名 `ref`（核心同时兼容早期的 `reference`，但对外只有一个名字）
    let resolved = call(&ctx, "playback.resolve", json!({ "ref": reference, "quality": "standard" }));
    assert_eq!(resolved["ok"], json!(true), "{resolved}");
    let stream_url = resolved["data"]["streamUrl"].as_str().expect("应返回 streamUrl");
    assert!(stream_url.starts_with("http://127.0.0.1:"), "必须是回环代理：{stream_url}");

    // 参数名兼容：历史写法（`reference`）仍然可用，不能因为改名就报「缺字段」
    let legacy = call(&ctx, "playback.resolve", json!({ "reference": reference, "quality": "standard" }));
    assert_eq!(legacy["ok"], json!(true), "{legacy}");
    assert_eq!(legacy["data"]["source"], json!("local"));

    /* ---------- 5. 真的按 Range 取一次（拖动进度的前提） ---------- */
    let full = get_stream(stream_url, None);
    assert!(full.0.starts_with("HTTP/1.1 200"), "{}\n{}", full.0, stream_url);
    assert!(full.0.to_lowercase().contains("content-type: audio/wav"), "{}", full.0);
    let on_disk = std::fs::read(music.join("chain-song.wav")).unwrap();
    assert_eq!(full.1.len(), on_disk.len(), "整段响应的字节数应与磁盘一致");

    let partial = get_stream(stream_url, Some("bytes=0-43"));
    let head = partial.0.to_lowercase();
    assert!(head.starts_with("http/1.1 206"), "Range 请求应回 206：{}", partial.0);
    assert!(head.contains("content-range: bytes 0-43/"), "应有 Content-Range：{}", partial.0);
    assert_eq!(partial.1.len(), 44, "应只回 44 字节");
    assert_eq!(&partial.1[..4], b"RIFF", "取到的应该是 WAV 头");

    // 越界 Range → 416（而不是 200 + 空体）
    let out_of_range = get_stream(stream_url, Some("bytes=999999999-"));
    assert!(
        out_of_range.0.starts_with("HTTP/1.1 416"),
        "越界 Range 应回 416：{}",
        out_of_range.0
    );

    /* ---------- 6. 收藏 / 歌单 / 历史：写进去再读回来 ---------- */
    let favorite = call(
        &ctx,
        "library.favorites.set",
        json!({ "ref": reference, "favorite": true, "track": track }),
    );
    assert_eq!(favorite["ok"], json!(true), "{favorite}");
    let favorites = call(&ctx, "library.favorites.list", json!({ "limit": 10 }));
    let favorite_items = favorites["data"]["items"].as_array().unwrap();
    assert_eq!(favorite_items.len(), 1, "{favorites}");
    assert_eq!(favorite_items[0]["title"], track["title"]);

    let saved = call(
        &ctx,
        "library.playlists.save",
        json!({
            "name": "整链路测试歌单",
            "trackRefs": [reference],
            "tracks": [track],
        }),
    );
    assert_eq!(saved["ok"], json!(true), "{saved}");
    let playlists = call(&ctx, "library.playlists.list", json!({}));
    let playlist = &playlists["data"][0];
    assert_eq!(playlist["name"], json!("整链路测试歌单"));
    assert_eq!(playlist["tracks"].as_array().unwrap().len(), 1, "{playlists}");

    // 播放上报（与 `library.history.push` 同一实现）→ 最近播放里能看到
    let reported = call(
        &ctx,
        "playback.report",
        json!({
            "ref": reference,
            "source": "local",
            "playedSec": 2,
            "completed": true,
            "track": track,
        }),
    );
    assert_eq!(reported["ok"], json!(true), "{reported}");
    let history = call(&ctx, "library.history.list", json!({ "limit": 10 }));
    let recent = history["data"]["items"].as_array().unwrap();
    assert_eq!(recent.len(), 1, "{history}");
    assert_eq!(recent[0]["playCount"], json!(1));

    /* ---------- 7. 重启后仍在：重开进程的库读同一份数据 ---------- */
    drop(ctx);
    let store = Store::open(&paths.db).unwrap();
    let reopened = CoreContext::new(paths.clone()).with_store(store);
    let favorites = call(&reopened, "library.favorites.list", json!({ "limit": 10 }));
    assert_eq!(
        favorites["data"]["items"].as_array().unwrap().len(),
        1,
        "收藏应跨进程留存：{favorites}"
    );
    let plugins = call(&reopened, "plugin.list", json!({}));
    assert_eq!(plugins["data"][0]["id"], json!("gently-demo"));

    std::fs::remove_dir_all(&dir).ok();
}
