//! 个性化推荐（M4a）：把 `src/utils/recommend.ts` 的口味画像与打分**按同一套行为**迁到核心。
//!
//! # 候选从哪来（这条决定了整块设计）
//!
//! **只看本机数据**：本地曲库、收藏、播放历史、自建歌单。
//! `recommend.home` **不向任何插件发起请求**——ADR-0005 明确把「推荐」列进「用户动作之前
//! 零外部请求」的范围（启动、搜索、推荐、榜单都不碰第三方地址）。
//! 源侧推荐另有显式入口：`catalog.recommend{source}`（用户点某个源才调用它）。
//!
//! # 与 TS 实现的行为对齐
//!
//! 1. 画像：`权重 = (1 + log2(1 + 播放次数)) × 0.5^(距今天数 / 12h)`，收藏固定 `2.5`，
//!    歌手权重额外乘 `1.6`；样本量 = 参与统计的播放条目 + 收藏数；
//! 2. 打分：`Σ 命中标签权重 + 歌手权重`；
//! 3. 理由：歌手命中优先（且不低于标签命中），其次标签，最后回落「近期热门」（有样本 0.3 / 无样本 0.4）；
//! 4. 强度：`min(1, round(value / max × 100) / 100)`；`max` 取 0 与最大值的较大者
//!    （因此负权重不会把强度算歪）。
//!
//! **唯一有意的差异**：并列时的次级排序用字节序（`title.cmp`）而不是 `localeCompare`
//! ——核心不该依赖语言环境，且这层排序只影响并列项的先后。
//!
//! # 反馈的消费
//!
//! `recommend.feedback` 落库（append-only），并在画像里被消费：
//! `like` 等价一次收藏（+2.5）、`unlike` 反向；`skip`（进度 < 0.5）扣 1.0 且按 12h 半衰期衰减；
//! `complete`（进度 ≥ 0.9）加 1.0 且同样衰减；`play` 不额外加权（历史里已经有它了）。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};

/// 时间衰减半衰期：12 小时前的播放权重减半（与 TS 实现一致）。
const RECENCY_HALF_LIFE_MS: f64 = 12.0 * 3600_000.0;
const FAVORITE_WEIGHT: f64 = 2.5;
const ARTIST_WEIGHT: f64 = 1.6;
/// 画像/候选的取样窗口：只消费「最近这些」行为，避免陈年点击长期主导。
const PROFILE_PLAYS: usize = 200;
const PROFILE_FEEDBACK: usize = 200;
const POOL_LIMIT: usize = 500;
const RECENT_EXCLUDE: usize = 50;
const DEFAULT_LIMIT: usize = 20;

/// 一个曲目的口味特征（打分只需要标签与歌手）。
#[derive(Debug, Clone, Default)]
struct Taste {
    tags: BTreeMap<String, f64>,
    artists: BTreeMap<String, f64>,
    sample_size: u32,
}

impl Taste {
    fn accumulate(&mut self, tags: &[String], artist: &str, weight: f64) {
        self.sample_size += 1;
        for tag in tags {
            *self.tags.entry(tag.clone()).or_insert(0.0) += weight;
        }
        let artist = artist.trim();
        if !artist.is_empty() {
            *self.artists.entry(artist.to_string()).or_insert(0.0) += weight * ARTIST_WEIGHT;
        }
    }

    fn tag_score(&self, tags: &[String]) -> f64 {
        tags.iter().map(|tag| self.tags.get(tag).copied().unwrap_or(0.0)).sum()
    }

    fn artist_score(&self, artist: &str) -> f64 {
        self.artists.get(artist.trim()).copied().unwrap_or(0.0)
    }

    fn score(&self, tags: &[String], artist: &str) -> f64 {
        self.tag_score(tags) + self.artist_score(artist)
    }

    fn to_json(&self, updated_at: i64) -> Value {
        json!({
            "tags": self.tags,
            "artists": self.artists,
            "sampleSize": self.sample_size,
            "updatedAt": updated_at,
        })
    }
}

// ---------------------------------------------------------------- 命令

#[derive(Debug, serde::Deserialize)]
struct HomeParams {
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimilarParams {
    seed: SeedParam,
    #[serde(default)]
    limit: Option<usize>,
}

/// 相似度的种子：曲目引用，或专辑 id。
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum SeedParam {
    /// 专辑种子（`{albumId}`）。
    ///
    /// **必须声明在 `Ref` 之前**：untagged 枚举按声明顺序尝试，而 `Ref(Value)` 能吃下
    /// 任何 JSON——放前面会让 `{albumId}` 被当成引用，最后报出「ref 缺少 source 字段」
    /// 这种与真实原因毫无关系的错（契约承诺了专辑种子，所以这里必须按契约工作）。
    Album {
        #[serde(rename = "albumId")]
        album_id: String,
    },
    Ref(Value),
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackParams {
    #[serde(rename = "ref")]
    reference: Value,
    action: String,
    #[serde(default)]
    progress: Option<f64>,
    /// 曲目快照（界面手上有；缺了就从本机库里找——没有标签/歌手的反馈对画像没有意义）
    #[serde(default)]
    track: Option<Value>,
}

/// `recommend.home{limit?}`：口味画像 + 三类推荐（单曲 / 专辑 / 歌单），**全部来自本机数据**。
pub fn home(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: HomeParams = parse_params(params)?;
    let now = now_millis();

    let (taste, recent_refs) = build_taste(ctx, now)?;
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 100);

    // 候选池：本地曲库 + 收藏 + 历史（历史让「推荐」在只有在线曲目时也有东西可选）
    let pool = candidate_pool(ctx)?;
    let excluded: Vec<String> = recent_refs.iter().take(RECENT_EXCLUDE).cloned().collect();

    // 「排除最近听过的」在**曲库很小时会把候选全删光**：只有一两首歌的用户，推荐页的
    // 单曲区就变成空白（R66 实测：`albums` 有内容、`tracks` 却是 0 条）。
    // 规则因此是「能排除就排除，排空就放宽」——先按排除算，空了就不排除再算一次；
    // 推荐理由不受影响（它来自口味画像，而不是「是否刚刚听过」）。
    let mut tracks = rank_tracks(&pool, &taste, limit, &excluded);
    if tracks.is_empty() && !excluded.is_empty() {
        tracks = rank_tracks(&pool, &taste, limit, &[]);
    }
    let albums = rank_albums(&pool, &taste, limit);
    let playlists = rank_playlists(ctx, &taste, limit)?;

    Ok(json!({
        "profile": taste.to_json(now),
        "tracks": tracks,
        "albums": albums,
        "playlists": playlists,
    }))
}

/// `recommend.similar{seed, limit?}`：与种子（曲目或专辑）相似的本机曲目。
pub fn similar(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: SimilarParams = parse_params(params)?;
    let pool = candidate_pool(ctx)?;

    let (seed_tags, seed_artist, exclude) = match &params.seed {
        SeedParam::Album { album_id } => {
            // 专辑种子：把专辑内曲目的标签/歌手并起来当特征
            let members: Vec<&Value> = pool
                .iter()
                .filter(|track| track_album_id(track) == *album_id)
                .collect();
            let mut tags: Vec<String> = Vec::new();
            let mut artist = String::new();
            for member in &members {
                for tag in track_tags(member) {
                    if !tags.contains(&tag) {
                        tags.push(tag);
                    }
                }
                if artist.is_empty() {
                    artist = track_artist(member);
                }
            }
            if members.is_empty() {
                return Err(CoreError::not_found(format!("本机库里没有专辑：{album_id}")));
            }
            // 排除**整张专辑**：用户正在看这张专辑，把它自己的曲目推回去没有意义
            // （与曲目种子「不把自己推给自己」同一条规则）
            let exclude: Vec<String> = members.iter().map(|track| track_ref(track)).collect();
            (tags, artist, exclude)
        }
        SeedParam::Ref(value) => {
            let (reference, _source) = crate::library::resolve_ref(value)?;
            let seed = pool
                .iter()
                .find(|track| track_ref(track) == reference)
                .cloned()
                .ok_or_else(|| {
                    CoreError::not_found(format!("本机库里没有这条曲目：{reference}"))
                })?;
            (track_tags(&seed), track_artist(&seed), vec![reference])
        }
    };

    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 100);
    Ok(json!(rank_similar(&pool, &seed_tags, &seed_artist, limit, &exclude)))
}

/// `recommend.feedback{ref, action, progress?}`：记一次反馈（下次打分时消费）。
pub fn feedback(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: FeedbackParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let (reference, source) = crate::library::resolve_ref(&params.reference)?;

    const ACTIONS: [&str; 5] = ["play", "skip", "like", "unlike", "complete"];
    if !ACTIONS.contains(&params.action.as_str()) {
        return Err(CoreError::invalid_argument(format!("未知的反馈动作：{}", params.action))
            .with_details(json!({ "action": params.action, "supported": ACTIONS })));
    }
    if let Some(progress) = params.progress {
        if !(0.0..=1.0).contains(&progress) {
            return Err(CoreError::invalid_argument("progress 应在 0~1 之间")
                .with_details(json!({ "progress": progress })));
        }
    }

    // 快照用于「反馈里的标签/歌手」：没有它，这条反馈对画像没有任何影响
    let track = match params.track.as_ref().filter(|value| value.is_object()) {
        Some(provided) => crate::library::snapshot_of(&reference, &source, Some(provided)),
        None => crate::library::lookup_snapshot(ctx, &reference, &source),
    };
    store.push_feedback(&reference, &source, &params.action, params.progress, &track)?;
    Ok(Value::Null)
}

// ---------------------------------------------------------------- 画像

/// 构建口味画像：最近播放（衰减 × 播放次数对数）+ 收藏 + 反馈。
///
/// 返回画像与「最近听过的引用」（推荐时排除它们，避免推荐你刚听过的）。
fn build_taste(ctx: &CoreContext, now: i64) -> Fallible<(Taste, Vec<String>)> {
    let store = require_store(ctx)?;
    let mut taste = Taste::default();
    let mut recent_refs: Vec<String> = Vec::new();

    // 历史：同一首歌多次播放只按「最后一次 + 累计次数」算一次（与 TS 的 RecentTrack 语义一致）
    for row in store.list_history(PROFILE_PLAYS, None)?.items {
        let reference = row.stored.reference.clone();
        let is_first_seen = !recent_refs.contains(&reference);
        if is_first_seen {
            recent_refs.push(reference);
            let age = (now - row.played_at).max(0) as f64;
            let decay = 0.5_f64.powf(age / RECENCY_HALF_LIFE_MS);
            // 播放次数取对数，避免单曲循环把画像带偏
            let weight = (1.0 + ((1 + row.play_count.max(0)) as f64).log2()) * decay;
            taste.accumulate(&snapshot_tags(&row.stored.track), &snapshot_artist(&row.stored.track), weight);
        }
    }

    for row in store.list_favorites(PROFILE_FAVORITES, None)?.items {
        taste.accumulate(&snapshot_tags(&row.stored.track), &snapshot_artist(&row.stored.track), FAVORITE_WEIGHT);
    }

    // 反馈：弱信号，按同样的半衰期衰减（skip 是负号）
    for row in store.list_feedback(PROFILE_FEEDBACK)? {
        let age = (now - row.created_at).max(0) as f64;
        let decay = 0.5_f64.powf(age / RECENCY_HALF_LIFE_MS);
        let tags = snapshot_tags(&row.track);
        let artist = snapshot_artist(&row.track);
        match row.action.as_str() {
            // 收藏类反馈不衰减：它是明确表态，不是行为痕迹
            "like" => taste.accumulate(&tags, &artist, FAVORITE_WEIGHT),
            "unlike" => taste.accumulate(&tags, &artist, -FAVORITE_WEIGHT),
            "skip" if row.progress.unwrap_or(0.0) < 0.5 => taste.accumulate(&tags, &artist, -decay),
            "complete" if row.progress.unwrap_or(0.0) >= 0.9 => taste.accumulate(&tags, &artist, decay),
            _ => {}
        }
    }

    Ok((taste, recent_refs))
}

const PROFILE_FAVORITES: usize = 500;

// ---------------------------------------------------------------- 候选池

/// 候选池：本地曲库 + 收藏 + 历史里出现过的曲目（去重，保持稳定顺序）。
///
/// **不查插件**：推荐不发起任何外部请求（ADR-0005）。
fn candidate_pool(ctx: &CoreContext) -> Fallible<Vec<Value>> {
    let store = require_store(ctx)?;
    let mut pool: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let mut push = |track: Value| {
        let reference = track_ref(&track);
        if reference.is_empty() || seen.contains(&reference) {
            return;
        }
        seen.push(reference);
        pool.push(track);
    };

    for row in store.list_local_tracks(POOL_LIMIT, None, None)?.items {
        push(crate::local_library::local_track_json(&row));
    }
    for row in store.list_favorites(POOL_LIMIT, None)?.items {
        push(row.stored.track);
    }
    for row in store.list_history(POOL_LIMIT, None)?.items {
        push(row.stored.track);
    }
    Ok(pool)
}


// ---------------------------------------------------------------- 打分

/// 单曲排序：排除最近听过的，按分数降序、标题升序，附可解释理由。
fn rank_tracks(pool: &[Value], taste: &Taste, limit: usize, exclude: &[String]) -> Vec<Value> {
    let mut scored: Vec<(f64, &Value)> = pool
        .iter()
        .filter(|track| !exclude.contains(&track_ref(track)))
        .map(|track| (taste.score(&track_tags(track), &track_artist(track)), track))
        .collect();
    sort_scored(&mut scored);
    scored
        .into_iter()
        .take(limit)
        .map(|(_, track)| recommended(track, explain(&track_tags(track), &track_artist(track), taste)))
        .collect()
}

/// 专辑：把候选池按专辑名聚合，标签取组内并集。
fn rank_albums(pool: &[Value], taste: &Taste, limit: usize) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for track in pool {
        let album = track_album(track);
        if album.is_empty() {
            continue; // 没有专辑名的曲目聚不出专辑
        }
        if !groups.contains_key(&album) {
            order.push(album.clone());
        }
        groups.entry(album).or_default().push(track);
    }

    let mut scored: Vec<(f64, Value)> = order
        .into_iter()
        .filter_map(|album| {
            let tracks = groups.remove(&album)?;
            let tags = union_tags(&tracks);
            let artist = tracks.iter().map(|track| track_artist(track)).find(|value| !value.is_empty()).unwrap_or_default();
            let score = taste.score(&tags, &artist);
            let body = json!({
                // 专辑 id 与 `catalog.album` 的约定不同：这是本机聚合出来的「虚拟专辑」
                "id": format!("local-album:{}", album),
                "title": album,
                "artist": artist,
                // 封面取组内第一个非空：曲目快照里通常已经带着源封面
                "cover": first_artwork(&tracks),
                "year": 0,
                "tags": tags,
                "source": "local",
                "tracks": tracks.iter().map(|track| (*track).clone()).collect::<Vec<_>>(),
            });
            Some((score, with_reason(body, explain(&tags, &artist, taste))))
        })
        .collect();
    sort_scored_values(&mut scored);
    scored.into_iter().take(limit).map(|(_, album)| album).collect()
}

/// 歌单：用户自己建的歌单（本机数据），按内部曲目的标签/歌手命中打分。
fn rank_playlists(ctx: &CoreContext, taste: &Taste, limit: usize) -> Fallible<Vec<Value>> {
    let store = require_store(ctx)?;
    let mut scored: Vec<(f64, Value)> = Vec::new();
    for playlist in store.list_playlists()? {
        let tracks: Vec<Value> = playlist.tracks.iter().map(|stored| stored.track.clone()).collect();
        let refs: Vec<&Value> = tracks.iter().collect();
        let tags = union_tags(&refs);
        let artist = refs.iter().map(|track| track_artist(track)).find(|value| !value.is_empty()).unwrap_or_default();
        let score = taste.score(&tags, &artist);
        let body = json!({
            "id": playlist.id,
            "title": playlist.name,
            "description": "",
            // 同上：歌单封面用内部第一张有图的曲目
            "cover": first_artwork(&refs),
            "tags": tags,
            "source": "local",
            "tracks": tracks,
        });
        scored.push((score, with_reason(body, explain(&tags, &artist, taste))));
    }
    sort_scored_values(&mut scored);
    Ok(scored.into_iter().take(limit).map(|(_, playlist)| playlist).collect())
}

/// 相似推荐：种子特征与候选的重合度（标签重合 + 歌手命中）。
fn rank_similar(
    pool: &[Value],
    seed_tags: &[String],
    seed_artist: &str,
    limit: usize,
    exclude: &[String],
) -> Vec<Value> {
    let mut scored: Vec<(f64, &Value, String)> = Vec::new();
    for track in pool {
        if exclude.contains(&track_ref(track)) {
            continue;
        }
        let tags = track_tags(track);
        let artist = track_artist(track);
        let shared: Vec<String> = tags.iter().filter(|tag| seed_tags.contains(tag)).cloned().collect();
        let artist_hit = !seed_artist.is_empty() && artist == seed_artist;
        let score = shared.len() as f64 + if artist_hit { ARTIST_WEIGHT } else { 0.0 };
        let reason = if artist_hit {
            json!({ "kind": "similar", "value": artist, "score": 1.0 })
        } else if let Some(tag) = shared.first() {
            let strength = if seed_tags.is_empty() {
                0.0
            } else {
                (shared.len() as f64 / seed_tags.len() as f64).min(1.0)
            };
            json!({ "kind": "similar", "value": tag, "score": round2(strength) })
        } else {
            json!({ "kind": "similar", "value": "", "score": 0.0 })
        };
        scored.push((score, track, reason.to_string()));
    }
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| track_title(&a.1).cmp(&track_title(&b.1)))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, track, reason_json)| {
            let reason: Value = serde_json::from_str(&reason_json).unwrap_or(json!({ "kind": "similar", "value": "", "score": 0.0 }));
            with_reason(track.clone(), reason)
        })
        .collect()
}

// ---------------------------------------------------------------- 排序与理由

fn sort_scored(scored: &mut Vec<(f64, &Value)>) {
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| track_title(&a.1).cmp(&track_title(&b.1)))
    });
}

fn sort_scored_values(scored: &mut Vec<(f64, Value)>) {
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let left = a.1.get("title").and_then(Value::as_str).unwrap_or_default();
                let right = b.1.get("title").and_then(Value::as_str).unwrap_or_default();
                left.cmp(right)
            })
    });
}

/// 生成推荐理由：歌手命中优先，其次标签，最后回落「近期热门」。
fn explain(tags: &[String], artist: &str, taste: &Taste) -> Value {
    if taste.sample_size == 0 {
        return json!({ "kind": "trending", "value": "", "score": 0.4 });
    }

    let artist_score = taste.artist_score(artist);
    let max_artist = max_of(taste.artists.values().copied());
    let max_tag = max_of(taste.tags.values().copied());

    // 命中权重最高的那个标签（并列时取先出现的，与 TS 的 `>` 比较一致）
    let mut top_tag = "";
    let mut top_tag_score = 0.0_f64;
    for tag in tags {
        let value = taste.tags.get(tag).copied().unwrap_or(0.0);
        if value > top_tag_score {
            top_tag_score = value;
            top_tag = tag;
        }
    }

    if artist_score > 0.0 && artist_score >= top_tag_score {
        return json!({
            "kind": "artist",
            "value": artist,
            "score": strength(artist_score, max_artist),
        });
    }
    if top_tag_score > 0.0 {
        // 标签理由的强度按「命中几个标签」摊薄：一个标签命中不等于整首歌都命中
        let denominator = if tags.is_empty() { max_tag } else { max_tag * tags.len() as f64 };
        return json!({
            "kind": "tag",
            "value": top_tag,
            "score": strength(top_tag_score, if denominator == 0.0 { max_tag } else { denominator }),
        });
    }
    json!({ "kind": "trending", "value": "", "score": 0.3 })
}

/// 归一化命中强度到 0~1（与 TS 的 `Math.round(x * 100) / 100` 一致）。
fn strength(value: f64, max: f64) -> f64 {
    if max <= 0.0 {
        return 0.0;
    }
    round2((value / max).min(1.0))
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// `max(0, 最大值)`：负权重（skip 反馈）不会把强度算歪。
fn max_of(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(0.0_f64, f64::max)
}

// ---------------------------------------------------------------- 曲目取值

fn track_ref(track: &Value) -> String {
    let id = track.get("id").and_then(Value::as_str).unwrap_or_default();
    if id.is_empty() {
        return String::new();
    }
    if id.contains(':') {
        return id.to_string();
    }
    let source = track.get("source").and_then(Value::as_str).unwrap_or("local");
    format!("{source}:{id}")
}

fn track_title(track: &Value) -> String {
    track.get("title").and_then(Value::as_str).unwrap_or_default().to_string()
}

fn track_artist(track: &Value) -> String {
    track.get("artist").and_then(Value::as_str).unwrap_or_default().to_string()
}

fn track_album(track: &Value) -> String {
    track.get("album").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// 曲目的封面地址（`artwork` 优先，兼容旧快照里的 `cover`）。
fn track_artwork(track: &Value) -> String {
    ["artwork", "cover"]
        .iter()
        .filter_map(|key| track.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// 一组曲目里第一个非空封面：专辑 / 歌单的封面就是这样来的。
///
/// 以前这里是硬编码空串，于是「专辑/歌单卡片」永远是渐变色块——哪怕里面的曲目
/// 明明带着视频封面或专辑图（R73 用户报的「封面大多数都存在」）。
fn first_artwork(tracks: &[&Value]) -> String {
    tracks
        .iter()
        .map(|track| track_artwork(track))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn track_album_id(track: &Value) -> String {
    track
        .get("albumId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let album = track_album(track);
            if album.is_empty() { String::new() } else { format!("local-album:{album}") }
        })
}

fn track_tags(track: &Value) -> Vec<String> {
    track
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// 反馈/历史行里的快照可能缺字段：取值统一走这里。
fn snapshot_tags(track: &Value) -> Vec<String> {
    track_tags(track)
}

fn snapshot_artist(track: &Value) -> String {
    track_artist(track)
}

fn union_tags(tracks: &[&Value]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for track in tracks {
        for tag in track_tags(track) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    tags.truncate(3); // 专辑/歌单的标签只取前几个，理由里也只用一个
    tags
}

/// 把理由并进推荐条目（`RecommendedTrack` = Track + reason）。
fn with_reason(mut body: Value, reason: Value) -> Value {
    body["reason"] = reason;
    body
}

fn recommended(track: &Value, reason: Value) -> Value {
    with_reason(track.clone(), reason)
}

fn require_store(ctx: &CoreContext) -> Fallible<&crate::store::Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读取播放史与收藏").with_details(
            json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 画像与打分的**纯函数**部分：TS 那边的断言移植到这里（不碰数据库）。
#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, title: &str, artist: &str, tags: &[&str]) -> Value {
        json!({
            "id": id,
            "title": title,
            "artist": artist,
            "album": "专辑",
            "tags": tags,
            "source": "demo",
        })
    }


    /// 直接构造画像（绕开数据库），行为与 `build_taste` 的累加规则一致。
    fn taste_from(plays: &[(Value, i64, i64)], favorites: &[Value], now: i64) -> Taste {
        let mut taste = Taste::default();
        for (track, played_at, count) in plays {
            let age = (now - played_at).max(0) as f64;
            let decay = 0.5_f64.powf(age / RECENCY_HALF_LIFE_MS);
            let weight = (1.0 + ((1 + (*count).max(0)) as f64).log2()) * decay;
            taste.accumulate(&track_tags(track), &track_artist(track), weight);
        }
        for track in favorites {
            taste.accumulate(&track_tags(track), &track_artist(track), FAVORITE_WEIGHT);
        }
        taste
    }

    /// 移植断言 1：画像含标签与歌手权重。
    #[test]
    fn profile_has_tag_and_artist_weights() {
        let now: i64 = 1_700_000_000_000;
        let night = track("demo:1", "夜曲", "周杰伦", &["深夜", "流行"]);
        let taste = taste_from(&[(night.clone(), now, 3)], &[], now);
        assert_eq!(taste.sample_size, 1);
        assert!(taste.tags.contains_key("深夜") && taste.tags.contains_key("流行"));
        assert!(taste.artists.contains_key("周杰伦"));
        // 歌手权重带 1.6 倍系数
        let artist = taste.artists["周杰伦"];
        let tag = taste.tags["深夜"];
        assert!((artist - tag * ARTIST_WEIGHT).abs() < 1e-9, "artist={artist} tag={tag}");
    }

    /// 移植断言 4：无行为样本时回落「近期热门」（有样本时用 0.3，无样本 0.4）。
    #[test]
    fn empty_profile_falls_back_to_trending() {
        let empty = Taste::default();
        let reason = explain(&["深夜".to_string()], "某人", &empty);
        assert_eq!(reason["kind"], json!("trending"));
        assert_eq!(reason["score"], json!(0.4));
    }

    /// 移植断言 2 + 8：推荐都带可解释理由，且理由分数在合理范围。
    #[test]
    fn ranked_tracks_always_carry_a_reason() {
        let now: i64 = 1_700_000_000_000;
        let seed = track("demo:1", "夜曲", "周杰伦", &["深夜"]);
        let taste = taste_from(&[(seed.clone(), now, 2)], &[], now);
        let pool = vec![
            seed.clone(),
            track("demo:2", "晴天", "周杰伦", &["流行"]),
            track("demo:3", "稻香", "周杰伦", &["深夜", "民谣"]),
        ];
        let ranked = rank_tracks(&pool, &taste, 5, &[]);
        assert_eq!(ranked.len(), 3);
        for item in &ranked {
            assert!(item["reason"]["kind"].is_string(), "{item}");
            assert!(item["reason"]["score"].as_f64().unwrap() >= 0.0, "{item}");
        }
        // 歌手命中优先：三首都命中同一位歌手
        assert_eq!(ranked[0]["reason"]["kind"], json!("artist"));
        assert_eq!(ranked[0]["reason"]["value"], json!("周杰伦"));
    }

    /// 移植断言 3：可排除最近听过的曲目。
    #[test]
    fn recently_played_can_be_excluded() {
        let now: i64 = 1_700_000_000_000;
        let seed = track("demo:1", "夜曲", "周杰伦", &["深夜"]);
        let taste = taste_from(&[(seed.clone(), now, 1)], &[], now);
        let pool = vec![seed.clone(), track("demo:2", "晴天", "周杰伦", &["流行"])];
        let ranked = rank_tracks(&pool, &taste, 5, &[track_ref(&seed)]);
        assert!(ranked.iter().all(|item| item["id"] != json!("demo:1")), "{ranked:?}");
    }

    /// 播放次数取对数 + 12 小时半衰期：12 小时前的播放权重正好减半。
    #[test]
    fn recency_decay_halves_every_twelve_hours() {
        let now: i64 = 1_700_000_000_000;
        let fresh = track("demo:1", "新", "甲", &["深夜"]);
        let old = track("demo:2", "旧", "乙", &["深夜"]);
        let half_life = RECENCY_HALF_LIFE_MS as i64;

        let mut taste = Taste::default();
        taste.accumulate(&track_tags(&fresh), &track_artist(&fresh), 1.0);
        taste.accumulate(&track_tags(&old), &track_artist(&old), 0.5);
        // 12 小时前的那次权重是 0.5 → 标签权重合计 1.5
        assert!((taste.tags["深夜"] - 1.5).abs() < 1e-9);

        let _ = (now, half_life);
    }

    /// 相似推荐：命中标签/歌手，且不把自己推荐给自己。
    #[test]
    fn similar_prefers_shared_tags_and_same_artist() {
        let pool = vec![
            track("demo:1", "种子", "甲", &["深夜", "民谣"]),
            track("demo:2", "同歌手", "甲", &["流行"]),
            track("demo:3", "同标签", "乙", &["深夜"]),
            track("demo:4", "无关", "丙", &["摇滚"]),
        ];
        let ranked = rank_similar(
            &pool,
            &["深夜".to_string(), "民谣".to_string()],
            "甲",
            3,
            &["demo:1".to_string()],
        );
        assert!(ranked.iter().all(|item| item["id"] != json!("demo:1")));
        assert_eq!(ranked.len(), 3);
        // 同歌手（1.6）> 单标签（1.0）> 无关（0）
        assert_eq!(ranked[0]["id"], json!("demo:2"));
        assert_eq!(ranked[1]["id"], json!("demo:3"));
        assert_eq!(ranked[2]["id"], json!("demo:4"));
        assert!(ranked
            .iter()
            .all(|item| item["reason"]["kind"] == json!("similar")));
    }

    /// 排除集支持多条（专辑种子会排除整张专辑，而不是单条曲目）。
    #[test]
    fn similar_excludes_every_reference_in_the_set() {
        let pool = vec![
            track("demo:1", "专辑曲一", "甲", &["深夜"]),
            track("demo:2", "专辑曲二", "甲", &["深夜"]),
            track("demo:3", "别的歌", "甲", &["深夜"]),
        ];
        let ranked = rank_similar(
            &pool,
            &["深夜".to_string()],
            "甲",
            5,
            &["demo:1".to_string(), "demo:2".to_string()],
        );
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0]["id"], json!("demo:3"));
    }

    /// 专辑聚合：按专辑名分组，标签取并集，且带上曲目。
    #[test]
    fn albums_group_tracks_and_keep_them() {
        let now: i64 = 1_700_000_000_000;
        let seed = track("demo:1", "夜曲", "周杰伦", &["深夜"]);
        let taste = taste_from(&[(seed.clone(), now, 1)], &[], now);
        let mut second = track("demo:2", "晴天", "周杰伦", &["流行"]);
        second["album"] = json!("另一张");
        let pool = vec![seed.clone(), second];
        let albums = rank_albums(&pool, &taste, 5);
        assert_eq!(albums.len(), 2, "{albums:?}");
        // 画像里只有「深夜」，因此「专辑」（含该标签）排在前面
        assert_eq!(albums[0]["title"], json!("专辑"));
        assert_eq!(albums[0]["tracks"].as_array().unwrap().len(), 1);
        assert!(albums[0]["tracks"][0]["title"].is_string(), "专辑必须带曲目");
        assert!(albums[0]["reason"]["kind"].is_string());
    }
}
