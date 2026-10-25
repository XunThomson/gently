//! 本机库命令：收藏 / 歌单 / 播放历史（M3a）。
//!
//! # 曲目快照从哪来
//!
//! 本机库存的是**曲目快照**（`track` 列），因为插件可能被卸载或改接口，
//! 列一个歌单不该依赖任何插件在线。快照来源的优先级：
//!
//! 1. **调用方带来**（`track` 参数）——界面点收藏/播放时手上就有完整的 `Track`，
//!    这是唯一可靠的来源；
//! 2. 否则退化成**最小占位曲目**（标题 = rawId）：引用仍然保留，
//!    下次带快照写入时会自动刷新（`set_favorite` 是幂等 upsert）。
//!
//! 核心**不为了补一个标题去调插件**：写入路径不该依赖网络，也不该因为插件超时而失败。
//!
//! # 引用
//!
//! 统一用 `source:trackId`。参数同时接受字符串与 `TrackRef` 对象
//! （后者是前端契约里的形状：`{id, source, sourceTrackId}`），两种写法都归一化成同一个引用。

use serde_json::{json, Value};

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::store::{normalize_limit, StoredTrack};

/// 曲目引用参数：字符串或 `TrackRef` 对象。
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum RefParam {
    Text(String),
    Object {
        /// 完整引用 `source:trackId`
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        source: Option<String>,
        #[serde(default, rename = "sourceTrackId")]
        source_track_id: Option<String>,
    },
}

impl RefParam {
    /// → `(引用, 插件 id)`。
    fn resolve(&self) -> Fallible<(String, String)> {
        let (reference, source) = match self {
            Self::Text(text) => {
                let (source, _) = split_ref(text)?;
                (text.trim().to_string(), source.to_string())
            }
            Self::Object { id, source, source_track_id } => {
                let source = source.as_deref().filter(|text| !text.is_empty()).ok_or_else(|| {
                    CoreError::invalid_argument("ref 缺少 source 字段").with_details(json!({ "ref": id }))
                })?;
                match (id.as_deref().filter(|t| !t.is_empty()), source_track_id.as_deref().filter(|t| !t.is_empty())) {
                    // 完整引用优先；只有 sourceTrackId 时按 `source:rawId` 拼出来
                    (Some(id), _) => (id.to_string(), source.to_string()),
                    (None, Some(raw)) => (format!("{source}:{raw}"), source.to_string()),
                    (None, None) => {
                        return Err(CoreError::invalid_argument("ref 缺少 id 或 sourceTrackId")
                            .with_details(json!({ "source": source })))
                    }
                }
            }
        };
        // 引用必须真的能解析出 source：否则存进去的行会在播放时对不上
        split_ref(&reference)?;
        Ok((reference, source))
    }
}

/// 把「字符串或 `TrackRef` 对象」的引用参数解析成 `(引用, 插件 id)`。
///
/// `library.*` 与 `playback.report` 共用这一份解析：引用格式是跨语言契约，
/// 只允许有一处实现（否则两个域迟早对「缺 sourceTrackId 怎么办」给出不同答案）。
pub(crate) fn resolve_ref(value: &Value) -> Fallible<(String, String)> {
    let param: RefParam = serde_json::from_value(value.clone()).map_err(|err| {
        CoreError::invalid_argument(format!("ref 解析失败：{err}"))
            .with_details(json!({ "ref": value }))
    })?;
    param.resolve()
}

#[derive(Debug, serde::Deserialize)]
struct FavoritesSetParams {
    #[serde(rename = "ref")]
    reference: RefParam,
    favorite: bool,
    /// 曲目快照（界面手上有；缺了就退化成占位曲目）
    #[serde(default)]
    track: Option<Value>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageParams {
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistsSaveParams {
    #[serde(default)]
    id: Option<String>,
    name: String,
    /// 曲目引用（字符串或 `TrackRef` 对象）
    #[serde(default)]
    track_refs: Vec<RefParam>,
    /// 与 `trackRefs` **一一对应**的曲目快照（可选）：缺的条目退化成占位曲目
    #[serde(default)]
    tracks: Vec<Value>,
}

#[derive(Debug, serde::Deserialize)]
struct PlaylistIdParams {
    id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryPushParams {
    #[serde(rename = "ref")]
    reference: RefParam,
    #[serde(default)]
    played_sec: i64,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    track: Option<Value>,
}

// ---------------------------------------------------------------- 收藏

/// `library.favorites.set{ref, favorite, track?}`：收藏/取消（幂等）。
pub fn favorites_set(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: FavoritesSetParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let (reference, source) = params.reference.resolve()?;

    let snapshot = snapshot_of(&reference, &source, params.track.as_ref());
    let favorite = store.set_favorite(&reference, &source, &snapshot, params.favorite)?;
    Ok(json!({ "favorite": favorite, "ref": reference }))
}

/// `library.favorites.list{limit?, cursor?}`：收藏列表（倒序 + 游标分页）。
pub fn favorites_list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PageParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let page = store.list_favorites(normalize_limit(params.limit), params.cursor.as_deref())?;

    let items: Vec<Value> = page
        .items
        .iter()
        .map(|row| {
            grouped_track(
                &row.stored,
                &ctx.streams,
                &ctx.plugins.qualities(&row.stored.source),
            )
        })
        .collect();
    Ok(page_json(items, page.next_cursor, page.total))
}

// ---------------------------------------------------------------- 播放历史

/// `library.history.push{ref, playedSec, completed, track?}`：记一次播放。
pub fn history_push(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: HistoryPushParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let (reference, source) = params.reference.resolve()?;

    let snapshot = snapshot_of(&reference, &source, params.track.as_ref());
    store.push_history(&reference, &source, &snapshot, params.played_sec, params.completed)?;
    Ok(Value::Null)
}

/// `library.history.list{limit?, cursor?}`：最近播放（每次播放一行，带累计次数）。
pub fn history_list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PageParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let page = store.list_history(normalize_limit(params.limit), params.cursor.as_deref())?;

    let items: Vec<Value> = page
        .items
        .iter()
        .map(|row| {
            let mut track = normalized(&row.stored, &ctx.streams);
            track["playedAt"] = json!(row.played_at);
            track["playCount"] = json!(row.play_count);
            track["playedSec"] = json!(row.played_sec);
            track["completed"] = json!(row.completed);
            track
        })
        .collect();
    Ok(page_json(items, page.next_cursor, page.total))
}

/// `library.history.clear`：清空播放记录（收藏与歌单不受影响）。
///
/// 契约里原本没有这条命令，但界面一直有「清空播放记录」的入口——
/// 核心成为历史的事实来源之后，没有它就等于这个功能静默失效。
pub fn history_clear(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let _ = parse_params::<Value>(params)?;
    let store = require_store(ctx)?;
    let removed = store.clear_history()?;
    Ok(json!({ "removed": removed }))
}

// ---------------------------------------------------------------- 歌单

/// `library.playlists.list`：全部歌单（含曲目，按 position 排序）。
pub fn playlists_list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let _ = parse_params::<Value>(params)?;
    let store = require_store(ctx)?;
    Ok(Value::Array(
        store
            .list_playlists()?
            .iter()
            .map(|playlist| {
                json!({
                    "id": playlist.id,
                    "name": playlist.name,
                    "createdAt": playlist.created_at,
                    "updatedAt": playlist.updated_at,
                    "tracks": playlist
                        .tracks
                        .iter()
                        .map(|stored| normalized(stored, &ctx.streams))
                        .collect::<Vec<_>>(),
                })
            })
            .collect(),
    ))
}

/// `library.playlists.save{id?, name, trackRefs, tracks?}`：新建（无 id）或整体覆盖（有 id）。
pub fn playlists_save(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PlaylistsSaveParams = parse_params(params)?;
    let name = params.name.trim();
    if name.is_empty() {
        return Err(CoreError::invalid_argument("歌单名不能为空"));
    }
    if params.track_refs.len() > crate::store::MAX_PAGE {
        return Err(CoreError::invalid_argument(format!(
            "单个歌单最多 {} 首（分页上限）",
            crate::store::MAX_PAGE
        )));
    }

    let store = require_store(ctx)?;
    let mut tracks: Vec<StoredTrack> = Vec::with_capacity(params.track_refs.len());
    let mut seen: Vec<String> = Vec::new();
    for (index, reference) in params.track_refs.iter().enumerate() {
        let (reference, source) = reference.resolve()?;
        if seen.contains(&reference) {
            continue; // 同一首歌在歌单里只留一次（重复添加是常见误操作）
        }
        seen.push(reference.clone());
        tracks.push(StoredTrack {
            track: snapshot_of(&reference, &source, params.tracks.get(index)),
            reference,
            source,
        });
    }

    let saved = store.save_playlist(params.id.as_deref(), name, &tracks)?;
    Ok(json!({
        "id": saved.id,
        "name": saved.name,
        "createdAt": saved.created_at,
        "updatedAt": saved.updated_at,
        "tracks": saved
            .tracks
            .iter()
            .map(|stored| normalized(stored, &ctx.streams))
            .collect::<Vec<_>>(),
    }))
}

/// `library.playlists.delete{id}`：删歌单（曲目随外键级联删除）。
pub fn playlists_delete(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: PlaylistIdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    if !store.delete_playlist(&params.id)? {
        return Err(CoreError::not_found(format!("歌单不存在：{}", params.id)));
    }
    Ok(Value::Null)
}

// ---------------------------------------------------------------- 内部

fn require_store(ctx: &CoreContext) -> Fallible<&crate::store::Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写本机库").with_details(
            json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

/// 快照：调用方给的直接用；没给就退化成最小占位曲目（引用仍然保留）。
pub(crate) fn snapshot_of(reference: &str, source: &str, provided: Option<&Value>) -> Value {
    match provided {
        Some(track) if track.is_object() => {
            let mut track = track.clone();
            // 引用以参数为准：调用方给的 track.id 可能与 ref 不一致（历史遗留 id）
            track["id"] = json!(reference);
            track["source"] = json!(source);
            track
        }
        _ => {
            let raw_id = reference.split_once(':').map(|(_, raw)| raw).unwrap_or(reference);
            json!({
                "id": reference,
                "title": raw_id,
                "artist": "",
                "album": "",
                "duration": "0:00",
                "durationSec": 0,
                "source": source,
                "gradient": "",
                "tags": [],
            })
        }
    }
}

/// 尽量从**本机库**里找出这个引用的曲目快照（收藏 → 历史 → 本地曲库）。
///
/// 反馈（`recommend.feedback`）拿不到调用方的快照时用它：没有标签/歌手的反馈对画像毫无意义，
/// 而「打标签」这件事只能靠快照——所以宁可多查一次库，也不写一条空反馈。
pub(crate) fn lookup_snapshot(ctx: &CoreContext, reference: &str, source: &str) -> Value {
    let Some(store) = ctx.store.as_ref() else {
        return snapshot_of(reference, source, None);
    };
    if let Ok(Some(row)) = store.get_local_track(reference) {
        return crate::local_library::local_track_json(&row);
    }
    if let Ok(page) = store.list_favorites(super::store::MAX_PAGE, None) {
        if let Some(found) = page.items.iter().find(|row| row.stored.reference == reference) {
            return found.stored.track.clone();
        }
    }
    if let Ok(page) = store.list_history(super::store::MAX_PAGE, None) {
        if let Some(found) = page.items.iter().find(|row| row.stored.reference == reference) {
            return found.stored.track.clone();
        }
    }
    snapshot_of(reference, source, None)
}

/// 库里存的曲目 → 下发形状（补齐契约字段，缺的给兜底值）。
///
/// `streams` 用来**重新签发**本地曲目的封面地址：快照里存的是当时那个回环端口，早失效了
/// （见 `local_library::refresh_local_artwork`）。
fn normalized(stored: &StoredTrack, streams: &crate::media::StreamRegistry) -> Value {
    let raw_id = stored.reference.split_once(':').map(|(_, raw)| raw).unwrap_or(&stored.reference);
    let mut track = match stored.track {
        Value::Object(ref map) => Value::Object(map.clone()),
        _ => json!({}),
    };

    // 先把要用的值取出来再改 track：闭包里借用 track 的同时写它会打架
    let title = text_field(&track, "title", raw_id);
    let artist = text_field(&track, "artist", "");
    let album = text_field(&track, "album", "");
    let duration = text_field(&track, "duration", "0:00");
    let tags = match track.get("tags") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => json!([]),
    };
    let has_duration_sec = track.get("durationSec").is_some_and(Value::is_number);
    let has_gradient = track.get("gradient").is_some_and(Value::is_string);

    track["id"] = json!(stored.reference);
    track["source"] = json!(stored.source);
    track["title"] = title;
    track["artist"] = artist;
    track["album"] = album;
    track["duration"] = duration;
    track["tags"] = tags;
    if !has_duration_sec {
        track["durationSec"] = json!(0);
    }
    if !has_gradient {
        track["gradient"] = json!("");
    }
    crate::local_library::refresh_local_artwork(streams, &mut track);
    track
}

/// 取一个非空字符串字段，取不到用兜底值。
fn text_field(track: &Value, key: &str, fallback: &str) -> Value {
    track
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| json!(value))
        .unwrap_or_else(|| json!(fallback))
}

/// 收藏/历史条目下发成 `GroupedTrack`：详情来自一个源，但形状与搜索结果一致。
fn grouped_track(
    stored: &StoredTrack,
    streams: &crate::media::StreamRegistry,
    qualities: &[crate::plugin::TrackQuality],
) -> Value {
    let track = normalized(stored, streams);
    let mut grouped = track.clone();
    grouped["sourceCount"] = json!(1);
    grouped["candidates"] = json!([{
        "source": stored.source,
        "track": track,
        // 收藏快照不带清单；用当前已加载插件的声明补齐（未加载时为空，前端保留首选档位）
        "qualities": qualities,
    }]);
    grouped
}

fn page_json(items: Vec<Value>, next_cursor: Option<String>, total: i64) -> Value {
    let mut page = json!({
        "items": items,
        "hasMore": next_cursor.is_some(),
        "total": total,
    });
    // 游标对调用方不透明：有下一页才下发，前端只负责回传
    if let Some(cursor) = next_cursor {
        page["nextCursor"] = json!(cursor);
    }
    page
}

/// `source:trackId` → 两段（引用格式是跨语言契约，写错必须明确报错）。
fn split_ref(reference: &str) -> Fallible<(&str, &str)> {
    match reference.trim().split_once(':') {
        Some((source, raw_id)) if !source.is_empty() && !raw_id.is_empty() => Ok((source, raw_id)),
        _ => Err(CoreError::invalid_argument(format!(
            "引用格式应为 source:trackId，实际为 {reference}"
        ))
        .with_details(json!({ "ref": reference }))),
    }
}
