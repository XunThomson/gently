//! 播放缓存：把**用户真的播放过**的远端曲目落到 `<data>/cache/media/`，离线时优先用它。
//!
//! # 与「下载」的区别
//!
//! 下载是用户的资产：落到 `downloads/`、有任务列表、可以暂停/续传/删除文件；
//! 缓存是**透明加速层**：可随时整目录删除（契约 §9），有自己的上限，超出按最旧淘汰。
//!
//! # 策略
//!
//! - **只缓存播放过的**：`playback.resolve` 解析成功后在后台线程补全，不做预取；
//! - 单文件上限 [`MAX_FILE_BYTES`]，总量上限 [`MEDIA_LIMIT_BYTES`]，超过后淘汰最旧的；
//! - 缓存命中优先于插件解析（因此**插件被卸载/断网时仍能播已缓存的那首**）；
//! - 缓存失败只是少一份加速，绝不影响本次播放（错误只记 debug 日志）。
//!
//! # 文件布局
//!
//! `cache/media/<key>.<ext>` + 同名 `.json` 元信息（reference / quality / source / bytes / at）。
//! key = `sha256(reference|quality)` 前 32 位；扩展名来自媒体地址（未知按 m4a）。

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use crate::commands::CoreContext;
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::{DownloadEvent, HttpRequest, HttpTransport};

/// 媒体缓存总量上限（1 GiB）：超出后按最旧删除。
pub const MEDIA_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;
/// 用户可配的总量上限范围（设置页给的是几档固定值，这里再挡一次越界）。
pub const MIN_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_LIMIT_BYTES: u64 = 32 * 1024 * 1024 * 1024;
/// 单个缓存文件上限（256 MiB）：超大的文件不缓存（避免一条长音频吃掉整个预算）。
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// 同时进行的缓存补全线程数（播放本身不能被下载抢占）。
const MAX_CONCURRENT_FILLS: usize = 2;

/// 正在补全的缓存键（防重复下载同一首）。
#[derive(Default)]
pub struct CacheRegistry {
    inflight: Mutex<HashSet<String>>,
    active: AtomicUsize,
}

impl CacheRegistry {
    fn begin(&self, key: &str) -> bool {
        let Ok(mut inflight) = self.inflight.lock() else { return false };
        if inflight.contains(key) || self.active.load(Ordering::Relaxed) >= MAX_CONCURRENT_FILLS {
            return false;
        }
        inflight.insert(key.to_string());
        self.active.fetch_add(1, Ordering::Relaxed);
        true
    }

    fn finish(&self, key: &str) {
        if let Ok(mut inflight) = self.inflight.lock() {
            inflight.remove(key);
        }
        self.active.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 缓存键：同一首歌的不同音质是不同条目（音质由用户显式选择）。
pub fn media_key(reference: &str, quality: &str) -> String {
    let digest = crate::plugin::sha256_hex(format!("{reference}|{quality}").as_bytes());
    digest[..32].to_string()
}

/// 一次缓存命中。
pub struct CachedMedia {
    pub path: PathBuf,
    pub reference: String,
    pub quality: String,
}

/// 精确匹配（reference + quality）。
pub fn lookup_exact(paths: &crate::AppPaths, key: &str) -> Option<CachedMedia> {
    let dir = media_dir(paths);
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else { continue };
        if !name.starts_with(key) || name.ends_with(".json") || name.ends_with(".part") {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let meta = read_sidecar(&path);
        return Some(CachedMedia {
            path,
            reference: meta.as_ref().and_then(|value| text(value, "reference")).unwrap_or_default(),
            quality: meta.as_ref().and_then(|value| text(value, "quality")).unwrap_or_default(),
        });
    }
    None
}

/// 同一引用下的任意音质（离线兜底：用户当初缓的是「高品」，现在偏好「无损」也不该播不了）。
pub fn lookup_any(paths: &crate::AppPaths, reference: &str) -> Option<CachedMedia> {
    let dir = media_dir(paths);
    let mut best: Option<(u64, CachedMedia)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let sidecar = entry.path();
        if !sidecar.to_string_lossy().ends_with(".json") {
            continue;
        }
        let Some(meta) = read_json(&sidecar) else { continue };
        if text(&meta, "reference").as_deref() != Some(reference) {
            continue;
        }
        // `<file>.<ext>.json` → `<file>.<ext>`
        let Some(media_name) = sidecar.file_name().and_then(|value| value.to_str()) else { continue };
        let media_path = sidecar.with_file_name(media_name.trim_end_matches(".json"));
        if !media_path.is_file() {
            continue;
        }
        let at = meta.get("at").and_then(Value::as_u64).unwrap_or(0);
        let hit = CachedMedia {
            path: media_path,
            reference: reference.to_string(),
            quality: text(&meta, "quality").unwrap_or_default(),
        };
        if best.as_ref().map_or(true, |(best_at, _)| at > *best_at) {
            best = Some((at, hit));
        }
    }
    best.map(|(_, hit)| hit)
}

/// 在后台补全一首歌的缓存；已经缓存/正在缓存/超出并发时安静地跳过。
pub fn spawn_fill(
    ctx: &CoreContext,
    reference: String,
    quality: String,
    source: String,
    url: String,
    headers: Vec<(String, String)>,
) {
    let key = media_key(&reference, &quality);
    if lookup_exact(&ctx.paths, &key).is_some() {
        return;
    }
    if !ctx.cache_fills.begin(&key) {
        return;
    }

    let paths = ctx.paths.clone();
    let http = Arc::clone(&ctx.http);
    let registry = Arc::clone(&ctx.cache_fills);
    let thread_key = key.clone();
    let worker_key = key.clone();
    let spawned = thread::Builder::new()
        .name(format!("gently-cache-{}", &key[..8]))
        .spawn(move || {
            if let Err(error) = fill(
                &paths,
                http.as_ref(),
                &worker_key,
                &reference,
                &quality,
                &source,
                &url,
                &headers,
            ) {
                tracing::debug!(code = error.code.as_str(), "播放缓存未写入：{}", error.message);
            }
            registry.finish(&thread_key);
        });

    if spawned.is_err() {
        tracing::warn!("创建播放缓存线程失败");
        ctx.cache_fills.finish(&key);
    }
}

fn fill(
    paths: &crate::AppPaths,
    http: &dyn HttpTransport,
    key: &str,
    reference: &str,
    quality: &str,
    source: &str,
    url: &str,
    headers: &[(String, String)],
) -> Fallible<()> {
    // 缓存层也过一遍 SSRF 规则：地址由插件给出，不能因为「反正是存本地」就放松
    crate::plugin::require_public_https(url, "缓存地址")?;

    let ext = audio_ext_of(url).unwrap_or("m4a");
    let final_path = media_dir(paths).join(format!("{key}.{ext}"));
    let part_path = final_path.with_extension(format!("{ext}.part"));
    let Some(parent) = final_path.parent() else {
        return Err(CoreError::internal("缓存目录路径不合法"));
    };
    fs::create_dir_all(parent)
        .map_err(|err| CoreError::new(ErrorCode::LibraryIoError, format!("创建缓存目录失败：{err}")))?;

    let mut file = fs::File::create(&part_path)
        .map_err(|err| CoreError::new(ErrorCode::LibraryIoError, format!("创建缓存文件失败：{err}")))?;
    let mut written: u64 = 0;
    let mut too_big = false;
    let mut write_failed = false;

    let outcome = match http.download(
        &HttpRequest {
            method: "GET".into(),
            url: url.to_string(),
            headers: headers
                .iter()
                .filter(|(name, _)| !name.eq_ignore_ascii_case("range"))
                .cloned()
                .collect(),
            body: None,
        },
        &mut |event| match event {
            DownloadEvent::Start { status, .. } => status < 400,
            DownloadEvent::Chunk(chunk) => {
                written += chunk.len() as u64;
                if written > MAX_FILE_BYTES {
                    too_big = true;
                    return false;
                }
                if file.write_all(chunk).is_err() {
                    write_failed = true;
                    return false;
                }
                true
            }
        },
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            // 请求失败也要清掉半截文件：缓存目录里不该留 0 字节的残骸
            drop(file);
            let _ = fs::remove_file(&part_path);
            return Err(error);
        }
    };

    if outcome.status >= 400 || too_big || write_failed {
        drop(file);
        let _ = fs::remove_file(&part_path);
        if too_big {
            return Err(CoreError::new(
                ErrorCode::LibraryIoError,
                format!("文件超过单曲缓存上限（{} MiB），未缓存", MAX_FILE_BYTES / 1024 / 1024),
            ));
        }
        return Err(CoreError::new(ErrorCode::SourceUpstreamFailed, "缓存下载被上游拒绝"));
    }

    if let Err(err) = file.flush() {
        drop(file);
        let _ = fs::remove_file(&part_path);
        return Err(CoreError::new(ErrorCode::LibraryIoError, format!("写缓存失败：{err}")));
    }
    drop(file);

    // `.part` → 正式文件：目录里不出现「看起来完整、其实是半截」的缓存
    fs::rename(&part_path, &final_path).map_err(|err| {
        CoreError::new(ErrorCode::LibraryIoError, format!("缓存落盘失败：{err}"))
    })?;

    write_sidecar(
        &final_path,
        &json!({
            "reference": reference,
            "quality": quality,
            "source": source,
            "bytes": written,
            "at": now_secs(),
        }),
    );
    enforce_limit(paths);
    Ok(())
}

/// 总量上限：按 `at`（最后写入）从旧到新删，直到回到预算内。
fn enforce_limit(paths: &crate::AppPaths) {
    let limit = media_limit(paths);
    let dir = media_dir(paths);
    let Ok(entries) = fs::read_dir(&dir) else { return };

    let mut items: Vec<(u64, u64, PathBuf)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_file() || name.ends_with(".json") || name.ends_with(".part") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let at = read_sidecar(&path)
            .and_then(|value| value.get("at").and_then(Value::as_u64))
            .unwrap_or_else(|| mtime_secs(&meta));
        total += meta.len();
        items.push((at, meta.len(), path));
    }
    if total <= limit {
        return;
    }

    items.sort_by_key(|(at, _, _)| *at);
    for (_, size, path) in items {
        if total <= limit {
            break;
        }
        let sidecar = with_json_suffix(&path);
        if fs::remove_file(&path).is_ok() {
            let _ = fs::remove_file(sidecar);
            total = total.saturating_sub(size);
        }
    }
}

/// 用户设置文件的路径。
///
/// **刻意放在 `data/` 而不是 `cache/`**：`system.cacheClear{kind:"all"}` 会清空缓存目录，
/// 而「用户设的缓存上限」属于设置，不该被「清缓存」顺手重置。
fn settings_path(paths: &crate::AppPaths) -> PathBuf {
    paths.data.join("cache-settings.json")
}

/// 当前生效的总量上限：设置文件里的值（越界或读不出来 → 默认 1 GiB）。
pub fn media_limit(paths: &crate::AppPaths) -> u64 {
    fs::read_to_string(settings_path(paths))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("mediaLimitBytes").and_then(Value::as_u64))
        .map(|bytes| bytes.clamp(MIN_LIMIT_BYTES, MAX_LIMIT_BYTES))
        .unwrap_or(MEDIA_LIMIT_BYTES)
}

/// `system.cacheConfig{limitBytes}`：改总量上限并存盘，**立即**按新上限淘汰一次。
///
/// 存盘用「临时文件 + rename」：写到一半崩掉不该让设置变成半个文件（那会被当成
/// 「读不出来」而悄悄回落到默认值）。
pub fn set_limit(paths: &crate::AppPaths, limit_bytes: u64) -> Fallible<Value> {
    if !(MIN_LIMIT_BYTES..=MAX_LIMIT_BYTES).contains(&limit_bytes) {
        return Err(CoreError::invalid_argument(format!(
            "缓存上限必须在 {} ~ {} 字节之间",
            MIN_LIMIT_BYTES, MAX_LIMIT_BYTES
        ))
        .with_details(json!({
            "limitBytes": limit_bytes,
            "min": MIN_LIMIT_BYTES,
            "max": MAX_LIMIT_BYTES,
        })));
    }

    let path = settings_path(paths);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let payload = json!({ "mediaLimitBytes": limit_bytes }).to_string();
    let temp = path.with_extension("json.part");
    fs::write(&temp, payload.as_bytes())?;
    fs::rename(&temp, &path)?;

    // 调小上限时立刻生效：否则用户把 1 GiB 调到 128 MiB 之后，得等下一次写入才会瘦身
    enforce_limit(paths);
    tracing::info!(limit_bytes, "缓存上限已更新");
    Ok(status(paths))
}

/// `system.cacheStatus`：媒体 / 歌词与详情 / 封面三块的占用。
pub fn status(paths: &crate::AppPaths) -> Value {
    let (media_bytes, media_count) = dir_stats(&media_dir(paths), |name| {
        !name.ends_with(".json") && !name.ends_with(".part")
    });
    let (catalog_bytes, catalog_count) =
        dir_stats(&paths.cache.join("catalog"), |_| true);
    let (covers_bytes, covers_count) = dir_stats(&paths.cache.join("covers"), |_| true);

    json!({
        "mediaBytes": media_bytes,
        "mediaCount": media_count,
        "catalogBytes": catalog_bytes,
        "catalogCount": catalog_count,
        "coversBytes": covers_bytes,
        "coversCount": covers_count,
        "limitBytes": media_limit(paths),
        "limitMinBytes": MIN_LIMIT_BYTES,
        "limitMaxBytes": MAX_LIMIT_BYTES,
    })
}

/// `system.cacheClear{kind?}`：`media` / `catalog`（歌词与详情）/ `covers` / `all`（缺省）。
pub fn clear(paths: &crate::AppPaths, kind: &str) -> Fallible<Value> {
    let media = media_dir(paths);
    let catalog = paths.cache.join("catalog");
    let covers = paths.cache.join("covers");
    let dirs: Vec<&Path> = match kind {
        "media" => vec![media.as_path()],
        "catalog" => vec![catalog.as_path()],
        "covers" => vec![covers.as_path()],
        "all" => vec![media.as_path(), catalog.as_path(), covers.as_path()],
        other => {
            return Err(CoreError::invalid_argument(format!(
                "未知的缓存类型：{other}（可用 media / catalog / covers / all）"
            ))
            .with_details(json!({ "kind": other })))
        }
    };

    let mut removed_bytes: u64 = 0;
    let mut removed_files: u64 = 0;
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if fs::remove_file(&path).is_ok() {
                removed_bytes += size;
                removed_files += 1;
            }
        }
    }
    Ok(json!({ "removedBytes": removed_bytes, "removedFiles": removed_files }))
}

// ---------------------------------------------------------------- 内部

fn media_dir(paths: &crate::AppPaths) -> PathBuf {
    paths.cache.join("media")
}

fn audio_ext_of(url: &str) -> Option<&'static str> {
    const EXTENSIONS: &[&str] = &["mp3", "m4a", "m4s", "m4b", "aac", "flac", "ogg", "oga", "opus", "wav"];
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    EXTENSIONS.iter().find(|known| **known == ext).copied()
}

fn sidecar_of(path: &Path) -> PathBuf {
    with_json_suffix(path)
}

fn with_json_suffix(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    name.push_str(".json");
    path.with_file_name(name)
}

fn write_sidecar(path: &Path, value: &Value) {
    let sidecar = sidecar_of(path);
    let temp = sidecar.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string(value) {
        if fs::write(&temp, text).is_ok() {
            let _ = fs::rename(&temp, &sidecar);
        }
    }
}

fn read_sidecar(path: &Path) -> Option<Value> {
    read_json(&sidecar_of(path))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn dir_stats(dir: &Path, keep: impl Fn(&str) -> bool) -> (u64, u64) {
    let Ok(entries) = fs::read_dir(dir) else { return (0, 0) };
    let mut bytes = 0u64;
    let mut count = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !keep(&name) || !path.is_file() {
            continue;
        }
        bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        count += 1;
    }
    (bytes, count)
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}
