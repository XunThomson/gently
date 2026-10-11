//! 本机库命令的集成测试（M3a）：收藏 / 歌单 / 播放历史。
//!
//! 盯住四件事：
//! 1. **持久化**：重启（重新打开库）后数据仍在——这是本机库存在的意义；
//! 2. **引用是去重键**：字符串与 `TrackRef` 对象两种入参归一化成同一个引用；
//! 3. **快照**：调用方带来的 `Track` 存下来；没带就退化成占位曲目（不调插件、不失败）；
//! 4. **游标分页**：`nextCursor` 回传不重不漏，`hasMore` 与实际一致。

use std::sync::Arc;

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 库命令不需要出网：任何请求都失败（顺便证明写入路径不依赖网络）。
struct Offline;

impl HttpTransport for Offline {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-library-{tag}"))
}

/// 每次都重新打开库：用来验证「重启后数据仍在」。
fn ctx_at(paths: &AppPaths) -> CoreContext {
    let store = Store::open(&paths.db).expect("打开库");
    CoreContext::new(paths.clone()).with_store(store).with_http(Arc::new(Offline))
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn track(id: &str, title: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "artist": "歌手",
        "album": "专辑",
        "duration": "3:20",
        "durationSec": 200,
        "source": "demo",
        "gradient": "linear-gradient(#111, #222)",
        "tags": ["流行"],
    })
}

#[test]
fn favorites_persist_and_accept_both_reference_shapes() {
    let dir = temp_dir("favorites");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths);

    // 1) 字符串引用 + 快照
    let value = call(
        &ctx,
        "library.favorites.set",
        json!({ "ref": "demo:a", "favorite": true, "track": track("demo:a", "甲") }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["favorite"], json!(true));

    // 2) TrackRef 对象（前端契约形状）+ 缺 track 快照 → 占位曲目
    let value = call(
        &ctx,
        "library.favorites.set",
        json!({
            "ref": {"id": "demo:b", "source": "demo", "sourceTrackId": "b"},
            "favorite": true,
        }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");

    // 3) 只有 sourceTrackId 也要能拼出引用
    let value = call(
        &ctx,
        "library.favorites.set",
        json!({ "ref": {"source": "demo", "sourceTrackId": "c"}, "favorite": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");

    let listed = call(&ctx, "library.favorites.list", json!({}));
    let items = listed["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 3, "{listed}");
    assert_eq!(listed["data"]["total"], json!(3));
    assert_eq!(listed["data"]["hasMore"], json!(false));
    assert!(listed["data"].get("nextCursor").is_none());

    // 快照来自调用方：标题/歌手/时长都完整，且包成 GroupedTrack（视图复用搜索结果那套渲染）
    let first = items.iter().find(|item| item["id"] == json!("demo:a")).unwrap();
    assert_eq!(first["title"], json!("甲"));
    assert_eq!(first["artist"], json!("歌手"));
    assert_eq!(first["durationSec"], json!(200));
    assert_eq!(first["sourceCount"], json!(1));
    assert_eq!(first["candidates"][0]["source"], json!("demo"));

    // 没带快照的那条退化成占位曲目：引用仍在、标题 = rawId（不调插件、不报错）
    let placeholder = items.iter().find(|item| item["id"] == json!("demo:b")).unwrap();
    assert_eq!(placeholder["title"], json!("b"));
    assert_eq!(placeholder["durationSec"], json!(0));

    // 4) 引用格式错误 → 明确报错（而不是存一行永远对不上的数据）
    for bad in [json!("没有冒号"), json!({"source": "demo"}), json!({"id": "demo:x"})] {
        let value = call(&ctx, "library.favorites.set", json!({ "ref": bad, "favorite": true }));
        assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad} → {value}");
    }

    // 5) 重启：数据仍在，且取消收藏是幂等的
    let restarted = ctx_at(&paths);
    let listed = call(&restarted, "library.favorites.list", json!({}));
    assert_eq!(listed["data"]["items"].as_array().unwrap().len(), 3, "重启后收藏必须还在");
    let value = call(&restarted, "library.favorites.set", json!({ "ref": "demo:a", "favorite": false }));
    assert_eq!(value["data"]["favorite"], json!(false));
    // 再取消一次同样成功（幂等）
    let value = call(&restarted, "library.favorites.set", json!({ "ref": "demo:a", "favorite": false }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(
        call(&restarted, "library.favorites.list", json!({}))["data"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn favorites_paginate_with_an_opaque_cursor() {
    let dir = temp_dir("favorites-page");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths);

    for index in 0..5 {
        let reference = format!("demo:{index}");
        let value = call(
            &ctx,
            "library.favorites.set",
            json!({ "ref": reference, "favorite": true, "track": track(&format!("demo:{index}"), "歌") }),
        );
        assert_eq!(value["ok"], json!(true));
    }

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..4 {
        let params = match &cursor {
            Some(cursor) => json!({ "limit": 2, "cursor": cursor }),
            None => json!({ "limit": 2 }),
        };
        let page = call(&ctx, "library.favorites.list", params);
        let data = &page["data"];
        for item in data["items"].as_array().unwrap() {
            seen.push(item["id"].as_str().unwrap().to_string());
        }
        match data["nextCursor"].as_str() {
            Some(next) => {
                assert_eq!(data["hasMore"], json!(true), "给了游标就必须说还有下一页：{page}");
                cursor = Some(next.to_string());
            }
            None => {
                assert_eq!(data["hasMore"], json!(false));
                break;
            }
        }
    }
    assert_eq!(seen.len(), 5, "翻页不重不漏：{seen:?}");
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 5, "不能出现重复条目：{seen:?}");

    // 每页都用同一个 total（前端据此显示总数）
    let page = call(&ctx, "library.favorites.list", json!({ "limit": 2 }));
    assert_eq!(page["data"]["total"], json!(5));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn history_keeps_every_play_and_reports_counts() {
    let dir = temp_dir("history");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths);

    for _ in 0..3 {
        let value = call(
            &ctx,
            "library.history.push",
            json!({ "ref": "demo:a", "playedSec": 42, "completed": false, "track": track("demo:a", "甲") }),
        );
        assert_eq!(value["ok"], json!(true), "{value}");
    }
    assert_eq!(
        call(
            &ctx,
            "library.history.push",
            json!({ "ref": {"id": "demo:b", "source": "demo", "sourceTrackId": "b"}, "playedSec": 200, "completed": true,
                    "track": track("demo:b", "乙") }),
        )["ok"],
        json!(true)
    );

    let listed = call(&ctx, "library.history.list", json!({}));
    let items = listed["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 4, "每次播放都留一行");
    assert_eq!(listed["data"]["total"], json!(4));

    let first = items.iter().find(|row| row["id"] == json!("demo:a")).unwrap();
    assert_eq!(first["playCount"], json!(3), "同一首歌的累计次数");
    assert_eq!(first["playedSec"], json!(42));
    assert_eq!(first["completed"], json!(false));
    assert!(first["playedAt"].is_number());
    assert_eq!(first["title"], json!("甲"), "历史要带曲目快照（离线也能列）");

    // 缺参数时用兜底值（不因为界面漏传就失败）
    let value = call(&ctx, "library.history.push", json!({ "ref": "demo:c" }));
    assert_eq!(value["ok"], json!(true), "{value}");

    // 空 ref → 参数非法
    let value = call(&ctx, "library.history.push", json!({ "ref": "" }));
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");

    std::fs::remove_dir_all(&dir).ok();
}

/// `library.history.clear`：清空播放记录，但**不动收藏与歌单**。
#[test]
fn history_can_be_cleared_without_touching_favorites() {
    let dir = temp_dir("history-clear");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths);

    call(
        &ctx,
        "library.history.push",
        json!({ "ref": "demo:a", "playedSec": 10, "completed": false, "track": track("demo:a", "甲") }),
    );
    assert_eq!(
        call(&ctx, "library.favorites.set", json!({ "ref": "demo:a", "favorite": true, "track": track("demo:a", "甲") }))["ok"],
        json!(true)
    );
    assert_eq!(call(&ctx, "library.playlists.save", json!({ "name": "歌单", "trackRefs": ["demo:a"] }))["ok"], json!(true));

    let cleared = call(&ctx, "library.history.clear", json!({}));
    assert_eq!(cleared["ok"], json!(true), "{cleared}");
    assert_eq!(cleared["data"]["removed"], json!(1));
    assert_eq!(call(&ctx, "library.history.list", json!({}))["data"]["total"], json!(0));
    // 收藏与歌单不受影响
    assert_eq!(call(&ctx, "library.favorites.list", json!({}))["data"]["total"], json!(1));
    assert_eq!(call(&ctx, "library.playlists.list", json!({}))["data"].as_array().unwrap().len(), 1);
    // 再清一次：0 条也成功（幂等）
    assert_eq!(call(&ctx, "library.history.clear", json!({}))["data"]["removed"], json!(0));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn playlists_create_update_and_delete() {
    let dir = temp_dir("playlists");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths);

    let created = call(
        &ctx,
        "library.playlists.save",
        json!({
            "name": "我的歌单",
            "trackRefs": ["demo:a", {"id": "demo:b", "source": "demo", "sourceTrackId": "b"}],
            "tracks": [track("demo:a", "甲")],
        }),
    );
    assert_eq!(created["ok"], json!(true), "{created}");
    let id = created["data"]["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("pl-"), "id 由核心生成：{id}");
    assert_eq!(created["data"]["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(created["data"]["tracks"][0]["title"], json!("甲"), "带快照的用快照");
    assert_eq!(created["data"]["tracks"][1]["title"], json!("b"), "没快照的用占位");

    // 重复引用只留一次（界面重复添加是常见误操作）
    let deduped = call(
        &ctx,
        "library.playlists.save",
        json!({ "id": id, "name": "我的歌单", "trackRefs": ["demo:a", "demo:a"] }),
    );
    assert_eq!(deduped["data"]["tracks"].as_array().unwrap().len(), 1, "{deduped}");

    // 顺序是用户数据：整体替换后顺序即传入顺序
    let updated = call(
        &ctx,
        "library.playlists.save",
        json!({
            "id": id,
            "name": "改名了",
            "trackRefs": ["demo:b", "demo:a"],
            "tracks": [track("demo:b", "乙"), track("demo:a", "甲")],
        }),
    );
    assert_eq!(updated["data"]["name"], json!("改名了"));
    let tracks = updated["data"]["tracks"].as_array().unwrap();
    assert_eq!(tracks[0]["id"], json!("demo:b"));
    assert_eq!(tracks[1]["id"], json!("demo:a"));

    // 重启后仍在（含顺序）
    let restarted = ctx_at(&paths);
    let listed = call(&restarted, "library.playlists.list", json!({}));
    assert_eq!(listed["data"].as_array().unwrap().len(), 1, "重启后歌单必须还在");
    assert_eq!(listed["data"][0]["tracks"][0]["id"], json!("demo:b"));

    // 空名字、覆盖不存在的歌单 → 参数非法 / 未找到
    let value = call(&ctx, "library.playlists.save", json!({ "name": "   ", "trackRefs": [] }));
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");
    let value = call(
        &ctx,
        "library.playlists.save",
        json!({ "id": "pl-nope", "name": "x", "trackRefs": [] }),
    );
    assert_eq!(value["error"]["code"], ErrorCode::NotFound.as_str(), "{value}");

    // 删除：曲目随外键级联
    assert_eq!(call(&ctx, "library.playlists.delete", json!({ "id": id }))["ok"], json!(true));
    assert_eq!(call(&ctx, "library.playlists.list", json!({}))["data"], json!([]));
    let value = call(&ctx, "library.playlists.delete", json!({ "id": id }));
    assert_eq!(value["error"]["code"], ErrorCode::NotFound.as_str(), "重复删除要明确报错");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn database_unavailable_reports_library_io_error() {
    let dir = temp_dir("no-store");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = CoreContext::new(paths.clone()).with_http(Arc::new(Offline));

    for (command, params) in [
        ("library.favorites.list", json!({})),
        ("library.playlists.list", json!({})),
        ("library.history.list", json!({})),
    ] {
        let value = call(&ctx, command, params);
        assert_eq!(value["error"]["code"], ErrorCode::LibraryIoError.as_str(), "{command} → {value}");
    }
    // 写入同样要有明确错误（而不是写进内存假装成功）
    let value = call(&ctx, "library.favorites.set", json!({ "ref": "demo:a", "favorite": true }));
    assert_eq!(value["error"]["code"], ErrorCode::LibraryIoError.as_str(), "{value}");

    std::fs::remove_dir_all(&dir).ok();
}
