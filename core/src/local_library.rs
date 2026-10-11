//! 本地曲库命令：扫描 / 列表 / 移除（M3b）。
//!
//! # 扫描
//!
//! - 只认音频扩展名（其余文件连开都不开）；
//! - **快速重扫**：文件大小没变就跳过读标签——这是「1 万文件重复扫描」能秒回的关键；
//! - 读不到标签的文件**照样入库**（标题退回文件名）：扫描不该因为个别坏文件而漏掉歌；
//! - **已删除的条目**只在**本次扫描的目录内**清理（扫 A 目录不该删掉 B 目录的曲目）；
//! - 进度通过 `library:scan:progress`（`{dir, found, percent}`）推送：先数一遍音频文件
//!   拿到总数，进度条才是真的（只是目录遍历，比读标签便宜得多）。
//!
//! # 元数据
//!
//! 用 symphonia 读容器标签与时长（mp3/flac/ogg/mp4/wav）。ROADMAP 原计划用 `lofty`，
//! 但它不在本机 registry 缓存里（离线构建不可得），symphonia 已缓存且覆盖同样格式。
//!
//! # 删除文件
//!
//! `remove{deleteFile: true}` 会真的删磁盘文件，因此只接受**音频扩展名**的路径
//! （库里的一行被改坏也不至于删掉任意文件）；界面侧还要走二次确认。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTagKey, Visual};
use symphonia::core::probe::Hint;
use walkdir::WalkDir;

use crate::commands::{parse_params, CoreContext};
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::events::events;
use crate::store::{normalize_limit, LocalTrackInput};

/// 认得的音频扩展名（小写比较）。其余文件不读、不入库。
const AUDIO_EXTENSIONS: [&str; 9] =
    ["mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav"];

/// 每处理多少个文件推一次进度事件（太密会淹掉前端）。
const PROGRESS_EVERY: usize = 25;

#[derive(Debug, serde::Deserialize)]
struct ScanParams {
    dirs: Vec<String>,
    /// 缺省 true（递归扫描）
    #[serde(default)]
    recursive: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    cursor: Option<String>,
    /// 可选文本检索（走 FTS5，短词退回 LIKE）
    #[serde(default)]
    query: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    id: String,
    /// 缺省 false：**默认只从曲库移除，不删磁盘文件**（删文件必须由用户明确要求）
    #[serde(default)]
    delete_file: bool,
}

/// `library.local.scan{dirs, recursive?}`：扫描目录并入库，返回增删改统计。
pub fn scan(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: ScanParams = parse_params(params)?;
    if params.dirs.is_empty() {
        return Err(CoreError::invalid_argument("至少需要一个目录"));
    }

    let roots = resolve_roots(&params.dirs)?;
    let recursive = params.recursive.unwrap_or(true);
    let store = require_store(ctx)?;

    // 先数一遍音频文件：进度条需要总数（只是目录遍历，不读标签）
    let total: usize = roots.iter().map(|root| count_audio(root, recursive)).sum();

    let index = store.local_track_index()?;
    let mut inputs: Vec<LocalTrackInput> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut skipped = 0usize;
    let mut unreadable = 0usize;

    for root in &roots {
        let walker = WalkDir::new(root)
            .max_depth(if recursive { usize::MAX } else { 1 })
            .follow_links(false)
            .into_iter();
        for entry in walker.filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !is_audio_path(path) {
                continue;
            }
            scanned += 1;
            let size = entry.metadata().map(|meta| meta.len() as i64).unwrap_or(0);
            let id = local_id(path);
            seen.push(id.clone());

            // 快速重扫：大小没变说明文件没动过，不必再开一遍
            if index.get(&id).is_some_and(|(_, known)| *known == size) {
                skipped += 1;
            } else {
                let tags = read_tags(path);
                if !tags.readable {
                    unreadable += 1;
                }
                // 内嵌封面：抽出来落进封面缓存（失败只是「没有封面」，不影响入库）
                if let Some(visual) = tags.visual.as_ref() {
                    let store = crate::covers::CoverStore::new(ctx.paths.cache.join("covers"));
                    store.write(path, &visual.media_type, &visual.data);
                }
                inputs.push(LocalTrackInput {
                    id,
                    path: crate::paths::normalize_source_path(path),
                    file_name: entry.file_name().to_string_lossy().to_string(),
                    size,
                    title: tags.title,
                    artist: tags.artist,
                    album: tags.album,
                    duration_sec: tags.duration_sec,
                });
            }

            if scanned % PROGRESS_EVERY == 0 {
                emit_progress(ctx, root, scanned, total);
            }
        }
        emit_progress(ctx, root, scanned, total);
    }

    let outcome = store.upsert_local_tracks(&inputs)?;

    // 清理：只删「本次扫描范围内、这次没再见到」的条目。
    // 范围必须与**遍历深度**一致：非递归扫描不该把子目录里的曲目当成「已删除」。
    let stale: Vec<String> = index
        .iter()
        .filter(|(id, (path, _))| !seen.contains(id) && in_scan_scope(&roots, path, recursive))
        .map(|(id, _)| id.clone())
        .collect();
    let removed = store.remove_local_tracks(&stale)?;

    /* 被移出曲库的条目顺手清掉封面缓存（别留孤儿文件）。
       注意：**归一化后与仍活着的曲目同名**的旧行不能删封面——那是旧版本用另一种路径拼法
       录进来的重复行（R37 实测），活着的那一行还在用同一份封面文件。 */
    let covers = crate::covers::CoverStore::new(ctx.paths.cache.join("covers"));
    let live: Vec<String> = index
        .iter()
        .filter(|(id, _)| seen.contains(id))
        .map(|(_, (path, _))| crate::paths::normalize_source_path(Path::new(path)))
        .collect();
    for id in &stale {
        if let Some((path, _)) = index.get(id) {
            let normalized = crate::paths::normalize_source_path(Path::new(path));
            if live.contains(&normalized) {
                continue;
            }
            covers.remove(Path::new(&normalized));
        }
    }

    tracing::info!(scanned, added = outcome.added, updated = outcome.updated, removed, "本地曲库扫描完成");
    Ok(json!({
        "scanned": scanned,
        "added": outcome.added,
        "updated": outcome.updated,
        "removed": removed,
        "skipped": skipped,
        "unreadable": unreadable,
    }))
}

/// `library.local.list{limit?, cursor?, query?}`：本地曲库列表（含文本检索）。
pub fn list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: ListParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let page = store.list_local_tracks(
        normalize_limit(params.limit),
        params.cursor.as_deref(),
        params.query.as_deref(),
    )?;

    /* 列表里带上内嵌封面的回环地址（有封面才有这个字段；前端 `trackCoverStyle` 直接用）。
       封面字节由媒体代理按需读（`/cover/<name>`），列表本身只多一个短字符串。 */
    let items: Vec<Value> = page
        .items
        .iter()
        .map(|row| {
            let mut value = local_track_json(row);
            if let Some(url) = ctx
                .streams
                .cover_url(Path::new(&row.path))
                .ok()
                .flatten()
            {
                value["artwork"] = Value::String(url);
            }
            value
        })
        .collect();

    let mut payload = json!({
        "items": items,
        "hasMore": page.next_cursor.is_some(),
        "total": page.total,
    });
    if let Some(cursor) = page.next_cursor {
        payload["nextCursor"] = json!(cursor);
    }
    Ok(payload)
}

/// `library.local.remove{id, deleteFile?}`：从曲库移除（可选连磁盘文件一起删）。
pub fn remove(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: RemoveParams = parse_params(params)?;
    let store = require_store(ctx)?;

    let row = store
        .get_local_track(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("曲库中没有这条本地曲目：{}", params.id)))?;

    if params.delete_file {
        let path = PathBuf::from(&row.path);
        // 只有音频扩展名的路径才允许删：库里的一行被改坏也不至于删掉任意文件
        if !is_audio_path(&path) {
            return Err(CoreError::invalid_argument(format!(
                "拒绝删除非音频文件：{}",
                row.path
            ))
            .with_details(json!({ "path": row.path })));
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            // 文件已经不在了：不当作失败（用户意图是「让它消失」），照常删库记录
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(CoreError::new(
                    ErrorCode::LibraryIoError,
                    format!("删除文件失败：{err}"),
                )
                .with_details(json!({ "path": row.path })));
            }
        }
    }

    store.remove_local_tracks(&[params.id])?;
    /* 封面缓存跟着走：曲目都不在库里了，缩略图没有留着的理由 */
    crate::covers::CoverStore::new(ctx.paths.cache.join("covers")).remove(Path::new(&row.path));
    Ok(Value::Null)
}

// ---------------------------------------------------------------- 内部

fn require_store(ctx: &CoreContext) -> Fallible<&crate::store::Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写本地曲库").with_details(
            json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

/// 目录必须是存在且可读的目录；相对路径按当前工作目录解析。
fn resolve_roots(dirs: &[String]) -> Fallible<Vec<PathBuf>> {
    let mut roots = Vec::new();
    for dir in dirs {
        let path = PathBuf::from(dir);
        if !path.is_dir() {
            return Err(CoreError::invalid_argument(format!("不是目录：{dir}"))
                .with_details(json!({ "dir": dir })));
        }
        roots.push(path);
    }
    Ok(roots)
}

/// 扫描根目录的字符串形式（与曲目路径同一份归一化，前缀比较才可靠）。
fn normalized_root(root: &Path) -> String {
    crate::paths::normalize_source_path(root)
}

/// 路径是否在本次扫描范围内。
///
/// 递归 = 目录前缀（带分隔符比较，避免 `C:/music` 命中 `C:/music2`）；
/// 非递归 = 只有**直接位于**该目录下的文件算数（子目录里的曲目不在本次范围内，
/// 清理时也就不能把它们当成「文件已删除」）。
fn in_scan_scope(roots: &[PathBuf], path: &str, recursive: bool) -> bool {
    // 库里的路径可能是**旧版本写下的非归一形式**（例如重复分隔符）：先按同一份规则归一，
    // 否则这些行永远不在「本次扫描范围」内，等于永远清不掉（R37 实测撞到两行同一文件）。
    let path = crate::paths::normalize_source_path_str(path);
    let path = path.as_str();
    roots.iter().any(|root| {
        let root = normalized_root(root);
        let root = root.trim_end_matches('/');
        if recursive {
            path == root || path.starts_with(&format!("{root}/"))
        } else {
            path.rsplit_once('/').is_some_and(|(parent, _)| parent == root)
        }
    })
}

/// 曲目 id：`local:<规范化路径>`（正斜杠、折叠重复分隔符，跨平台稳定）。
///
/// 归一化与封面文件名、库里的 `path` 列共用同一份实现——否则「同一文件两种写法」会变成两行曲目。
fn local_id(path: &Path) -> String {
    format!("local:{}", crate::paths::normalize_source_path(path))
}

/// 扩展名白名单的唯一实现：扫描与本地流代理共用（能被扫到的文件才允许被代理播放）。
pub(crate) fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
}

fn count_audio(root: &Path, recursive: bool) -> usize {
    WalkDir::new(root)
        .max_depth(if recursive { usize::MAX } else { 1 })
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_audio_path(entry.path()))
        .count()
}

fn emit_progress(ctx: &CoreContext, dir: &Path, found: usize, total: usize) {
    let percent = if total == 0 { 100 } else { (found * 100 / total).min(100) };
    ctx.events.emit(
        events::LIBRARY_SCAN_PROGRESS,
        json!({ "dir": normalized_root(dir), "found": found, "percent": percent }),
    );
}

/// 读到的标签（读不到时 title 退回文件名，`readable=false` 只用于统计）。
struct Tags {
    title: String,
    /// 标签里的标题（`title` 初值是文件名兜底，因此要单独记住标签是否给过标题）
    title_from_tag: Option<String>,
    artist: String,
    album: String,
    duration_sec: i64,
    readable: bool,
    /// 内嵌封面（第一个 visual）：扫描时落进封面缓存，列表里给回环地址
    visual: Option<Visual>,
}

fn read_tags(path: &Path) -> Tags {
    let fallback = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut tags = Tags {
        title: fallback,
        title_from_tag: None,
        artist: String::new(),
        album: String::new(),
        duration_sec: 0,
        readable: false,
        visual: None,
    };

    let Ok(file) = std::fs::File::open(path) else { return tags };
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|ext| ext.to_str()) {
        hint.with_extension(ext);
    }

    let Ok(mut probed) = symphonia::default::get_probe().format(
        &hint,
        stream,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) else {
        return tags;
    };
    tags.readable = true;

    // 标签有两个来源，**必须都看**：
    //   - `probed.metadata`：探测阶段**链式**读到的元数据。mp3 的 ID3v2（标题/歌手/专辑/**封面**）
    //     只在这里 —— symphonia 0.5.5 的 mp3 demuxer 自己不解析 ID3v2，`format.metadata()` 是空的；
    //   - `format.metadata()`：容器自己的元数据（FLAC 的 PICTURE 块、Ogg 的 Vorbis comment 等）。
    // 只读后者会让最常见的 mp3 丢失全部标签与封面（实测确认过），所以两边都取、先容器后链式。
    let chained = probed
        .metadata
        .get()
        .and_then(|metadata| metadata.current().cloned());
    let mut format = probed.format;
    // 时长来自第一条轨道的解码参数：帧数 / 采样率（缺 Xing/Vorbis 头的 mp3 可能没有帧数）
    if let Some(track) = format.tracks().first() {
        let params = &track.codec_params;
        if let (Some(frames), Some(rate)) = (params.n_frames, params.sample_rate) {
            if rate > 0 {
                tags.duration_sec = (frames / u64::from(rate)) as i64;
            }
        }
    }

    let container = format.metadata().current().cloned();
    for revision in [container.as_ref(), chained.as_ref()].into_iter().flatten() {
        // 内嵌封面：只取第一个（多图的情况通常是封面 + 封底，列表缩略图用第一张）
        if tags.visual.is_none() {
            tags.visual = revision.visuals().first().cloned();
        }
        for tag in revision.tags() {
            let text = tag.value.to_string();
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => {
                    if tags.title_from_tag.is_none() {
                        tags.title_from_tag = Some(text.to_string());
                    }
                }
                Some(StandardTagKey::Artist) | Some(StandardTagKey::AlbumArtist) => {
                    if tags.artist.is_empty() {
                        tags.artist = text.to_string();
                    }
                }
                Some(StandardTagKey::Album) => {
                    if tags.album.is_empty() {
                        tags.album = text.to_string();
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(title) = tags.title_from_tag.take() {
        tags.title = title;
    }

    tags
}

/// 库里存的快照 → 下发前刷新**本地曲目的封面地址**。
///
/// 快照会带上当时的 `artwork`（回环地址），而回环端口**每次启动都会变**：直接下发一个旧端口的
/// 地址，WebView 只会拿到一张加载失败的图（R40 实测：收藏页那一行没有封面，本地页却有）。
/// 本地封面的名字由**路径**派生，所以这里能按路径重新签发一个当前有效的地址。
///
/// 非本地来源（插件给的封面是外网/HTTPS 地址）与拿不到路径的快照原样返回。
pub(crate) fn refresh_local_artwork(
    streams: &crate::media::StreamRegistry,
    track: &mut Value,
) {
    if track.get("source").and_then(Value::as_str) != Some("local") {
        return;
    }
    let Some(path) = track.get("path").and_then(Value::as_str) else { return };
    match streams.cover_url(Path::new(path)) {
        Ok(Some(url)) => {
            track["artwork"] = Value::String(url);
        }
        Ok(None) => {
            // 封面没了（文件被删/缓存被清）：干脆去掉，让界面退回渐变而不是显示破图
            if let Some(map) = track.as_object_mut() {
                map.remove("artwork");
            }
        }
        Err(_) => {}
    }
}

/// 本地曲目 → 契约里的 `Track`（`library.local.list` 与推荐候选共用同一形状）。
pub(crate) fn local_track_json(row: &crate::store::LocalTrackRow) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "artist": row.artist,
        "album": row.album,
        "duration": mmss(row.duration_sec),
        "durationSec": row.duration_sec,
        // 本地曲目的 source 恒为 `local`：播放时走本地流代理，不是插件
        "source": "local",
        "gradient": "",
        "tags": [],
        "path": row.path,
        "fileName": row.file_name,
        "sizeText": size_text(row.size),
        "sizeBytes": row.size,
        "addedAt": row.added_at,
    })
}

/// `226` → `3:46`
fn mmss(seconds: i64) -> String {
    let seconds = seconds.max(0);
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// 人类可读大小（单位语言中立，不进 i18n）。
fn size_text(bytes: i64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let bytes = bytes.max(0) as f64;
    if bytes >= MB {
        format!("{:.1} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes / KB)
    } else {
        format!("{bytes:.0} B")
    }
}
