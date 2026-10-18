//! 曲库聚合：把多个插件的搜索结果归一化、合并、按优先级排序，并以事件流式返回。
//!
//! # 为什么是流式
//!
//! 社区插件质量参差，一个慢源不应该拖死整页：`catalog.search` **立即返回 `searchId`**，
//! 每个源返回时推一条 `catalog:search:partial`，全部结束后推 `catalog:search:done`
//! （含跨源合并结果）。合并**只在核心完成**（单一职责），前端只负责渲染。
//!
//! # 为什么并发
//!
//! 每个插件都有自己的线程与运行时（M1b），因此这里一个源一个线程；
//! 协调线程用 channel 收集结果，取消靠共享的 `AtomicBool`。
//!
//! # 归一化（不信任插件输出）
//!
//! 插件返回的是任意 JSON：这里强制 `source` 为插件 id、`id` 为 `source:rawId`，
//! 缺字段用兜底值，缺 `title` 的条目**丢弃并计数**（而不是让整源失败）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use crate::commands::CoreContext;
use crate::contract::{CoreError, Fallible};
use crate::events::events;

/// 并发搜索的取消登记表。
#[derive(Default)]
pub struct SearchRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    counter: AtomicU64,
}

impl SearchRegistry {
    pub fn next_id(&self) -> String {
        let seq = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("search-{}-{seq}", now_millis())
    }

    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut flags) = self.flags.lock() {
            flags.insert(id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.flags.lock().ok().and_then(|flags| flags.get(id).cloned()) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut flags) = self.flags.lock() {
            flags.remove(id);
        }
    }
}

/// 确保「已启用」的插件都已装进沙箱。返回加载失败的插件 id。
///
/// 这一步是**首次使用时加载**：安装只落盘，重启后运行时是空的；
/// 搜索/播放这类真正要用插件的入口先调用它，用户就不必手动点「重载」。
/// 单个插件加载失败只记录并跳过——社区插件质量参差，不能因此让整个操作失败。
pub fn ensure_loaded(ctx: &CoreContext) -> Fallible<Vec<String>> {
    let Some(store) = ctx.store.as_ref() else {
        return Ok(Vec::new());
    };

    let mut failed = Vec::new();
    for record in store.list_plugins()? {
        if !record.enabled {
            continue;
        }
        let id = record.manifest.id.clone();
        if ctx.plugins.capabilities(&id).is_some() {
            continue; // 已加载
        }
        match ctx.plugins.load(record.manifest) {
            Ok(_) => tracing::info!(plugin = %id, "按需加载完成"),
            Err(err) => {
                tracing::warn!(plugin = %id, code = err.code.as_str(), "插件加载失败，已跳过：{}", err.message);
                failed.push(id);
            }
        }
    }
    Ok(failed)
}

/// 启动一次流式搜索；**立即返回 searchId**，结果通过事件推送。
pub fn search(
    ctx: &CoreContext,
    keyword: &str,
    sources: Option<Vec<String>>,
    limit: usize,
) -> Fallible<Value> {
    let keyword = keyword.trim().to_string();
    if keyword.is_empty() {
        return Err(CoreError::invalid_argument("搜索关键词不能为空"));
    }

    let load_failed = ensure_loaded(ctx)?;
    let search_id = ctx.searches.next_id();
    let cancel = ctx.searches.register(&search_id);

    // 目标源：已加载 + 有 search 能力 + 命中 sources 过滤
    let mut targets: Vec<(String, u32, Vec<String>)> = Vec::new();
    for id in ctx.plugins.loaded_ids() {
        if let Some(filter) = &sources {
            if !filter.is_empty() && !filter.contains(&id) {
                continue;
            }
        }
        let Some(capabilities) = ctx.plugins.capabilities(&id) else { continue };
        if !capabilities.contains(&crate::plugin::PluginCapability::Search) {
            continue;
        }
        let Some(manifest) = ctx.plugins.manifest_of(&id) else { continue };

        // 以库里的状态为准：**禁用要立即生效**，而不是等下次重载。
        // （插件可能已加载，但用户刚点了「停用」，此时不应再参与搜索。）
        let record = ctx.store.as_ref().and_then(|store| store.get_plugin(&id).ok().flatten());
        if record.as_ref().is_some_and(|record| !record.enabled) {
            continue;
        }
        let priority = record.map(|record| record.priority as u32).unwrap_or(100);
        targets.push((id, priority, manifest.qualities.iter().map(|q| format!("{q:?}").to_lowercase()).collect()));
    }

    if targets.is_empty() {
        // 一个可用源都没有：仍然走「done」事件，让前端能结束等待并给出空态
        ctx.searches.finish(&search_id);
        ctx.events.emit(
            events::CATALOG_SEARCH_DONE,
            json!({ "searchId": search_id, "items": [], "sources": [], "failedSources": load_failed }),
        );
        return Ok(json!({ "searchId": search_id, "sourceCount": 0 }));
    }

    let source_count = targets.len();
    let (tx, rx) = mpsc::channel::<(String, u32, Vec<Value>, Option<CoreError>)>();

    for (id, priority, qualities) in &targets {
        let tx = tx.clone();
        let plugins = Arc::clone(&ctx.plugins);
        let events = Arc::clone(&ctx.events);
        let snapshots = Arc::clone(&ctx.snapshots);
        let cancel = Arc::clone(&cancel);
        let search_id = search_id.clone();
        let id = id.clone();
        let priority = *priority;
        let qualities = qualities.clone();
        let args = json!([keyword, 1]).to_string();

        thread::Builder::new()
            .name(format!("gently-search-{id}"))
            .spawn(move || {
                if cancel.load(Ordering::Relaxed) {
                    let _ = tx.send((id, priority, Vec::new(), None));
                    return;
                }

                match plugins.call(&id, "search", &args) {
                    Ok(raw) => {
                        let mut dropped = 0usize;
                        let tracks = normalize_tracks(&id, &raw, limit, &mut dropped, Some(&snapshots));
                        if dropped > 0 {
                            tracing::debug!(plugin = %id, dropped, "搜索结果的非法条目已丢弃");
                        }
                        events.emit(
                            events::CATALOG_SEARCH_PARTIAL,
                            json!({
                                "searchId": search_id, "source": id, "tracks": tracks,
                                "dropped": dropped, "qualities": qualities,
                            }),
                        );
                        let _ = tx.send((id, priority, tracks, None));
                    }
                    Err(error) => {
                        // 单个源失败不是整体失败：推一条带 failed 的 partial，由 UI 展示「该源不可用」
                        events.emit(
                            events::CATALOG_SEARCH_PARTIAL,
                            json!({ "searchId": search_id, "source": id, "tracks": [], "failed": error }),
                        );
                        let _ = tx.send((id, priority, Vec::new(), Some(error)));
                    }
                }
            })
            .map_err(|err| CoreError::internal(format!("创建搜索线程失败：{err}")))?;
    }

    // 原始 sender 用完即弃：所有源线程结束后 rx 才会断开
    drop(tx);

    // 协调线程：收集全部源 → 合并 → 推 done
    {
        let events = Arc::clone(&ctx.events);
        let searches = Arc::clone(&ctx.searches);
        let search_id = search_id.clone();

        thread::Builder::new()
            .name("gently-search-merge".into())
            .spawn(move || {
                let mut collected: Vec<(String, u32, Vec<Value>)> = Vec::new();
                let mut failed: Vec<String> = load_failed;
                let mut ok_sources: Vec<String> = Vec::new();

                for _ in 0..source_count {
                    match rx.recv() {
                        Ok((id, priority, tracks, error)) => {
                            if error.is_some() {
                                failed.push(id);
                            } else {
                                ok_sources.push(id.clone());
                                collected.push((id, priority, tracks));
                            }
                        }
                        Err(_) => break,
                    }
                }

                // 候选优先级：数值小的在前（与 playback.resolve 的回退顺序一致）
                collected.sort_by_key(|(_, priority, _)| *priority);
                let items = merge_tracks(collected);

                events.emit(
                    events::CATALOG_SEARCH_DONE,
                    json!({
                        "searchId": search_id, "items": items,
                        "sources": ok_sources, "failedSources": failed,
                    }),
                );
                searches.finish(&search_id);
            })
            .map_err(|err| CoreError::internal(format!("创建合并线程失败：{err}")))?;
    }

    Ok(json!({ "searchId": search_id, "sourceCount": source_count }))
}

/// 取消一次搜索（慢源不该拖住用户）。
pub fn cancel(ctx: &CoreContext, search_id: &str) -> Fallible<()> {
    if ctx.searches.cancel(search_id) {
        Ok(())
    } else {
        Err(CoreError::not_found(format!("搜索已结束或不存在：{search_id}")))
    }
}

/// 把插件返回的任意 JSON 归一化成契约里的 `Track`。
///
/// 规则：`source` 强制为插件 id；`id` 为 `source:rawId`；缺 `title` 的条目丢弃。
/// 列表形状交给 `plugin::list_items`（兼容 MusicFree 的 `{isEnd, data}` / `{isEnd, musicList}`）。
///
/// 归一化时顺手把**插件原始条目**记进 `snapshots`（见 [`ItemSnapshots`]）：播放解析要把它原样
/// 交回插件，而前端手上只有 `source:rawId`。
fn normalize_tracks(
    source: &str,
    raw: &str,
    limit: usize,
    dropped: &mut usize,
    snapshots: Option<&ItemSnapshots>,
) -> Vec<Value> {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            *dropped += 1;
            return Vec::new();
        }
    };

    let Some(array) = crate::plugin::list_items(&parsed) else {
        // 没有列表（形状不认识，或确实是空对象）→ 丢弃并计数，由 UI 体现「该源没结果」
        *dropped += 1;
        return Vec::new();
    };

    array
        .iter()
        .filter_map(|item| {
            let track = normalize_track(source, item, dropped)?;
            if let Some(store) = snapshots {
                store.remember(source, item);
            }
            Some(track)
        })
        .take(limit)
        .collect()
}

/// 插件原始条目的**进程内**快照（LRU，不落盘、不上报、不跨进程）。
///
/// 为什么需要这一层：MusicFree 生态的 `getMediaSource(musicItem)` 收的是**插件自己产出过的那个
/// 条目**（bilibili 这类源要从里面读 `bvid` / `aid` / `cid` 才能拿到播放地址），而我们的契约
/// 只把 `source:rawId` 交给前端。归一化时把原始条目按 `source:rawId` 记下来，播放解析时原样回给插件——
/// **不猜字段、不写「每源适配表」**，插件产出过的任何字段都还在。
///
/// R53 实测：没有这一层，真实 MusicFree 插件（B 站）能搜、能出榜单，但一播就
/// `plugin.runtime_error`（插件把 `undefined` 的 bvid 拼进 URL，上游回 -400）。
pub struct ItemSnapshots {
    items: Mutex<HashMap<String, Value>>,
    /// 淘汰顺序：队首最旧，命中后移到队尾（近似 LRU）
    order: Mutex<std::collections::VecDeque<String>>,
    limit: usize,
}

impl Default for ItemSnapshots {
    fn default() -> Self {
        Self::new(2_000)
    }
}

impl ItemSnapshots {
    pub fn new(limit: usize) -> Self {
        Self {
            items: Mutex::new(HashMap::new()),
            order: Mutex::new(std::collections::VecDeque::new()),
            limit: limit.max(1),
        }
    }

    /// 记下一条插件原始条目（键就是它将来被引用时用的 `source:rawId`）。
    pub fn remember(&self, source: &str, item: &Value) {
        let Some(raw_id) = raw_id_of(item) else { return };
        // 标题为空的条目会被归一化丢弃 → 永远不会被引用，不必记
        let titled = item
            .get("title")
            .and_then(|value| value.as_str())
            .is_some_and(|title| !title.trim().is_empty());
        if !titled {
            return;
        }
        self.remember_raw(source, &raw_id, item);
    }

    /// 按**指定的** raw id 记（详情命令用：插件返回的 id 可能与请求的引用不同，
    /// 而播放时用的键是请求时那个引用）。
    pub fn remember_raw(&self, source: &str, raw_id: &str, item: &Value) {
        let key = format!("{source}:{raw_id}");
        let Ok(mut items) = self.items.lock() else { return };
        if items.insert(key.clone(), item.clone()).is_none() {
            if let Ok(mut order) = self.order.lock() {
                order.push_back(key);
                while order.len() > self.limit {
                    if let Some(oldest) = order.pop_front() {
                        items.remove(&oldest);
                    }
                }
            }
        }
    }

    /// 取回插件原始条目（`raw_id` 是引用里 `source:` 之后的那一段）。
    pub fn get(&self, source: &str, raw_id: &str) -> Option<Value> {
        let key = format!("{source}:{raw_id}");
        let items = self.items.lock().ok()?;
        let found = items.get(&key).cloned();
        drop(items);
        if found.is_some() {
            if let Ok(mut order) = self.order.lock() {
                if let Some(position) = order.iter().position(|item| item == &key) {
                    order.remove(position);
                    order.push_back(key);
                }
            }
        }
        found
    }
}

/// 条目在源内的原始 id：契约里 `id` 允许是字符串或数字，缺失时退回标题
/// （与 `normalize_track` 完全同一套规则——两处不一致就会出现「记下了却取不回」）。
fn raw_id_of(item: &Value) -> Option<String> {
    let object = item.as_object()?;
    object
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| object.get("id").and_then(|value| value.as_i64()).map(|n| n.to_string()))
        .or_else(|| {
            object
                .get("title")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string)
        })
}

pub(crate) fn normalize_track(source: &str, item: &Value, dropped: &mut usize) -> Option<Value> {
    let object = match item.as_object() {
        Some(object) => object,
        None => {
            *dropped += 1;
            return None;
        }
    };

    let title = object.get("title").and_then(|v| v.as_str()).unwrap_or_default().trim();
    if title.is_empty() {
        *dropped += 1;
        return None;
    }

    // 与 `raw_id_of` 共用同一套规则：两处若不一致，快照就会「记下了却按 ref 取不回」
    let raw_id = raw_id_of(item).unwrap_or_else(|| title.to_string());

    let duration_sec = read_duration_sec(object);

    let tags: Vec<String> = object
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|items| {
            items.iter().filter_map(|value| value.as_str()).map(str::to_string).collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // 封面：插件给的字段名不统一（MusicFree 是 `artwork`，自有 ABI 是 `cover`，
    // HTML 解析出来的常见 `coverImg` / `pic` / `img`）。**取第一个非空值**，
    // 认不出来就留空串——前端会退回渐变占位，不会出现半个破图。
    let artwork = ["artwork", "cover", "coverImg", "pic", "img", "image"]
        .iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();

    let mut track = json!({
        // 统一引用：`source:rawId`（前端与核心都按这个格式解析）
        "id": format!("{source}:{raw_id}"),
        "title": title,
        "artist": object.get("artist").and_then(|v| v.as_str()).unwrap_or("未知歌手"),
        "album": object.get("album").and_then(|v| v.as_str()).unwrap_or(""),
        "duration": format_mmss(duration_sec),
        "durationSec": duration_sec,
        "source": source,
        // 封面图地址（可为空）；`gradient` 仍是「没有封面时」的占位
        "artwork": artwork,
        "gradient": object.get("gradient").and_then(|v| v.as_str()).unwrap_or(""),
        "tags": tags,
    });
    if let Some(album_id) = object.get("albumId").and_then(|v| v.as_str()) {
        track["albumId"] = json!(album_id);
    }
    Some(track)
}

/// 时长（秒）。三种写法都认，因为自有 ABI 与 MusicFree 生态不一致：
/// - 自有 ABI：`durationSec`（数字）或 `duration` 写成 `"3:05"`；
/// - MusicFree：`duration` 是**数字**，单位秒（`IMusicItem.duration`）。
///
/// 数字字符串（HTML 解析常见，如 `"226"`）按秒处理——秒级是这个生态里唯一的约定；
/// 认不出来就返回 0（宁可显示 0:00，也不猜一个错的时长）。
fn read_duration_sec(object: &serde_json::Map<String, Value>) -> u64 {
    object
        .get("durationSec")
        .and_then(seconds_of)
        .or_else(|| object.get("duration").and_then(seconds_of))
        .unwrap_or(0)
}

fn seconds_of(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_f64() {
        return Some(if number > 0.0 { number as u64 } else { 0 });
    }
    let text = value.as_str()?.trim();
    if text.contains(':') {
        return parse_mmss(text);
    }
    text.parse::<u64>().ok()
}

fn parse_mmss(text: &str) -> Option<u64> {
    let (minutes, seconds) = text.split_once(':')?;
    Some(minutes.trim().parse::<u64>().ok()? * 60 + seconds.trim().parse::<u64>().ok()?)
}

fn format_mmss(seconds: u64) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// 跨源合并：同一首歌（标题+歌手归一化后相同）合成一条 `GroupedTrack`，
/// `candidates` 按插件优先级排序——**候选顺序即播放回退顺序**。
fn merge_tracks(collected: Vec<(String, u32, Vec<Value>)>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<(String, u32, Value)>> = HashMap::new();

    for (source, priority, tracks) in collected {
        for track in tracks {
            let key = format!(
                "{}|{}",
                track["title"].as_str().unwrap_or_default().to_lowercase(),
                track["artist"].as_str().unwrap_or_default().to_lowercase()
            );
            if !groups.contains_key(&key) {
                order.push(key.clone());
            }
            groups.entry(key).or_default().push((source.clone(), priority, track));
        }
    }

    order
        .into_iter()
        .filter_map(|key| {
            let mut members = groups.remove(&key)?;
            members.sort_by_key(|(_, priority, _)| *priority);

            let (_, _, base) = members.first()?.clone();
            let candidates: Vec<Value> = members
                .iter()
                .map(|(source, _, track)| {
                    json!({
                        "source": source,
                        "track": track,
                        // 该源支持的音质档位（由清单给出；M2b 起由源能力细化）
                        "qualities": ["standard"],
                    })
                })
                .collect();

            let mut grouped = base;
            /* 封面：主条目没有就从其它候选里取第一个非空的。
               音乐站的搜索接口经常不给封面（实测网易云 `album.picUrl` 是空串），而视频站的条目
               几乎都带（视频封面就是专辑图）。只认主条目的话，同一首歌会「有时有图、有时是色块」
               ——取决于哪个源排在前面（R73 用户报的「封面大多数都有」）。 */
            let fallback_artwork = members
                .iter()
                .map(|(_, _, track)| track_artwork(track))
                .find(|value| !value.is_empty());
            let base_artwork_empty = grouped["artwork"].as_str().map(str::trim).unwrap_or("").is_empty();
            if base_artwork_empty {
                if let Some(artwork) = fallback_artwork {
                    grouped["artwork"] = json!(artwork);
                }
            }
            grouped["sourceCount"] = json!(candidates.len());
            grouped["candidates"] = json!(candidates);
            Some(grouped)
        })
        .collect()
}

/// 曲目快照里的封面地址（`artwork` 优先，兼容旧字段 `cover`）。
fn track_artwork(track: &Value) -> String {
    ["artwork", "cover"]
        .iter()
        .filter_map(|key| track.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}
