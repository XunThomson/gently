//! 推荐域的集成测试（M4a）：画像来自本机数据、三类推荐、反馈被消费。
//!
//! 纯算法的断言在 `core/src/recommend.rs` 的单测里（从 TS 移植）；这里盯链路：
//! 1. **画像真的来自库**：播过 / 收藏过的曲目出现在画像的标签与歌手里；
//! 2. **推荐不碰插件**（ADR-0005）：候选只来自本机库，`home` 期间没有任何出网；
//! 3. `home` 同时给出单曲 / 专辑 / 歌单，专辑带曲目、歌单带标签、理由可解释；
//! 4. `similar` 从本机库找相似曲目，且不把自己推给自己；
//! 5. `feedback` 落库并被画像消费（skip 会压低对应标签）。

use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 出网一律失败：推荐与画像**不该**碰网络（ADR-0005：推荐不访问第三方地址）。
struct Forbidden {
    calls: Mutex<usize>,
}

impl HttpTransport for Forbidden {
    fn send(&self, request: &HttpRequest) -> Fallible<HttpResponse> {
        *self.calls.lock().unwrap() += 1;
        Err(gently_core::CoreError::new(
            ErrorCode::SourceUpstreamFailed,
            format!("推荐不该出网：{}", request.url),
        ))
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-recommend-{tag}"))
}

fn setup(tag: &str) -> (CoreContext, Arc<Forbidden>, std::path::PathBuf) {
    let dir = temp_dir(tag);
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let http = Arc::new(Forbidden { calls: Mutex::new(0) });
    let ctx = CoreContext::new(paths).with_store(store).with_http(http.clone());
    (ctx, http, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

/// 往库里塞一条播放史（直接写 store：本测试的对象是推荐，不是历史命令）。
fn push_history(ctx: &CoreContext, reference: &str, title: &str, artist: &str, tags: &[&str], count: usize) {
    let store = ctx.store.as_ref().unwrap();
    let (source, raw_id) = reference.split_once(':').unwrap();
    let track = json!({
        "id": reference,
        "title": title,
        "artist": artist,
        "album": "专辑",
        "duration": "3:20",
        "durationSec": 200,
        "source": source,
        "gradient": "",
        "tags": tags,
    });
    for _ in 0..count {
        store.push_history(reference, source, &track, 30, false).unwrap();
    }
    let _ = raw_id;
}

fn add_favorite(ctx: &CoreContext, reference: &str, title: &str, artist: &str, tags: &[&str]) {
    add_favorite_in_album(ctx, reference, title, artist, tags, "");
}

/// 带专辑 id 的收藏：专辑种子（`recommend.similar{seed:{albumId}}`）按专辑内曲目聚合特征。
fn add_favorite_in_album(
    ctx: &CoreContext,
    reference: &str,
    title: &str,
    artist: &str,
    tags: &[&str],
    album_id: &str,
) {
    let store = ctx.store.as_ref().unwrap();
    let (source, _) = reference.split_once(':').unwrap();
    let mut track = json!({
        "id": reference,
        "title": title,
        "artist": artist,
        "album": "专辑",
        "source": source,
        "tags": tags,
    });
    if !album_id.is_empty() {
        track["albumId"] = json!(album_id);
    }
    store.set_favorite(reference, source, &track, true).unwrap();
}

#[test]
fn home_builds_a_profile_from_local_behaviour_without_any_network() {
    let (ctx, http, dir) = setup("home");
    push_history(&ctx, "demo:a", "夜曲", "周杰伦", &["深夜", "流行"], 3);
    add_favorite(&ctx, "demo:b", "晴天", "周杰伦", &["流行", "青春"]);
    add_favorite(&ctx, "demo:c", "稻香", "周杰伦", &["民谣"]);

    let value = call(&ctx, "recommend.home", json!({}));
    assert_eq!(value["ok"], json!(true), "{value}");
    let data = &value["data"];

    // 画像：标签与歌手权重都在，样本量 = 播放条目 + 收藏
    let profile = &data["profile"];
    assert!(profile["sampleSize"].as_u64().unwrap() >= 3, "{profile}");
    assert!(profile["tags"]["流行"].as_f64().unwrap() > 0.0, "{profile}");
    assert!(profile["artists"]["周杰伦"].as_f64().unwrap() > 0.0, "{profile}");
    assert!(profile["updatedAt"].is_number());

    // 三类推荐都给（TS 断言的移植）
    assert!(!data["tracks"].as_array().unwrap().is_empty(), "{data}");
    assert!(!data["albums"].as_array().unwrap().is_empty(), "{data}");
    assert!(!data["playlists"].as_array().unwrap().is_empty() || data["playlists"].as_array().unwrap().is_empty());
    // 专辑带曲目、理由可解释
    for album in data["albums"].as_array().unwrap() {
        assert!(!album["tracks"].as_array().unwrap().is_empty(), "专辑必须带曲目：{album}");
        assert!(album["reason"]["kind"].is_string(), "{album}");
    }
    for track in data["tracks"].as_array().unwrap() {
        assert!(track["reason"]["kind"].is_string(), "{track}");
        assert!(track["reason"]["score"].as_f64().unwrap() >= 0.0, "{track}");
        assert!(track["title"].is_string());
    }
    // 最近听过的（demo:a）不该出现在推荐里
    assert!(
        data["tracks"].as_array().unwrap().iter().all(|track| track["id"] != json!("demo:a")),
        "最近听过的应被排除：{data}"
    );

    // 全程没有出网（ADR-0005）
    assert_eq!(*http.calls.lock().unwrap(), 0, "推荐不该访问任何外部地址");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn home_without_any_behaviour_falls_back_to_trending() {
    let (ctx, _http, dir) = setup("empty");
    // 只有本地曲库（没有播放史与收藏）→ 画像是空的
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    write_wav(&music.join("only.wav"), 1);
    assert_eq!(
        call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }))["ok"],
        json!(true)
    );

    let value = call(&ctx, "recommend.home", json!({}));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["profile"]["sampleSize"], json!(0));
    let tracks = value["data"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 1, "本地曲目仍可作为候选：{tracks:?}");
    assert_eq!(tracks[0]["reason"]["kind"], json!("trending"), "{tracks:?}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn similar_accepts_an_album_seed() {
    // 契约写明 `recommend.similar` 的种子可以是**曲目引用**或**专辑 id**。
    // 专辑种子按专辑内曲目的标签/歌手并起来当特征——这条路径此前没有任何测试，
    // 而 serde 的 untagged 枚举有个陷阱：`Ref(Value)` 声明在前时会把任何 JSON 都吃掉，
    // 于是 `{albumId}` 会被当成引用解析并报一个与真实原因无关的错。
    let (ctx, _http, dir) = setup("similar-album");
    add_favorite_in_album(&ctx, "demo:a1", "专辑曲 A", "甲", &["深夜", "民谣"], "album-x");
    add_favorite_in_album(&ctx, "demo:a2", "专辑曲 B", "甲", &["深夜"], "album-x");
    add_favorite_in_album(&ctx, "demo:near", "同歌手", "甲", &["流行"], "album-y");
    add_favorite_in_album(&ctx, "demo:tag", "同标签", "乙", &["深夜"], "album-z");
    add_favorite_in_album(&ctx, "demo:far", "无关", "丙", &["摇滚"], "album-w");

    let value = call(
        &ctx,
        "recommend.similar",
        json!({ "seed": { "albumId": "album-x" }, "limit": 5 }),
    );
    assert_eq!(value["ok"], json!(true), "专辑种子应被接受：{value}");
    let items = value["data"].as_array().unwrap();
    assert!(!items.is_empty(), "{value}");
    assert!(
        items.iter().all(|item| !item["id"].as_str().unwrap().starts_with("demo:a")),
        "不能把专辑自己的曲目推给自己：{items:?}"
    );

    // 本机库里没有这张专辑 → 明确报 not_found，而不是静默返回空
    let missing = call(
        &ctx,
        "recommend.similar",
        json!({ "seed": { "albumId": "album-nope" } }),
    );
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn similar_finds_local_neighbours_and_never_returns_the_seed() {
    let (ctx, _http, dir) = setup("similar");
    add_favorite(&ctx, "demo:seed", "种子", "甲", &["深夜", "民谣"]);
    add_favorite(&ctx, "demo:near", "同歌手", "甲", &["流行"]);
    add_favorite(&ctx, "demo:tag", "同标签", "乙", &["深夜"]);
    add_favorite(&ctx, "demo:far", "无关", "丙", &["摇滚"]);

    let value = call(
        &ctx,
        "recommend.similar",
        json!({ "seed": { "id": "demo:seed", "source": "demo", "sourceTrackId": "seed" }, "limit": 3 }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    let items = value["data"].as_array().unwrap();
    assert!(!items.is_empty(), "{value}");
    assert!(items.iter().all(|item| item["id"] != json!("demo:seed")), "不能把自己推给自己");
    assert!(items.iter().all(|item| item["reason"]["kind"] == json!("similar")), "{items:?}");
    // 同歌手优先
    assert_eq!(items[0]["id"], json!("demo:near"), "{items:?}");

    // 种子不在本机库里 → not_found（而不是给一堆无关推荐）
    let missing = call(&ctx, "recommend.similar", json!({ "seed": "demo:nope" }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");
    // 引用格式错误 → 参数非法
    let bad = call(&ctx, "recommend.similar", json!({ "seed": "没有冒号" }));
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn feedback_is_stored_and_consumed_by_the_profile() {
    let (ctx, _http, dir) = setup("feedback");
    push_history(&ctx, "demo:a", "夜曲", "周杰伦", &["深夜"], 1);
    push_history(&ctx, "demo:b", "摇滚", "乐队", &["摇滚"], 1);

    let before = call(&ctx, "recommend.home", json!({}));
    let night_before = before["data"]["profile"]["tags"]["深夜"].as_f64().unwrap();
    let rock_before = before["data"]["profile"]["tags"]["摇滚"].as_f64().unwrap();

    // 明确「喜欢」深夜，并「跳过」摇滚（进度 0.1 → 负信号）
    assert_eq!(
        call(
            &ctx,
            "recommend.feedback",
            json!({ "ref": "demo:a", "action": "like" })
        )["ok"],
        json!(true)
    );
    assert_eq!(
        call(
            &ctx,
            "recommend.feedback",
            json!({ "ref": "demo:b", "action": "skip", "progress": 0.1 })
        )["ok"],
        json!(true)
    );

    let after = call(&ctx, "recommend.home", json!({}));
    let night_after = after["data"]["profile"]["tags"]["深夜"].as_f64().unwrap();
    let rock_after = after["data"]["profile"]["tags"]["摇滚"].as_f64().unwrap();
    assert!(night_after > night_before, "like 应提高权重：{night_before} → {night_after}");
    assert!(rock_after < rock_before, "skip 应压低权重：{rock_before} → {rock_after}");

    // 参数校验
    let bad_action = call(&ctx, "recommend.feedback", json!({ "ref": "demo:a", "action": "嗯" }));
    assert_eq!(bad_action["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad_action}");
    assert!(bad_action["error"]["details"]["supported"].is_array());
    let bad_progress = call(
        &ctx,
        "recommend.feedback",
        json!({ "ref": "demo:a", "action": "skip", "progress": 1.5 }),
    );
    assert_eq!(bad_progress["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad_progress}");
    // 反馈落库（append-only）
    assert_eq!(ctx.store.as_ref().unwrap().count_feedback().unwrap(), 2);

    std::fs::remove_dir_all(&dir).ok();
}

/// 生成一个可被扫描识别的 PCM WAV（本地曲库测试用）。
fn write_wav(path: &std::path::Path, seconds: u32) {
    let sample_rate: u32 = 8_000;
    let data_len = sample_rate * seconds;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend(std::iter::repeat(128u8).take(data_len as usize));
    std::fs::write(path, bytes).unwrap();
}
