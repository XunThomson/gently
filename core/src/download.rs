//! 下载域：任务状态机 + 后台下载线程（M3 最后一块）。
//!
//! # 为什么每个任务一个线程
//!
//! 下载是**长任务**：命令必须立刻返回任务对象，进度靠 `download:progress` 事件推送。
//! 与插件宿主、搜索 fan-out 同一套简单模型：线程内是阻塞 IO，控制靠原子标志。
//!
//! # 暂停 / 续传 / 取消
//!
//! 线程不做「挂起自身」，而是**看标志位退出**：`pause` 置 `paused`，线程在下一次分块回调
//! 返回 false、把已收字节数落库、状态改 `paused` 后结束。`resume` 重新起线程，带
//! `Range: bytes=<offset>-` 续传。
//!
//! **上游忽略了 Range（回 200）时必须从头写**：这是唯一诚实的选择——把第二份完整响应
//! 追加到半截文件后面，只会得到一个坏文件（有测试锁定）。
//!
//! `remove` 置 `cancelled`：线程退出并删掉半成品文件，**不动库记录**（命令自己删）。
//!
//! # 落盘
//!
//! 先写 `<file>.part`，完成后 rename 成最终名：下载目录里不该出现「看起来完整、
//! 其实是半截」的文件。文件名来自曲目（`歌手 - 标题.<ext>`），非法字符替换掉。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use serde_json::{json, Value};

use crate::commands::CoreContext;
use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::events::{events, EventSink};
use crate::plugin::{DownloadEvent, HttpRequest, HttpTransport, PluginHost};
use crate::store::{
    DownloadRow, NewDownload, STATUS_DONE, STATUS_DOWNLOADING, STATUS_ERROR, STATUS_PAUSED,
    STATUS_PENDING,
};

/// 进度事件与落库的节流：每 512 KiB 或 500ms 一次（太密会淹掉前端与 WAL）。
const FLUSH_BYTES: u64 = 512 * 1024;
const FLUSH_MILLIS: u128 = 500;

/// 运行中任务的控制位。
#[derive(Default)]
struct Control {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

/// 下载任务控制登记表（`CoreContext` 持有）。
#[derive(Default)]
pub struct DownloadRegistry {
    controls: Mutex<HashMap<String, Arc<Control>>>,
    counter: AtomicU64,
}

impl DownloadRegistry {
    pub fn next_id(&self) -> String {
        let seq = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("dl-{}-{seq}", now_millis())
    }

    fn register(&self, id: &str) -> Arc<Control> {
        let control = Arc::new(Control::default());
        if let Ok(mut controls) = self.controls.lock() {
            controls.insert(id.to_string(), Arc::clone(&control));
        }
        control
    }

    fn existing(&self, id: &str) -> Option<Arc<Control>> {
        self.controls.lock().ok()?.get(id).map(Arc::clone)
    }

    fn finish(&self, id: &str) {
        if let Ok(mut controls) = self.controls.lock() {
            controls.remove(id);
        }
    }

    /// 置暂停位（返回是否真的有在跑的任务）。
    fn pause(&self, id: &str) -> bool {
        match self.existing(id) {
            Some(control) => {
                control.paused.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// 置取消位（同时置暂停位，让分块回调立刻返回 false）。
    fn cancel(&self, id: &str) -> bool {
        match self.existing(id) {
            Some(control) => {
                control.cancelled.store(true, Ordering::Relaxed);
                control.paused.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

// ---------------------------------------------------------------- 命令

#[derive(Debug, serde::Deserialize)]
struct ListParams {
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    #[serde(rename = "ref")]
    reference: Value,
    #[serde(default)]
    quality: Option<String>,
    /// 目标目录（缺省 `<data>/downloads`）
    #[serde(default)]
    dir: Option<String>,
    /// 曲目快照（界面手上有；缺了就退化成占位曲目）
    #[serde(default)]
    track: Option<Value>,
}

#[derive(Debug, serde::Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    id: String,
    /// 缺省 false：**默认只移除任务记录**（已完成的文件是用户的资产）
    #[serde(default)]
    delete_file: bool,
}

/// `download.list{status?}`：全部任务（可按状态过滤）。
///
/// **顺带自愈**：库里状态是 `downloading` / `pending`、但进程里没有对应下载线程的任务，
/// 说明上次是**被杀/崩溃**结束的（线程随着进程一起没了）。不修正的话，界面上它会永远停在
/// 「下载中」：进度不动、点「暂停」得到 `invalid_argument`、点「继续」又被当成已经在跑。
/// 这里就地改成 `paused` 并落库——用户点「继续」即可按已收字节续传。
pub fn list(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: ListParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let mut rows = store.list_downloads()?;

    for row in rows.iter_mut() {
        let interrupted = matches!(row.status.as_str(), STATUS_DOWNLOADING | STATUS_PENDING);
        if interrupted && ctx.downloads.existing(&row.id).is_none() {
            if store.set_download_status(&row.id, STATUS_PAUSED).is_ok() {
                tracing::info!(id = %row.id, from = %row.status, "恢复到上次中断的下载任务（标记为暂停）");
                row.status = STATUS_PAUSED.to_string();
            }
        }
    }

    let items: Vec<Value> = rows
        .iter()
        .filter(|row| match params.status.as_deref() {
            Some(status) => row.status == status,
            None => true,
        })
        .map(task_json)
        .collect();
    Ok(Value::Array(items))
}

/// `download.create{ref, quality?, dir?, track?}`：建任务并**立刻开始下载**。
pub fn create(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: CreateParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let (reference, source) = crate::library::resolve_ref(&params.reference)?;
    // 下载线程要调插件的 getMediaSource：先把已启用的插件装进沙箱
    // （与播放/搜索同一入口，否则会拿到「插件未加载」）
    crate::catalog::ensure_loaded(ctx)?;

    if source == "local" {
        return Err(CoreError::invalid_argument("本地曲目不需要下载（文件已经在本机）"));
    }

    let quality = params.quality.unwrap_or_else(|| "standard".to_string());
    let track = crate::library::snapshot_of(&reference, &source, params.track.as_ref());
    let target_dir = match params.dir.as_deref().map(str::trim).filter(|dir| !dir.is_empty()) {
        Some(dir) => {
            let path = PathBuf::from(dir);
            if !path.is_dir() {
                return Err(CoreError::invalid_argument(format!("目标目录不存在：{dir}"))
                    .with_details(json!({ "dir": dir })));
            }
            path
        }
        None => ctx.paths.downloads.clone(),
    };

    let id = ctx.downloads.next_id();
    let final_path = target_dir.join(file_name_for(&track, &reference));
    let part_path = part_path_of(&final_path);

    let row = store.insert_download(&NewDownload {
        id: id.clone(),
        reference: reference.clone(),
        source: source.clone(),
        quality: quality.clone(),
        track: track.clone(),
        path: final_path.to_string_lossy().replace('\\', "/"),
    })?;

    spawn_worker(ctx, id, reference, source, quality, final_path, part_path, 0);
    Ok(task_json(&row))
}

/// `download.pause{id}`：停在下一次分块回调处，进度落库。
pub fn pause(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let row = store
        .get_download(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("下载任务不存在：{}", params.id)))?;

    if row.status == STATUS_DONE || row.status == STATUS_ERROR {
        return Err(CoreError::invalid_argument("任务已结束，无法暂停")
            .with_details(json!({ "status": row.status })));
    }
    ctx.downloads.pause(&params.id);
    // 线程退出时会自己写 paused；这里先落状态，界面立刻有反馈
    store.set_download_status(&params.id, STATUS_PAUSED)?;
    let row = store.get_download(&params.id)?.unwrap_or(row);
    Ok(task_json(&row))
}

/// `download.resume{id}`：从已收字节数续传（上游不支持 Range 时从头开始）。
pub fn resume(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: IdParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let row = store
        .get_download(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("下载任务不存在：{}", params.id)))?;

    match row.status.as_str() {
        STATUS_DONE => return Err(CoreError::invalid_argument("任务已完成，无需续传")),
        // 已经在跑：直接回当前状态（重复点击不该起两个线程）
        STATUS_DOWNLOADING if ctx.downloads.existing(&params.id).is_some() => return Ok(task_json(&row)),
        _ => {}
    }

    crate::catalog::ensure_loaded(ctx)?;

    let Some(path) = row.path.clone() else {
        return Err(CoreError::internal("任务缺少目标路径"));
    };
    let final_path = PathBuf::from(&path);
    let part_path = part_path_of(&final_path);
    // 半成品文件是续传的依据：它可能比库里的 received 更长（节流窗口内没落库），以文件为准
    let offset = std::fs::metadata(&part_path).map(|meta| meta.len()).unwrap_or(0);

    store.set_download_status(&params.id, STATUS_PENDING)?;
    spawn_worker(
        ctx,
        row.id.clone(),
        row.reference.clone(),
        row.source.clone(),
        row.quality.clone(),
        final_path,
        part_path,
        offset,
    );
    let row = store.get_download(&params.id)?.unwrap_or(row);
    Ok(task_json(&row))
}

/// `download.remove{id, deleteFile?}`：移除任务（缺省只删记录；半成品一律清掉）。
pub fn remove(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let params: RemoveParams = parse_params(params)?;
    let store = require_store(ctx)?;
    let row = store
        .get_download(&params.id)?
        .ok_or_else(|| CoreError::not_found(format!("下载任务不存在：{}", params.id)))?;

    ctx.downloads.cancel(&params.id);
    store.delete_download(&params.id)?;

    if let Some(path) = row.path.as_deref() {
        let final_path = PathBuf::from(path);
        // 半成品是垃圾：无论是否 deleteFile 都清掉
        let _ = std::fs::remove_file(part_path_of(&final_path));
        if params.delete_file && row.status == STATUS_DONE {
            match std::fs::remove_file(&final_path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(CoreError::new(ErrorCode::LibraryIoError, format!("删除文件失败：{err}"))
                        .with_details(json!({ "path": path })));
                }
            }
        }
    }
    Ok(Value::Null)
}

/// `download.clearFinished`：清理已完成/失败的**记录**（不删文件）。
pub fn clear_finished(ctx: &CoreContext, params: Value) -> Fallible<Value> {
    let _ = parse_params::<Value>(params)?;
    let store = require_store(ctx)?;
    let removed = store.clear_finished_downloads()?;
    Ok(json!({ "removed": removed }))
}

// ---------------------------------------------------------------- 下载线程

/// 起一个下载线程（`offset` 是已下载字节数，0 表示从头下）。
#[allow(clippy::too_many_arguments)]
fn spawn_worker(
    ctx: &CoreContext,
    id: String,
    reference: String,
    source: String,
    quality: String,
    final_path: PathBuf,
    part_path: PathBuf,
    offset: u64,
) {
    let control = ctx.downloads.register(&id);
    let store = ctx.store.clone();
    let sink = Arc::clone(&ctx.events);
    let registry = Arc::clone(&ctx.downloads);
    let http = Arc::clone(&ctx.http);
    let plugins = Arc::clone(&ctx.plugins);

    // 线程名与错误分支都要 id，但闭包会把它 move 走：先留一份
    let spawn_id = id.clone();
    let spawned = thread::Builder::new()
        .name(format!("gently-download-{id}"))
        .spawn(move || {
            // worker 自己留一份 id，闭包后续还要用它写库/发事件
            let worker = Worker {
                plugins,
                http,
                sink,
                control: Arc::clone(&control),
                id: id.clone(),
                store: store.clone(),
            };
            let outcome = worker.run(&source, &reference, &quality, offset, &part_path, &final_path);

            match (outcome, store.as_ref()) {
                (Ok(bytes), Some(store)) => {
                    let _ = store.update_download(&id, STATUS_DONE, bytes as i64, Some(bytes as i64), None, 0);
                    worker.sink.emit(
                        events::DOWNLOAD_DONE,
                        json!({
                            "id": id,
                            "path": final_path.to_string_lossy().replace('\\', "/"),
                            "bytes": bytes,
                        }),
                    );
                }
                (Ok(_), None) => {}
                (Err(error), store) => {
                    if error.code == ErrorCode::Cancelled {
                        // 暂停/取消：进度已经落盘，状态由命令或这里写
                        if let Some(store) = store {
                            let _ = store.set_download_status(&id, STATUS_PAUSED);
                        }
                    } else {
                        if let Some(store) = store {
                            let _ = store.update_download(&id, STATUS_ERROR, 0, None, Some(&error.message), 0);
                        }
                        worker.sink.emit(
                            events::DOWNLOAD_ERROR,
                            json!({ "id": id, "code": error.code.as_str(), "message": error.message }),
                        );
                    }
                }
            }
            registry.finish(&id);
        });

    if spawned.is_err() {
        tracing::error!(download = %spawn_id, "创建下载线程失败");
        let _ = ctx.downloads.cancel(&spawn_id);
    }
}

/// 一个下载线程用到的东西（省得把十个参数传来传去）。
struct Worker {
    plugins: Arc<PluginHost>,
    http: Arc<dyn HttpTransport>,
    sink: Arc<dyn EventSink>,
    control: Arc<Control>,
    id: String,
    store: Option<crate::store::Store>,
}

impl Worker {
    /// 解析地址 → 流式写入 `.part` → 成功后 rename 到最终名。
    fn run(
        &self,
        source: &str,
        reference: &str,
        quality: &str,
        offset: u64,
        part_path: &Path,
        final_path: &Path,
    ) -> Fallible<u64> {
        let raw_id = reference.split_once(':').map(|(_, raw)| raw).unwrap_or(reference);
        let args = json!([{ "id": raw_id, "source": source }, quality]).to_string();

        let raw = self.plugins.call(source, "getMediaSource", &args)?;
        let Some(media) = crate::media::parse_media(&raw)? else {
            return Err(CoreError::new(ErrorCode::SourceUpstreamFailed, "该音源没有可下载的地址"));
        };
        // 下载地址与播放同一套 SSRF 规则（地址由播放链路同一份实现拦）
        crate::plugin::require_public_https(&media.url, "下载地址")?;



        let mut headers: Vec<(String, String)> = media
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("range"))
            .cloned()
            .collect();
        if offset > 0 {
            headers.push(("Range".to_string(), format!("bytes={offset}-")));
        }

        let mut state = WriteState {
            file: None,
            written: 0,
            total: None,
            resuming: false,
            failure: None,
            offset,
            last_flush: Instant::now(),
            flushed: 0,
        };

        let outcome = {
            let control = Arc::clone(&self.control);
            let sink = Arc::clone(&self.sink);
            let id = self.id.clone();
            let mut on_event = |event: DownloadEvent<'_>| -> bool {
                state.handle(event, part_path, &control, &sink, &id)
            };
            self.http.download(
                &HttpRequest { method: "GET".into(), url: media.url.clone(), headers, body: None },
                &mut on_event,
            )?
        };

        if let Some(err) = state.failure {
            return Err(CoreError::new(ErrorCode::LibraryIoError, format!("写盘失败：{err}")));
        }
        if outcome.status >= 400 {
            return Err(CoreError::new(
                ErrorCode::SourceUpstreamFailed,
                format!("下载被上游拒绝（HTTP {}）", outcome.status),
            ));
        }
        if outcome.aborted {
            return Err(CoreError::new(ErrorCode::Cancelled, "下载已暂停"));
        }
        if let Some(file) = state.file.as_mut() {
            file.flush().map_err(|err| CoreError::new(ErrorCode::LibraryIoError, format!("写盘失败：{err}")))?;
        }

        // 完成：`.part` → 最终文件（下载目录里不该有「看着完整其实是半截」的文件）。
        // 真实扩展名只有解析出媒体地址才知道：建任务时只能猜，这里按实际地址改写
        // （代理按扩展名给 Content-Type，猜错会让回放失败），并把新路径写回库。
        let final_path = match known_extension(&media.url) {
            Some(ext) if final_path.extension().and_then(|value| value.to_str()) != Some(ext.as_str()) => {
                let corrected = final_path.with_extension(&ext);
                if let Some(store) = &self.store {
                    let _ = store.set_download_path(&self.id, &corrected.to_string_lossy().replace('\\', "/"));
                }
                corrected
            }
            _ => final_path.to_path_buf(),
        };
        std::fs::rename(part_path, &final_path).map_err(|err| {
            CoreError::new(ErrorCode::LibraryIoError, format!("重命名下载文件失败：{err}"))
                .with_details(json!({ "path": final_path.to_string_lossy() }))
        })?;
        self.sink.emit(
            events::DOWNLOAD_PROGRESS,
            json!({ "id": self.id, "received": state.written, "total": state.total, "speed": 0 }),
        );
        Ok(state.written)
    }
}

/// 写入过程中的可变状态（回调里改它，因此单独一个结构体）。
struct WriteState {
    file: Option<std::fs::File>,
    written: u64,
    total: Option<u64>,
    resuming: bool,
    failure: Option<std::io::Error>,
    offset: u64,
    last_flush: Instant,
    flushed: u64,
}

impl WriteState {
    fn handle(
        &mut self,
        event: DownloadEvent<'_>,
        part_path: &Path,
        control: &Control,
        sink: &Arc<dyn EventSink>,
        id: &str,
    ) -> bool {
        match event {
            DownloadEvent::Start { status, headers } => {
                if control.paused.load(Ordering::Relaxed) {
                    return false;
                }
                // 只有 206 才是真的续上了；回 200 说明上游忽略了 Range，必须从头写
                self.resuming = self.offset > 0 && status == 206;
                self.written = if self.resuming { self.offset } else { 0 };
                self.total = content_length_of(headers).map(|len| if self.resuming { len + self.offset } else { len });

                let opened = if self.resuming {
                    std::fs::OpenOptions::new().create(true).append(true).open(part_path)
                } else {
                    std::fs::File::create(part_path)
                };
                match opened {
                    Ok(file) => {
                        self.file = Some(file);
                        self.last_flush = Instant::now();
                        self.flushed = self.written;
                        true
                    }
                    Err(err) => {
                        self.failure = Some(err);
                        false
                    }
                }
            }
            DownloadEvent::Chunk(chunk) => {
                if control.cancelled.load(Ordering::Relaxed) || control.paused.load(Ordering::Relaxed) {
                    return false;
                }
                let Some(file) = self.file.as_mut() else { return false };
                if let Err(err) = file.write_all(chunk) {
                    self.failure = Some(err);
                    return false;
                }
                self.written += chunk.len() as u64;

                // 节流：每 512 KiB 或 500ms 报一次进度（事件 + 落库交给调用方）
                let since = self.written - self.flushed;
                let elapsed = self.last_flush.elapsed().as_millis();
                if since >= FLUSH_BYTES || elapsed >= FLUSH_MILLIS {
                    let speed = since as f64 / self.last_flush.elapsed().as_secs_f64().max(0.001);
                    sink.emit(
                        events::DOWNLOAD_PROGRESS,
                        json!({ "id": id, "received": self.written, "total": self.total, "speed": speed as i64 }),
                    );
                    self.flushed = self.written;
                    self.last_flush = Instant::now();
                }
                true
            }
        }
    }
}

/// `content-length` → 总字节数（没有就是未知，前端只显示已下载量）。
fn content_length_of(headers: &[(String, String)]) -> Option<u64> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<u64>().ok())
}

/// `.part` 路径：`a.flac` → `a.flac.part`
fn part_path_of(final_path: &Path) -> PathBuf {
    let mut name = final_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    name.push_str(".part");
    final_path.with_file_name(name)
}

/// 文件名：`歌手 - 标题.<ext>`，非法字符替换成 `_`。
fn file_name_for(track: &Value, reference: &str) -> String {
    let title = track
        .get("title")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| reference.split_once(':').map(|(_, raw)| raw).unwrap_or(reference));
    let artist = track.get("artist").and_then(Value::as_str).unwrap_or_default();

    let raw = if artist.trim().is_empty() {
        title.trim().to_string()
    } else {
        format!("{} - {}", artist.trim(), title.trim())
    };
    let cleaned: String = raw
        .chars()
        .map(|ch| if r#"\/:*?"<>|"#.contains(ch) || ch.is_control() { '_' } else { ch })
        .collect();
    // 去掉首尾的点与空格：避免隐藏文件、也避免 Windows 上的「名字以点结尾」
    let base = cleaned.trim_matches(['.', ' ']).to_string();
    let base = if base.is_empty() { "download".to_string() } else { base };

    format!("{base}.{}", extension_of(track, reference))
}

/// URL 里的扩展名（只认音频格式，避免把 `.html` 当成媒体后缀）。
fn known_extension(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    ["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"]
        .contains(&ext.as_str())
        .then_some(ext)
}

/// 建任务时的扩展名：优先曲目里的 `url`，否则按常见音频格式猜 `m4a`
/// （解析出真实地址后会被 `known_extension` 改写）。
fn extension_of(track: &Value, reference: &str) -> String {
    if let Some(ext) = track.get("url").and_then(Value::as_str).and_then(known_extension) {
        return ext;
    }
    if let Some(ext) = known_extension(reference) {
        return ext;
    }
    "m4a".to_string()
}

/// 任务 → 契约里的 `DownloadTask`。
fn task_json(row: &DownloadRow) -> Value {
    let received = row.received.max(0) as f64;
    let total = row.total.map(|total| total.max(0) as f64);
    let progress = match total {
        Some(total) if total > 0.0 => (received / total).clamp(0.0, 1.0),
        _ => 0.0,
    };
    let size_text = match total {
        Some(total) => format!("{}/{}", mb(received), mb(total)),
        None => mb(received),
    };

    let mut task = json!({
        "id": row.id,
        "track": row.track,
        "status": row.status,
        "progress": progress,
        "totalMb": total.map(|total| total / 1024.0 / 1024.0).unwrap_or(0.0),
        "sizeText": size_text,
        "path": row.path,
        "error": row.error,
    });
    if row.speed > 0 {
        task["speedText"] = json!(format!("{}/s", mb(row.speed as f64)));
    }
    task
}

/// 字节 → 「12.3 MB」（单位语言中立，不进 i18n）。
fn mb(bytes: f64) -> String {
    if bytes >= 1024.0 * 1024.0 {
        format!("{:.1} MB", bytes / 1024.0 / 1024.0)
    } else {
        format!("{:.0} KB", bytes / 1024.0)
    }
}

fn require_store(ctx: &CoreContext) -> Fallible<&crate::store::Store> {
    ctx.store.as_ref().ok_or_else(|| {
        CoreError::new(ErrorCode::LibraryIoError, "数据库不可用，无法读写下载任务").with_details(
            json!({ "reason": ctx.store_error.clone().unwrap_or_default() }),
        )
    })
}

fn parse_params<T: serde::de::DeserializeOwned>(params: Value) -> Fallible<T> {
    crate::commands::parse_params(params)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
