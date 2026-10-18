//! 详情类命令：曲目 / 专辑 / 歌单 / 榜单 / 歌词 / 源侧推荐（M2 剩余部分）。
//!
//! 与 `catalog::search` 同一套原则：
//! - **不信任插件输出**：一律经 `catalog::normalize_track` 归一化，缺字段给兜底值、缺 `id` 丢弃；
//! - **列表形状适配**：`plugin::list_items` 负责 `[...]` / `{items}` / `{isEnd, data}` /
//!   `{isEnd, musicList}` 四种写法（兼容 MusicFree 生态，ADR-0006）；
//! - **能力缺失 → `common.not_implemented`**：UI 据此隐藏入口，而不是报错；
//! - **结果缓存**到 `cache/catalog/`（契约 §9 说明该目录可随时整目录删除，因此缓存键里
//!   必须带齐所有影响结果的参数）。
//!
//! 歌词**不在核心解析成行**：前端已有 LRC 解析器，同一算法只留一份实现
//! （契约里 `Lyrics.lines` 是「核心已解析时」的可选字段）。
//!
//! `catalog.lyricsSearch` 是「按关键词跨源找歌词」：源不提供歌词、各源歌名不一致时，
//! 用户能换一个源/换一个条目；**每个源一个线程**、整体有截止时间，慢源不拖死整页。

use std::collections::HashMap;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::catalog::ItemSnapshots;
use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::{list_items, PluginCapability, PluginHost};

/// 详情类缓存时长（曲目/专辑/歌单）。
const DETAIL_TTL_SEC: i64 = 6 * 60 * 60;
/// 歌词单独用更长的 TTL：歌词几乎不变，而它是**离线可播**的一部分——
/// 6 小时就过期的话，隔天断网就退化成「暂无歌词」。
const LYRICS_TTL_SEC: i64 = 30 * 24 * 60 * 60;
/// 榜单与分类树变化慢，可以缓存久一点。
const LIST_TTL_SEC: i64 = 24 * 60 * 60;

/// 歌词搜索：每个源最多取几个命中条目去问歌词（多了只会拖慢，不会更有用）。
const LYRICS_SEARCH_PER_SOURCE: usize = 2;
/// 歌词搜索的整体截止时间：慢源先不等了，返回已经拿到的结果。
const LYRICS_SEARCH_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, serde::Deserialize)]
struct RefParams {
    /// `source:trackId`
    #[serde(rename = "ref")]
    reference: String,
}

#[derive(Debug, serde::Deserialize)]
struct SourceIdParams {
    source: String,
    #[serde(default)]
    id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcePageParams {
    source: String,
    id: String,
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceOnlyParams {
    source: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcePageOnlyParams {
    source: String,
    #[serde(default)]
    page: Option<u32>,
    /// 选中的收藏夹 / 歌单 id（插件没实现 `getFavoriteCollections` 时留空 = 默认列表）
    #[serde(default)]
    collection_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricsParams {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    with_translation: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricsSearchParams {
    /// 关键词：歌名 / 歌手 / 两者混合，与搜索框语义一致
    query: String,
    /// 每个源最多取几个命中条目问歌词（1~5，缺省 2）
    #[serde(default)]
    limit: Option<u32>,
}

// ---------------------------------------------------------------- 命令

/// `catalog.track{ref}`：曲目详情。
///
/// 返回 `GroupedTrack | null`——详情只来自一个源，但仍包成聚合形状，
/// 前端不必为「详情」写第二套渲染分支。
pub fn track(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: RefParams = parse_params(params)?;
    let (source, raw_id) = split_ref(&params.reference)?;

    let value = call_detail(
        ctx,
        source,
        PluginCapability::GetTrackInfo,
        "getTrackInfo",
        json!([detail_item_arg(ctx, source, raw_id)]),
        &format!("track:{source}:{raw_id}"),
        DETAIL_TTL_SEC,
    )?;
    if value.is_null() {
        return Ok(Value::Null);
    }

    let object = inner_object(&value, &["track", "data", "song", "musicItem"]);
    let mut dropped = 0;
    let Some(mut item) = crate::catalog::normalize_track(source, object, &mut dropped) else {
        return Ok(Value::Null);
    };
    // 记快照：详情页点播放时用的引用是**请求时那个 ref**，插件返回的 id 可能与它不同
    ctx.snapshots.remember_raw(source, raw_id, object);
    // 引用必须稳定：插件返回的 id 可能被改写，统一回到请求里的 ref
    item["id"] = json!(params.reference);
    item["sourceCount"] = json!(1);
    item["candidates"] = json!([{
        "source": source,
        "track": item.clone(),
        "qualities": ["standard"],
    }]);
    Ok(item)
}

/// `catalog.album{source, id}`：专辑详情（含曲目）。
pub fn album(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourceIdParams = parse_params(params)?;
    let value = call_detail(
        ctx,
        &params.source,
        PluginCapability::GetAlbumInfo,
        "getAlbumInfo",
        json!([detail_item_arg(ctx, &params.source, &params.id)]),
        &format!("album:{}:{}", params.source, params.id),
        DETAIL_TTL_SEC,
    )?;
    if value.is_null() {
        return Ok(Value::Null);
    }

    let nested = nested_details(&value, &["albumItem", "album"]);
    let id = pick_text(&nested, &["id"]).unwrap_or_else(|| params.id.clone());
    Ok(json!({
        "id": id,
        "title": pick_text(&nested, &["title", "name"]).unwrap_or_else(|| params.id.clone()),
        "artist": pick_text(&nested, &["artist", "creator", "singer"]).unwrap_or_default(),
        "cover": pick_text(&nested, &["cover", "artwork", "pic"]).unwrap_or_default(),
        "year": pick_u64(&nested, &["year"]).unwrap_or(0),
        "tags": pick_strings(&nested, &["tags"]),
        "source": params.source,
        "tracks": detail_tracks(ctx, &params.source, &value),
    }))
}

/// `catalog.playlist{source, id}`：歌单详情（含曲目）。
pub fn playlist(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourceIdParams = parse_params(params)?;
    let value = call_detail(
        ctx,
        &params.source,
        PluginCapability::GetPlaylistInfo,
        "getPlaylistInfo",
        json!([detail_item_arg(ctx, &params.source, &params.id)]),
        &format!("playlist:{}:{}", params.source, params.id),
        DETAIL_TTL_SEC,
    )?;
    if value.is_null() {
        return Ok(Value::Null);
    }

    let nested = nested_details(&value, &["sheetItem", "playlist", "playlistItem"]);
    let id = pick_text(&nested, &["id"]).unwrap_or_else(|| params.id.clone());
    Ok(json!({
        "id": id,
        "title": pick_text(&nested, &["title", "name"]).unwrap_or_else(|| params.id.clone()),
        "description": pick_text(&nested, &["description", "desc"]).unwrap_or_default(),
        "cover": pick_text(&nested, &["cover", "artwork", "pic"]).unwrap_or_default(),
        "tags": pick_strings(&nested, &["tags"]),
        "source": params.source,
        "tracks": detail_tracks(ctx, &params.source, &value),
    }))
}

/// `catalog.topLists{source}`：**源自定义的**榜单/分类树（不是固定枚举）。
pub fn top_lists(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourceIdParams = parse_params(params)?;
    let value = call_detail(
        ctx,
        &params.source,
        PluginCapability::GetTopLists,
        "getTopLists",
        json!([]),
        &format!("topLists:{}", params.source),
        LIST_TTL_SEC,
    )?;

    let groups = list_items(&value).unwrap_or(&[]);
    let mut out = Vec::new();
    for group in groups {
        let items = list_items(group).unwrap_or(&[]);
        let entries: Vec<Value> = items
            .iter()
            .filter_map(|item| {
                // id 是入口的必需字段：没有 id 的条目点了也打不开
                let id = pick_text(&[item], &["id", "key"])?;
                let mut map = serde_json::Map::new();
                map.insert("id".into(), json!(id));
                map.insert(
                    "title".into(),
                    json!(pick_text(&[item], &["title", "name"])
                        .unwrap_or_else(|| id.clone())),
                );
                insert_opt(&mut map, "cover", pick_text(&[item], &["cover", "artwork", "pic"]));
                insert_opt(
                    &mut map,
                    "description",
                    pick_text(&[item], &["description", "desc"]),
                );
                Some(Value::Object(map))
            })
            .collect();
        // 空分组没有意义（前端会渲染出一个空标题）
        if entries.is_empty() {
            continue;
        }
        let mut map = serde_json::Map::new();
        insert_opt(&mut map, "title", pick_text(&[group], &["title", "name"]));
        map.insert("items".into(), json!(entries));
        out.push(Value::Object(map));
    }
    Ok(Value::Array(out))
}

/// `catalog.topList{source, id, page?}`：某个榜单/分类的一页。
pub fn top_list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourcePageParams = parse_params(params)?;
    let page = params.page.unwrap_or(1).max(1);

    let value = call_detail(
        ctx,
        &params.source,
        PluginCapability::GetTopList,
        "getTopList",
        json!([detail_item_arg(ctx, &params.source, &params.id), page]),
        &format!("topList:{}:{}:{page}", params.source, params.id),
        LIST_TTL_SEC,
    )?;

    // `isEnd` 是社区协议的分页标志（不填默认「已到末页」）；缺了就不猜「还有下一页」
    let has_more = value.get("isEnd").and_then(|flag| flag.as_bool()) == Some(false);
    let mut map = serde_json::Map::new();
    map.insert("items".into(), json!(detail_tracks(ctx, &params.source, &value)));
    map.insert("hasMore".into(), json!(has_more));
    if has_more {
        map.insert("nextPage".into(), json!(page + 1));
    }
    Ok(Value::Object(map))
}

/// `catalog.recommend{source}`：源侧推荐（**不是**我们的个性化推荐，那个在 M4）。
pub fn recommend(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourceIdParams = parse_params(params)?;
    let value = call_detail(
        ctx,
        &params.source,
        PluginCapability::GetRecommend,
        "getRecommend",
        json!([]),
        &format!("recommend:{}", params.source),
        LIST_TTL_SEC,
    )?;
    Ok(json!(detail_tracks(ctx, &params.source, &value)))
}

/// `catalog.favorites{source, page?}`：源侧「我收藏的歌曲」（第 68 条命令）。
///
/// 为什么**不缓存**：收藏是用户自己的状态，随时会被他在别处改动——缓存一分钟都可能显示
/// 已经取消的收藏。列表类详情（榜单/推荐）缓存 24 小时是合理的，这条不是。
///
/// 权限：源必须已安装、已启用、且实现了 `getFavorites`；缺能力 → `common.not_implemented`
/// （界面据此隐藏入口），未安装/已禁用 → `common.not_found`（与搜索一致「禁用立即生效」）。
/// 登录由插件自己负责：`@oauth` 插件的令牌经沙箱 `oauth.getAccessToken()` 取，cookie 类插件
/// 用清单声明的凭据字段——核心不掺和具体源的鉴权细节（ADR-0005 / ADR-0008）。
pub fn favorites(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourcePageOnlyParams = parse_params(params)?;
    ready_source(ctx, &params.source, PluginCapability::GetFavorites)?;

    // 页码从 1 开始（与 `getTopList` 一致）；0 或非法值按第一页处理
    let page = params.page.filter(|page| *page > 0).unwrap_or(1);
    // 收藏夹/歌单是「不同第三方不同策略」的落点：插件可以只实现默认列表（不传第二个参数），
    // 也可以先给出一组可选的收藏夹，由用户选中后带上 id
    let args = match params.collection_id.as_deref().filter(|id| !id.is_empty()) {
        Some(collection) => json!([page, collection]),
        None => json!([page]),
    };
    let raw = ctx.plugins.call(&params.source, "getFavorites", &args.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|err| {
        CoreError::new(ErrorCode::PluginRuntimeError, format!("getFavorites 返回的不是合法 JSON：{err}"))
            .with_details(json!({ "source": params.source }))
    })?;

    let tracks = detail_tracks(ctx, &params.source, &value);
    // `isEnd: false` 才认为还有下一页（社区协议；缺了这个字段不猜「还有更多」）
    let has_more = value.get("isEnd").and_then(|flag| flag.as_bool()) == Some(false);
    Ok(json!({
        "source": params.source,
        "collectionId": params.collection_id,
        "items": tracks,
        "hasMore": has_more,
        "nextPage": has_more.then_some(page + 1),
    }))
}

/// `catalog.favoriteCollections{source}`：源侧**可选的收藏夹/歌单**（第 69 条命令）。
///
/// 为什么需要它：不同第三方的「收藏」不是一个东西——有的一家只有一份收藏列表，
/// 有的是多个收藏夹（视频站的收藏夹/媒体列表）、有的是用户自建的多个歌单。卡片式
/// 单一列表满足不了后者：用户必须能**选中**自己要看的那一个。
///
/// 插件实现 `getFavoriteCollections()` 时返回 `[{id, title, count?}]`；**不实现也能用**
/// （`catalog.favorites` 直接用默认列表）——因此缺这个能力时这里返回空数组而不是报错，
/// 界面据此隐藏「收藏夹」选择器。同样**不缓存**（收藏夹名字与数量随时会变）。
pub fn favorite_collections(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SourceOnlyParams = parse_params(params)?;

    // 能力缺失 ≠ 故障：这是「该源只有一份默认收藏」，界面不该弹错误
    if !has_capability(ctx, &params.source, PluginCapability::GetFavoriteCollections)? {
        return Ok(json!({ "source": params.source, "items": [] }));
    }

    let raw = ctx.plugins.call(&params.source, "getFavoriteCollections", "[]")?;
    let value: Value = serde_json::from_str(&raw).map_err(|err| {
        CoreError::new(
            ErrorCode::PluginRuntimeError,
            format!("getFavoriteCollections 返回的不是合法 JSON：{err}"),
        )
        .with_details(json!({ "source": params.source }))
    })?;

    let items: Vec<Value> = list_items(&value)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            // id 是必需的：没有 id 的收藏夹选中了也没法取内容
            let id = pick_text(&[item], &["id", "key", "folderId", "mediaId"])?;
            let mut map = serde_json::Map::new();
            map.insert("id".into(), json!(id));
            map.insert(
                "title".into(),
                json!(pick_text(&[item], &["title", "name"]).unwrap_or_else(|| id.clone())),
            );
            if let Some(count) = item
                .get("count")
                .or_else(|| item.get("mediaCount"))
                .and_then(Value::as_u64)
            {
                map.insert("count".into(), json!(count));
            }
            Some(Value::Object(map))
        })
        .collect();

    Ok(json!({ "source": params.source, "items": items }))
}

/// `catalog.lyrics{ref, withTranslation?}`：歌词；**无词返回 `data: null`**（不是错误）。
pub fn lyrics(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: LyricsParams = parse_params(params)?;
    let (source, raw_id) = split_ref(&params.reference)?;

    let value = call_detail(
        ctx,
        source,
        PluginCapability::GetLyric,
        "getLyric",
        // MusicFree 的 `getLyric(musicItem)` 同样收条目对象；自有 ABI 收字符串 id
        json!([detail_item_arg(ctx, source, raw_id)]),
        &format!("lyrics:{source}:{raw_id}:{}", params.with_translation),
        LYRICS_TTL_SEC,
    )?;

    Ok(parse_lyric_value(&value, params.with_translation).unwrap_or(Value::Null))
}

/// `catalog.lyricsSearch{query, limit?}`：**跨源按关键词找歌词**。
///
/// 为什么需要它：歌词与歌曲是分离的——源不一定给歌词、各源同名歌曲的名称还可能不一致
/// （视频源常在标题里塞无关内容），自动拿到的那份也未必与音频对得上。用户需要一个入口
/// **自己挑一份**，并且能看到它来自哪个源、对应哪首歌。
///
/// 行为：
/// - 每个已启用且同时具备 `search` + `getLyric` 能力的源各起一个线程；
/// - 每源先 `search`，取前 `limit` 个条目逐个问歌词（无词的条目跳过）；
/// - 整体最多等 [`LYRICS_SEARCH_TIMEOUT`]，超时的源记进 `timedOutSources`，**已经拿到的照常返回**；
/// - 歌词结果按 `lyrics:<source>:<rawId>:false` 缓存（与 `catalog.lyrics` 同一个键）。
pub fn lyrics_search(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: LyricsSearchParams = parse_params(params)?;
    let query = params.query.trim().to_string();
    if query.is_empty() {
        return Err(CoreError::invalid_argument("搜索歌词的关键词不能为空"));
    }
    let per_source = params
        .limit
        .unwrap_or(LYRICS_SEARCH_PER_SOURCE as u32)
        .clamp(1, 5) as usize;

    let load_failed = crate::catalog::ensure_loaded(ctx)?;
    let store = ctx
        .store
        .as_ref()
        .ok_or_else(|| CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法确认插件状态"))?;

    /* 目标源：已启用 + 已加载 + 同时有 search/getLyric。
       只有 search 的源不参与（不是失败，如实放进 skippedSources）。 */
    let mut targets: Vec<(u32, String, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for record in store.list_plugins()? {
        if !record.enabled {
            continue;
        }
        let id = record.manifest.id.clone();
        let Some(capabilities) = ctx.plugins.capabilities(&id) else { continue };
        if !capabilities.contains(&PluginCapability::Search) {
            continue;
        }
        if !capabilities.contains(&PluginCapability::GetLyric) {
            skipped.push(id);
            continue;
        }
        targets.push((record.priority as u32, id, record.manifest.name.clone()));
    }
    targets.sort_by_key(|(priority, _, _)| *priority);

    if targets.is_empty() {
        return Ok(json!({
            "items": [],
            "searchedSources": [],
            "failedSources": load_failed,
            "skippedSources": skipped,
            "timedOutSources": [],
        }));
    }

    let (tx, rx) = mpsc::channel::<(String, Vec<Value>, Option<String>)>();
    for (_, source, source_name) in &targets {
        let tx = tx.clone();
        let plugins = Arc::clone(&ctx.plugins);
        let snapshots = Arc::clone(&ctx.snapshots);
        let paths = ctx.paths.clone();
        let source = source.clone();
        let source_name = source_name.clone();
        let query = query.clone();

        thread::Builder::new()
            .name(format!("gently-lyrics-{source}"))
            .spawn(move || {
                let (items, error) =
                    collect_source_lyrics(&plugins, &snapshots, &paths, &source, &source_name, &query, per_source);
                let _ = tx.send((source, items, error));
            })
            .map_err(|err| CoreError::internal(format!("创建歌词搜索线程失败：{err}")))?;
    }
    drop(tx);

    let deadline = Instant::now() + LYRICS_SEARCH_TIMEOUT;
    let mut collected: HashMap<String, (Vec<Value>, Option<String>)> = HashMap::new();
    for _ in 0..targets.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok((source, items, error)) => {
                collected.insert(source, (items, error));
            }
            Err(_) => break,
        }
    }

    /* 按源的优先级拼结果：不是按“谁先返回”，否则用户每次搜到的顺序都不一样。 */
    let mut items: Vec<Value> = Vec::new();
    let mut searched: Vec<String> = Vec::new();
    let mut failed: Vec<String> = load_failed.clone();
    let mut timed_out: Vec<String> = Vec::new();
    for (_, source, _) in &targets {
        match collected.remove(source) {
            Some((source_items, None)) => {
                searched.push(source.clone());
                items.extend(source_items);
            }
            Some((_, Some(_))) => failed.push(source.clone()),
            None => timed_out.push(source.clone()),
        }
    }

    Ok(json!({
        "items": items,
        "searchedSources": searched,
        "failedSources": failed,
        "skippedSources": skipped,
        "timedOutSources": timed_out,
    }))
}

/// 一个源：search → 最多 `per_source` 个条目问歌词。
///
/// 单个条目无词/插件报错只跳过该条目，不让整源失败（社区插件质量参差）。
fn collect_source_lyrics(
    plugins: &PluginHost,
    snapshots: &ItemSnapshots,
    paths: &crate::paths::AppPaths,
    source: &str,
    source_name: &str,
    query: &str,
    per_source: usize,
) -> (Vec<Value>, Option<String>) {
    let raw = match plugins.call(source, "search", &json!([query, 1]).to_string()) {
        Ok(raw) => raw,
        Err(error) => return (Vec::new(), Some(error.message)),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => {
            return (Vec::new(), Some("search 返回的不是合法 JSON".to_string()));
        }
    };
    let Some(array) = list_items(&parsed) else {
        // 该源没有结果：不是失败，只是没有
        return (Vec::new(), None);
    };

    let mut dropped = 0usize;
    let mut items: Vec<Value> = Vec::new();
    for item in array.iter() {
        if items.len() >= per_source {
            break;
        }
        let Some(track) = crate::catalog::normalize_track(source, item, &mut dropped) else {
            continue;
        };
        // 播放解析要拿插件自己的条目；搜索歌词也顺手记快照（点“使用”后直接播放）
        snapshots.remember(source, item);

        let Some(reference) = track.get("id").and_then(Value::as_str) else { continue };
        let Some((_, raw_id)) = reference.split_once(':') else { continue };
        let Some(lyrics) = cached_lyric(plugins, snapshots, paths, source, raw_id) else {
            continue;
        };

        items.push(json!({
            "source": source,
            "sourceName": source_name,
            "track": track,
            "lyrics": lyrics,
        }));
    }

    (items, None)
}

/// 取一首歌词（先读 `cache/catalog/`，键与 `catalog.lyrics` 相同）。
fn cached_lyric(
    plugins: &PluginHost,
    snapshots: &ItemSnapshots,
    paths: &crate::paths::AppPaths,
    source: &str,
    raw_id: &str,
) -> Option<Value> {
    let key = format!("lyrics:{source}:{raw_id}:false");
    if let Some(hit) = cache::read(paths, &key) {
        return parse_lyric_value(&hit, false);
    }

    let arg = item_arg_for(plugins, snapshots, source, raw_id);
    let raw = plugins.call(source, "getLyric", &json!([arg]).to_string()).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    cache::write(paths, &key, LYRICS_TTL_SEC, &value);
    parse_lyric_value(&value, false)
}

/// 插件返回的歌词值 → 契约里的 `{format, content, translated?}`；空词返回 `None`。
///
/// 三种写法都认：裸字符串、我们的 `{content}`、MusicFree 的 `{rawLrc}` / `{lrc}`。
fn parse_lyric_value(value: &Value, with_translation: bool) -> Option<Value> {
    let content = match value {
        Value::String(text) => text.trim().to_string(),
        other => pick_text(&[other], &["content", "rawLrc", "lrc", "lyric"]).unwrap_or_default(),
    };
    if content.trim().is_empty() {
        return None;
    }

    let format = match pick_text(&[value], &["format"]).as_deref() {
        Some("plain") => "plain",
        Some("lrc") => "lrc",
        _ if looks_like_lrc(&content) => "lrc",
        _ => "plain",
    };
    let mut map = serde_json::Map::new();
    map.insert("format".into(), json!(format));
    map.insert("content".into(), json!(content));
    if with_translation {
        insert_opt(
            &mut map,
            "translated",
            pick_text(&[value], &["translated", "translation", "tlyric"]),
        );
    }
    Some(Value::Object(map))
}

// ---------------------------------------------------------------- 内部

/// 调一次插件函数并（可选）缓存结果。
fn call_detail(
    ctx: &CoreContext,
    source: &str,
    capability: PluginCapability,
    function: &str,
    args: Value,
    cache_key: &str,
    ttl_sec: i64,
) -> Fallible<Value> {
    /* 缓存**先于**能力/启用检查：缓存是本机数据，断网或插件被卸载时仍应能看歌词/详情。
       没有缓存时再走原来的前置检查（缺能力 → not_implemented，未安装 → not_found）。 */
    if let Some(hit) = cache::read(&ctx.paths, cache_key) {
        return Ok(hit);
    }

    ready_source(ctx, source, capability)?;

    let raw = ctx.plugins.call(source, function, &args.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|err| {
        CoreError::new(ErrorCode::PluginRuntimeError, format!("{function} 返回的不是合法 JSON：{err}"))
            .with_details(json!({ "source": source, "function": function }))
    })?;
    cache::write(&ctx.paths, cache_key, ttl_sec, &parsed);
    Ok(parsed)
}

/// 详情命令的前置条件：插件已安装、已启用、且具备该能力。
///
/// 缺能力 → `common.not_implemented`（社区插件能力参差是常态，UI 据此隐藏入口）；
/// 未安装/已禁用 → `common.not_found`（与搜索的「禁用立即生效」一致）。
fn ready_source(ctx: &CoreContext, source: &str, capability: PluginCapability) -> Fallible<()> {
    crate::catalog::ensure_loaded(ctx)?;

    let store = ctx
        .store
        .as_ref()
        .ok_or_else(|| CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法确认插件状态"))?;
    let record = store
        .get_plugin(source)?
        .ok_or_else(|| CoreError::not_found(format!("插件未安装：{source}")))?;
    if !record.enabled {
        return Err(CoreError::not_found(format!("插件已禁用：{source}")));
    }

    match ctx.plugins.capabilities(source) {
        Some(capabilities) if capabilities.contains(&capability) => Ok(()),
        _ => Err(CoreError::not_implemented(&format!("{source}.{}", function_of(capability))).with_details(
            json!({ "source": source, "capability": function_of(capability) }),
        )),
    }
}

/// 「这个源现在有某能力吗」——**不报错**的版本，用于「可选能力」的探测
/// （缺能力是常态：不是每个源都有收藏夹/收藏夹列表）。
fn has_capability(
    ctx: &CoreContext,
    source: &str,
    capability: PluginCapability,
) -> Fallible<bool> {
    // 能力来自**运行时探测**：没加载就没有能力表（搜索/详情命令都会先走这一步）
    crate::catalog::ensure_loaded(ctx)?;
    let Some(store) = ctx.store.as_ref() else { return Ok(false) };
    let Some(record) = store.get_plugin(source)? else { return Ok(false) };
    if !record.enabled {
        return Ok(false);
    }
    Ok(ctx
        .plugins
        .capabilities(source)
        .is_some_and(|capabilities| capabilities.contains(&capability)))
}

fn function_of(capability: PluginCapability) -> &'static str {
    capability.name()
}

/// `source:trackId` → 两段。引用格式是跨语言契约，写错要明确报错。
fn split_ref(reference: &str) -> Fallible<(&str, &str)> {
    match reference.split_once(':') {
        Some((source, raw_id)) if !source.is_empty() && !raw_id.is_empty() => Ok((source, raw_id)),
        _ => Err(CoreError::invalid_argument(format!(
            "引用格式应为 source:trackId，实际为 {reference}"
        ))
        .with_details(json!({ "ref": reference }))),
    }
}

/// 详情对象可能被包在 `data` / `track` 之类的字段里，这里取最内层。
fn inner_object<'a>(value: &'a Value, keys: &[&str]) -> &'a Value {
    let Some(object) = value.as_object() else { return value };
    for key in keys {
        if let Some(inner) = object.get(*key) {
            if inner.is_object() {
                return inner;
            }
        }
    }
    value
}

/// 元数据的候选对象：根对象 + 社区协议里的嵌套补充对象（`albumItem` / `sheetItem` / …）。
fn nested_details<'a>(value: &'a Value, keys: &[&str]) -> Vec<&'a Value> {
    let mut out = vec![value];
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(inner) = object.get(*key) {
                out.push(inner);
            }
        }
    }
    out
}

fn pick_text(sources: &[&Value], keys: &[&str]) -> Option<String> {
    for source in sources {
        let Some(object) = source.as_object() else { continue };
        for key in keys {
            // 数字型 id / title 也认（社区插件并不总是给字符串）
            let found = match object.get(*key) {
                Some(Value::String(text)) => Some(text.trim().to_string()),
                Some(Value::Number(number)) => Some(number.to_string()),
                _ => None,
            };
            if let Some(text) = found.filter(|text| !text.is_empty()) {
                return Some(text);
            }
        }
    }
    None
}

fn pick_u64(sources: &[&Value], keys: &[&str]) -> Option<u64> {
    for source in sources {
        let Some(object) = source.as_object() else { continue };
        for key in keys {
            if let Some(number) = object.get(*key).and_then(Value::as_u64) {
                return Some(number);
            }
            if let Some(text) = object.get(*key).and_then(Value::as_str) {
                if let Ok(number) = text.trim().parse::<u64>() {
                    return Some(number);
                }
            }
        }
    }
    None
}

fn pick_strings(sources: &[&Value], keys: &[&str]) -> Vec<String> {
    for source in sources {
        let Some(object) = source.as_object() else { continue };
        for key in keys {
            if let Some(items) = object.get(*key).and_then(Value::as_array) {
                return items
                    .iter()
                    .filter_map(|item| item.as_str().map(|text| text.trim().to_string()))
                    .filter(|text| !text.is_empty())
                    .collect();
            }
        }
    }
    Vec::new()
}

fn insert_opt(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(text) = value.filter(|text| !text.is_empty()) {
        map.insert(key.to_string(), json!(text));
    }
}

/// 详情函数的第一个参数。
///
/// **两种协议要的形状不同**（ADR-0006）：
/// - 自有 ABI：`getAlbumInfo(id)` / `getPlaylistInfo(id)` / `getTrackInfo(id)` / `getTopList(id, page)` 收**字符串 id**；
/// - MusicFree：`getAlbumInfo(albumItem)` / `getMusicSheetInfo(sheetItem, page)` / `getMusicInfo(musicItem)`
///   / `getTopListDetail(topListItem, page)` 收**条目对象**，而且常常要读 id 以外的字段
///   （B 站插件就从 `bvid`/`aid` 里取播放所需的 cid）。
///
/// 所以：兼容模式交给插件**归一化时记下的原始条目**（字段最全），没有快照时退化成 `{id}`；
/// 自有 ABI 一律给字符串。沙箱侧还有一层别名参数适配兜底（`sandbox/bootstrap.js`），
/// 两层都只做「形状翻译」，不新增任何能力。
fn detail_item_arg(ctx: &CoreContext, source: &str, id: &str) -> Value {
    item_arg_for(&ctx.plugins, &ctx.snapshots, source, id)
}

/// 详情/歌词调用的第一个参数：兼容插件要**它自己产出过的那个条目**，自有 ABI 只要字符串 id。
///
/// 与线程共享的版本分开（线程里只拿得到 `Arc<PluginHost>` 与 `Arc<ItemSnapshots>`）。
fn item_arg_for(plugins: &PluginHost, snapshots: &ItemSnapshots, source: &str, id: &str) -> Value {
    let compat = plugins.manifest_of(source).is_some_and(|manifest| manifest.compat);
    if !compat {
        return json!(id);
    }
    snapshots.get(source, id).unwrap_or_else(|| json!({ "id": id }))
}

/// 列表形状 → 归一化曲目（复用搜索那套归一化，缺 `title` 的条目丢弃）。
///
/// 同时把原始条目记进 `ctx.snapshots`：从榜单/专辑点开播放时，插件要拿到**它自己产出过的那个条目**
/// （`raw_id` 只是引用，字段不够）——少了这一步，真实 MusicFree 插件「榜单能看、一播就报错」。
fn detail_tracks(ctx: &CoreContext, source: &str, value: &Value) -> Vec<Value> {
    let mut dropped = 0usize;
    list_items(value)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            let track = crate::catalog::normalize_track(source, item, &mut dropped)?;
            ctx.snapshots.remember(source, item);
            Some(track)
        })
        .collect()
}

/// 歌词是否带时间戳（`[mm:ss`）。插件不声明 format 时用它推断。
fn looks_like_lrc(content: &str) -> bool {
    let bytes = content.as_bytes();
    let mut index = 0;
    while let Some(offset) = content[index..].find('[') {
        let start = index + offset + 1;
        let digits = content[start..].chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && content[start + digits..].starts_with(':') {
            return true;
        }
        index = start;
        if index >= bytes.len() {
            break;
        }
    }
    false
}

/// 详情缓存：`cache/catalog/<hash>.json`。
///
/// 契约 §9 明确 `cache/` 可随时整目录删除，因此这里**不**做失效协商：
/// 读不到、读坏了、过期了都重新问插件，写失败也不影响本次结果（缓存是加速，不是状态）。
mod cache {
    use std::path::PathBuf;

    use serde_json::{json, Value};

    use crate::paths::AppPaths;
    use crate::plugin::sha256_hex;

    fn path_of(paths: &AppPaths, key: &str) -> PathBuf {
        let digest = sha256_hex(key.as_bytes());
        paths.cache.join("catalog").join(format!("{}.json", &digest[..16]))
    }

    pub fn read(paths: &AppPaths, key: &str) -> Option<Value> {
        let text = std::fs::read_to_string(path_of(paths, key)).ok()?;
        let entry: Value = serde_json::from_str(&text).ok()?;
        let at = entry.get("at").and_then(Value::as_i64)?;
        let ttl = entry.get("ttl").and_then(Value::as_i64)?;
        if now_secs().saturating_sub(at) > ttl {
            return None;
        }
        entry.get("value").cloned()
    }

    pub fn write(paths: &AppPaths, key: &str, ttl_sec: i64, value: &Value) {
        let path = path_of(paths, key);
        let Some(parent) = path.parent() else { return };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let entry = json!({ "at": now_secs(), "ttl": ttl_sec, "key": key, "value": value });
        let Ok(text) = serde_json::to_string(&entry) else { return };
        // 原子写：缓存写坏比没有缓存更糟（会一直读到半截 JSON）
        let temp = path.with_extension("tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, &path);
        }
    }

    fn now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default()
    }
}
