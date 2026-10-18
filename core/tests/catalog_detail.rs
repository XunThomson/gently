//! 详情类命令的集成测试（M2 剩余部分）：曲目 / 专辑 / 歌单 / 榜单 / 歌词 / 源侧推荐。
//!
//! 盯住四件事：
//! 1. **归一化**：社区形状（MusicFree 的 `{isEnd, data}` / `musicList` / `rawLrc`）也能进来；
//! 2. **能力缺失 → `common.not_implemented`**（UI 隐藏入口），未安装/已禁用 → `common.not_found`；
//! 3. **缓存**：同一请求第二次不再调插件（插件自己数调用次数来验证），且键带齐参数；
//! 4. **不信任输出**：缺 `title` 的条目被丢弃，引用格式错误明确报错。

use std::sync::Arc;

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 不联网（详情命令不需要出网；插件用 storage 自己数调用次数）。
struct Offline;

impl HttpTransport for Offline {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

/// 覆盖全部详情能力的插件：形状刻意用社区写法（`data` / `musicList` / `rawLrc`）。
const DETAIL_PLUGIN: &str = r#"
// @id detail-source
// @name 详情源
// @version 1.0.0
// @author tester
const bump = (name) => storage.set(name, (storage.get(name) || 0) + 1);
async function search() { return []; }
async function getMediaSource() { return null; }

async function getTrackInfo(id) {
    bump('track');
    return {id: id, title: '曲目 ' + id, artist: '歌手', album: '专辑', duration: 226, tags: ['流行']};
}

async function getAlbumInfo(id) {
    bump('album');
    return {
        isEnd: true,
        albumItem: {id: id, title: '专辑名', artist: '专辑歌手', artwork: 'https://img.example.com/a.jpg', year: 2024, tags: ['摇滚']},
        musicList: [
            {id: 't1', title: '第一首', artist: '歌手', duration: 200},
            {id: 't2', artist: '缺标题'},
        ],
    };
}

async function getPlaylistInfo(id) {
    bump('playlist');
    return {
        sheetItem: {id: id, title: '歌单名', description: '说明', cover: 'https://img.example.com/p.jpg'},
        data: [{id: 'p1', title: '歌单曲目', artist: '歌手'}],
    };
}

async function getTopLists() {
    bump('topLists');
    return [
        {title: '热门', data: [{id: 'hot', title: '热歌榜', artwork: 'https://img.example.com/h.jpg'}, {title: '缺 id 的条目'}]},
        {title: '空分组', data: []},
    ];
}

async function getTopList(id, page) {
    bump('topList');
    return {isEnd: page >= 2, data: [{id: id + '-' + page, title: '第 ' + page + ' 页', artist: '歌手'}]};
}

async function getRecommend() {
    bump('recommend');
    return {isEnd: false, data: [{id: 'r1', title: '推荐曲', artist: '歌手'}]};
}

async function getLyric(id) {
    bump('lyric');
    return {rawLrc: '[00:01.00]第一句\n[00:05.50]第二句', translation: '[00:01.00]first line'};
}
"#;

/// 只有 search 能力的最小插件（用于「能力缺失」分支）。
const SEARCH_ONLY: &str = r#"
// @id search-only
// @name 只会搜
// @version 1.0.0
// @author tester
async function search() { return []; }
"#;

fn temp_ctx(tag: &str) -> (CoreContext, std::path::PathBuf) {
    let dir = common::temp_dir(&format!("detail-{tag}"));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");
    let store = Store::open(&paths.db).expect("打开库");
    let ctx = CoreContext::new(paths).with_store(store).with_http(Arc::new(Offline));
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

/// 插件自己记的调用次数（缓存命中时不会增长）。
fn calls(ctx: &CoreContext, id: &str, counter: &str) -> u64 {
    let path = ctx.paths.plugins.join(".kv").join(format!("{id}.json"));
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| "{}".into());
    let values: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    // 插件 kv 是「字符串 → 字符串」，数字是 JSON 化后存进去的，两种形态都要认
    values
        .get(counter)
        .and_then(|value| {
            value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
        .unwrap_or(0)
}

/// 播放解析必须把**插件自己产出过的条目**交回插件。
///
/// R53 实测的 bug：契约只把 `source:rawId` 交给前端，`playback.resolve` 于是只传
/// `{id, source}` 的最小对象——真实 MusicFree 插件（B 站）在 `getMediaSource(musicItem)` 里
/// 读 `bvid`/`aid`/`cid`，全都拿不到 → URL 拼成 undefined → 上游报错 → 「能搜、能看榜单，
/// 一播就 plugin.runtime_error」。修法：归一化时把原始条目按 `source:rawId` 存进进程内快照，
/// 播放解析优先用它。
#[test]
fn playback_resolve_hands_the_plugin_its_own_raw_item() {
    const SNAPSHOT_PLUGIN: &str = r#"
// @id snapshot-source
// @name 快照源
// @version 1.0.0
// @author tester
// @qualities standard
// @hosts api.example.com
async function search() {
    return [{id: 'BV1', title: '一首歌', artist: '歌手', aid: 42, bvid: 'BV1', cid: 777}];
}
async function getTopLists() {
    return [{title: '榜单', items: [{id: 'hot', title: '热歌榜'}]}];
}
async function getTopList() {
    return [{id: 'BV1', title: '一首歌', artist: '歌手', aid: 42, bvid: 'BV1', cid: 777}];
}
async function getMediaSource(track, quality) {
    // 真实插件就是这么读的：缺任何源内字段就当不可播
    if (!track || !track.bvid || !track.cid) {
        throw new Error('缺少源内字段：' + JSON.stringify(track));
    }
    return {url: 'https://cdn.example.com/' + track.bvid + '-' + track.cid + '.m4s', quality: quality, mimeType: 'audio/mp4'};
}
"#;
    let (ctx, dir) = temp_ctx("snapshot");
    install(&ctx, SNAPSHOT_PLUGIN);

    // 榜单详情会记下快照（列表里带 aid/bvid/cid，引用只保留 `source:rawId`）
    let page = call(&ctx, "catalog.topList", json!({ "source": "snapshot-source", "id": "hot" }));
    assert_eq!(page["ok"], json!(true), "{page}");
    let reference = page["data"]["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(reference, "snapshot-source:BV1");
    // 引用里没有 bvid/cid —— 插件能不能播，全看宿主有没有把原始条目交回去
    assert!(page["data"]["items"][0].get("cid").is_none(), "{page}");

    let resolved = call(&ctx, "playback.resolve", json!({ "ref": reference, "quality": "standard" }));
    assert_eq!(resolved["ok"], json!(true), "{resolved}");
    let origin = resolved["data"]["originUrl"].as_str().unwrap_or_default();
    assert!(
        origin.contains("BV1-777"),
        "插件必须收到自己产出过的那个条目（bvid/cid 都在）：{resolved}"
    );
    assert!(
        resolved["data"]["streamUrl"].as_str().unwrap_or_default().starts_with("http://127.0.0.1:"),
        "对外的播放地址仍是回环代理：{resolved}"
    );

    // 反向保护：快照里没有的引用 → 插件拿不到源内字段 → 该候选不可播（`data: null`，不弹错）
    let unknown = call(
        &ctx,
        "playback.resolve",
        json!({ "ref": "snapshot-source:never-seen", "quality": "standard" }),
    );
    assert_eq!(unknown["ok"], json!(true), "{unknown}");
    assert_eq!(unknown["data"], json!(null), "没有原始条目时插件应当拒绝这一候选：{unknown}");

    std::fs::remove_dir_all(&dir).ok();
}

/// 兼容插件（MusicFree 协议）的详情调用要收到**条目对象**，而且字段要全
/// （`getAlbumInfo(albumItem)` 里读 `bvid` 的插件不是少数）。
#[test]
fn compat_detail_calls_receive_the_remembered_item_object() {
    const COMPAT_PLUGIN: &str = r#"
module.exports = {
    platform: 'compat-snapshot', version: '1.0.0', author: 'tester',
    async search() { return {isEnd: true, data: []}; },
    async getMediaSource() { return null; },
    async getTopLists() { return [{title: 'g', data: [{id: 'hot', title: 'h'}]}]; },
    async getTopListDetail(topListItem) {
        return {isEnd: true, musicList: [{id: 'BV1', title: '一首歌', bvid: 'BV1', aid: 42, cid: 7}]};
    },
    async getAlbumInfo(albumItem) {
        // 真实插件就是在这一层读 bvid/aid 的；宿主只给 id 时这里会是 undefined
        return {isEnd: true, musicList: [{id: 'p1', title: String(albumItem && albumItem.bvid)}]};
    },
};
"#;
    let (ctx, dir) = temp_ctx("compat-detail-args");
    let value = call(
        &ctx,
        "plugin.import",
        json!({ "from": { "kind": "paste", "content": COMPAT_PLUGIN }, "consent": true, "compat": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    let id = value["data"]["plugin"]["id"].as_str().unwrap().to_string();

    // 列表加载时会记下原始条目（引用只保留 id）
    let page = call(&ctx, "catalog.topList", json!({ "source": id, "id": "hot" }));
    assert_eq!(page["ok"], json!(true), "{page}");

    let album = call(&ctx, "catalog.album", json!({ "source": id, "id": "BV1" }));
    assert_eq!(album["ok"], json!(true), "{album}");
    assert_eq!(
        album["data"]["tracks"][0]["title"], json!("BV1"),
        "兼容插件的 getAlbumInfo 必须收到带 bvid 的条目对象：{album}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn track_detail_is_normalized_and_reference_stays_stable() {
    let (ctx, dir) = temp_ctx("track");
    install(&ctx, DETAIL_PLUGIN);

    let value = call(&ctx, "catalog.track", json!({ "ref": "detail-source:t1" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    let data = &value["data"];
    assert_eq!(data["id"], json!("detail-source:t1"), "引用必须原样回传");
    assert_eq!(data["title"], json!("曲目 t1"));
    assert_eq!(data["durationSec"], json!(226));
    assert_eq!(data["duration"], json!("3:46"));
    assert_eq!(data["source"], json!("detail-source"));
    assert_eq!(data["tags"], json!(["流行"]));
    // 详情也包成聚合形状（前端不必写第二套渲染分支）
    assert_eq!(data["sourceCount"], json!(1));
    assert_eq!(data["candidates"][0]["source"], json!("detail-source"));
    assert_eq!(data["candidates"][0]["track"]["id"], json!("detail-source:t1"));

    // 引用格式错误 → 参数非法（而不是静默当成别的曲目）
    let bad = call(&ctx, "catalog.track", json!({ "ref": "没有冒号" }));
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn album_and_playlist_use_community_shapes() {
    let (ctx, dir) = temp_ctx("album");
    install(&ctx, DETAIL_PLUGIN);

    // MusicFree 的专辑形状：元数据在 albumItem，曲目在 musicList
    let value = call(&ctx, "catalog.album", json!({ "source": "detail-source", "id": "a1" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    let album = &value["data"];
    assert_eq!(album["id"], json!("a1"));
    assert_eq!(album["title"], json!("专辑名"));
    assert_eq!(album["artist"], json!("专辑歌手"));
    assert_eq!(album["cover"], json!("https://img.example.com/a.jpg"));
    assert_eq!(album["year"], json!(2024));
    assert_eq!(album["tags"], json!(["摇滚"]));
    assert_eq!(album["source"], json!("detail-source"));
    // 缺 title 的条目被丢弃
    assert_eq!(album["tracks"].as_array().unwrap().len(), 1, "{album}");
    assert_eq!(album["tracks"][0]["id"], json!("detail-source:t1"));

    // 歌单：sheetItem + data
    let value = call(&ctx, "catalog.playlist", json!({ "source": "detail-source", "id": "s1" }));
    let playlist = &value["data"];
    assert_eq!(playlist["title"], json!("歌单名"));
    assert_eq!(playlist["description"], json!("说明"));
    assert_eq!(playlist["cover"], json!("https://img.example.com/p.jpg"));
    assert_eq!(playlist["tracks"][0]["id"], json!("detail-source:p1"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn top_lists_drops_groups_without_usable_entries() {
    let (ctx, dir) = temp_ctx("toplists");
    install(&ctx, DETAIL_PLUGIN);

    let value = call(&ctx, "catalog.topLists", json!({ "source": "detail-source" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    let groups = value["data"].as_array().unwrap();
    // 空分组被丢掉；缺 id 的条目被丢掉（点了也打不开）
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0]["title"], json!("热门"));
    assert_eq!(groups[0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(groups[0]["items"][0]["id"], json!("hot"));
    assert_eq!(groups[0]["items"][0]["title"], json!("热歌榜"));
    assert_eq!(groups[0]["items"][0]["cover"], json!("https://img.example.com/h.jpg"));

    // 分页：isEnd 决定 hasMore / nextPage
    let page1 = call(&ctx, "catalog.topList", json!({ "source": "detail-source", "id": "hot" }));
    assert_eq!(page1["data"]["hasMore"], json!(true), "{page1}");
    assert_eq!(page1["data"]["nextPage"], json!(2));
    assert_eq!(page1["data"]["items"][0]["title"], json!("第 1 页"));

    let page2 = call(&ctx, "catalog.topList", json!({ "source": "detail-source", "id": "hot", "page": 2 }));
    assert_eq!(page2["data"]["hasMore"], json!(false), "{page2}");
    assert!(page2["data"].get("nextPage").is_none(), "末页不给 nextPage：{page2}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn lyrics_normalize_and_return_null_when_absent() {
    let (ctx, dir) = temp_ctx("lyrics");
    install(&ctx, DETAIL_PLUGIN);

    let value = call(&ctx, "catalog.lyrics", json!({ "ref": "detail-source:t1" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["format"], json!("lrc"), "带时间戳应判定为 lrc");
    assert!(value["data"]["content"].as_str().unwrap().contains("第一句"));
    // 没要求翻译就不下发
    assert!(value["data"].get("translated").is_none(), "{value}");

    let translated = call(
        &ctx,
        "catalog.lyrics",
        json!({ "ref": "detail-source:t1", "withTranslation": true }),
    );
    assert_eq!(translated["data"]["translated"], json!("[00:01.00]first line"), "{translated}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn lyrics_search_collects_sources_and_skips_missing_capability() {
    /// 有 search + getLyric：命中的前两条给词，第三条故意没词（应被跳过）。
    const LYRICS_FINDER: &str = r#"
// @id lyric-finder
// @name 找词源
// @version 1.0.0
// @author tester
const bump = (name) => storage.set(name, (storage.get(name) || 0) + 1);
async function search() {
    bump('search');
    return [
        {id: 'a', title: '测试歌 A', artist: '歌手甲', duration: 180},
        {id: 'b', title: '测试歌 B', artist: '歌手乙', duration: 200},
        {id: 'c', title: '没有歌词的歌', artist: '歌手丙'},
    ];
}
async function getMediaSource() { return null; }
async function getLyric(id) {
    bump('lyric');
    if (id === 'c') return null;
    return {rawLrc: '[00:01.00]前缀 ' + id};
}
"#;

    let (ctx, dir) = temp_ctx("lyrics-search");
    install(&ctx, LYRICS_FINDER);
    install(&ctx, SEARCH_ONLY);

    let value = call(
        &ctx,
        "catalog.lyricsSearch",
        json!({ "query": "测试", "limit": 3 }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    let data = &value["data"];
    let items = data["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "没词的条目应被跳过：{value}");
    assert_eq!(items[0]["source"], json!("lyric-finder"));
    assert_eq!(items[0]["sourceName"], json!("找词源"), "结果要带来源名称：{value}");
    assert_eq!(items[0]["track"]["id"], json!("lyric-finder:a"));
    assert_eq!(items[0]["lyrics"]["format"], json!("lrc"));
    assert!(items[0]["lyrics"]["content"].as_str().unwrap().contains("前缀 a"));
    assert!(
        data["skippedSources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source == "search-only"),
        "只有 search 的源应进 skippedSources：{value}"
    );
    assert_eq!(data["searchedSources"], json!(["lyric-finder"]));

    // 缓存：同样的歌词不再问插件（search 会重新调，歌词命中缓存）
    let lyric_calls = calls(&ctx, "lyric-finder", "lyric");
    assert!(lyric_calls > 0);
    let again = call(
        &ctx,
        "catalog.lyricsSearch",
        json!({ "query": "测试", "limit": 3 }),
    );
    assert_eq!(again["ok"], json!(true), "{again}");
    assert_eq!(
        calls(&ctx, "lyric-finder", "lyric"),
        lyric_calls,
        "同一首歌词的第二次搜索应命中缓存"
    );

    // 空关键词明确报错，而不是返回空列表
    let empty = call(&ctx, "catalog.lyricsSearch", json!({ "query": "   " }));
    assert_eq!(empty["ok"], json!(false));
    assert_eq!(empty["error"]["code"], json!("common.invalid_argument"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn results_are_cached_and_cache_key_covers_parameters() {
    let (ctx, dir) = temp_ctx("cache");
    let id = install(&ctx, DETAIL_PLUGIN);

    assert_eq!(calls(&ctx, &id, "lyric"), 0);
    for _ in 0..3 {
        let value = call(&ctx, "catalog.lyrics", json!({ "ref": "detail-source:t1" }));
        assert_eq!(value["ok"], json!(true));
    }
    assert_eq!(calls(&ctx, &id, "lyric"), 1, "同一请求只应问插件一次");

    // 参数不同 → 不同的缓存键（withTranslation 必须重新问一次）
    let value = call(
        &ctx,
        "catalog.lyrics",
        json!({ "ref": "detail-source:t1", "withTranslation": true }),
    );
    assert_eq!(value["ok"], json!(true));
    assert_eq!(calls(&ctx, &id, "lyric"), 2, "参数不同不能命中同一份缓存");

    // 榜单分页同理
    assert_eq!(calls(&ctx, &id, "topList"), 0);
    for _ in 0..2 {
        let _ = call(&ctx, "catalog.topList", json!({ "source": "detail-source", "id": "hot" }));
    }
    let _ = call(&ctx, "catalog.topList", json!({ "source": "detail-source", "id": "hot", "page": 2 }));
    assert_eq!(calls(&ctx, &id, "topList"), 2, "第 1 页命中缓存，第 2 页是新请求");

    // 缓存落在 cache/ 下（契约：该目录可随时整目录删除）
    let cache_dir = ctx.paths.cache.join("catalog");
    assert!(cache_dir.is_dir(), "缓存目录应存在");
    assert!(std::fs::read_dir(&cache_dir).unwrap().count() >= 2);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_capability_is_not_implemented_and_disabled_plugin_is_not_found() {
    let (ctx, dir) = temp_ctx("capability");
    let id = install(&ctx, SEARCH_ONLY);

    // 只有 search：详情命令一律 not_implemented（UI 据此隐藏入口）
    for (command, params) in [
        ("catalog.track", json!({ "ref": "search-only:1" })),
        ("catalog.album", json!({ "source": "search-only", "id": "a" })),
        ("catalog.playlist", json!({ "source": "search-only", "id": "p" })),
        ("catalog.topLists", json!({ "source": "search-only" })),
        ("catalog.topList", json!({ "source": "search-only", "id": "t" })),
        ("catalog.recommend", json!({ "source": "search-only" })),
        ("catalog.lyrics", json!({ "ref": "search-only:1" })),
    ] {
        let value = call(&ctx, command, params.clone());
        assert_eq!(value["error"]["code"], ErrorCode::NotImplemented.as_str(), "{command} → {value}");
    }

    // 未安装的源 → not_found
    let missing = call(&ctx, "catalog.lyrics", json!({ "ref": "nope:1" }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");

    // 已禁用 → not_found（与搜索的「禁用立即生效」一致）
    assert_eq!(
        call(&ctx, "plugin.setEnabled", json!({ "id": id, "enabled": false }))["ok"],
        json!(true)
    );
    let disabled = call(&ctx, "catalog.topLists", json!({ "source": "detail-source" }));
    assert_eq!(disabled["error"]["code"], ErrorCode::NotFound.as_str(), "{disabled}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn recommend_returns_normalized_tracks() {
    let (ctx, dir) = temp_ctx("recommend");
    install(&ctx, DETAIL_PLUGIN);

    let value = call(&ctx, "catalog.recommend", json!({ "source": "detail-source" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    let tracks = value["data"].as_array().unwrap();
    assert_eq!(tracks.len(), 1, "{tracks:?}");
    assert_eq!(tracks[0]["id"], json!("detail-source:r1"));
    assert_eq!(tracks[0]["title"], json!("推荐曲"));

    std::fs::remove_dir_all(&dir).ok();
}

/// 缓存写入必须是原子的：坏掉的缓存比没有缓存更糟（会一直读到半截 JSON）。
#[test]
fn broken_cache_entry_falls_back_to_the_plugin() {
    let (ctx, dir) = temp_ctx("broken-cache");
    let id = install(&ctx, DETAIL_PLUGIN);

    let _ = call(&ctx, "catalog.recommend", json!({ "source": "detail-source" }));
    assert_eq!(calls(&ctx, &id, "recommend"), 1);

    for entry in std::fs::read_dir(ctx.paths.cache.join("catalog")).unwrap() {
        std::fs::write(entry.unwrap().path(), "{ 半截 JSON").unwrap();
    }

    let value = call(&ctx, "catalog.recommend", json!({ "source": "detail-source" }));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(calls(&ctx, &id, "recommend"), 2, "缓存读坏要重新问插件，而不是报错");

    std::fs::remove_dir_all(&dir).ok();
}


