//! 本地曲库命令的集成测试（M3b）：扫描 / 列表 / 移除。
//!
//! 测试里**真的生成 WAV 文件**（44 字节 RIFF 头 + PCM 数据），因此走的是完整的
//! symphonia 探测路径（容器识别 + 时长计算），而不是打桩。
//!
//! 盯住五件事：
//! 1. 扫描入库、重复扫描**不重复**（按路径派生的 id 命中同一行）；
//! 2. **快速重扫**：大小没变就不重读标签（`skipped` 计数）；
//! 3. 只清理**本次扫描目录内**消失的条目（扫 A 不该删 B）；
//! 4. 检索：2 个汉字（LIKE 兜底）与 3 个字以上（FTS5）都能搜到；
//! 5. `remove`：默认只移出曲库，`deleteFile` 才真的删文件，且只删音频扩展名。

use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::events::EventSink;
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

struct Offline;

impl HttpTransport for Offline {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

/// 记录事件的 sink（扫描进度是契约的一部分，要能断言）。
#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // 唯一性交给 common：时钟粒度 + 并行测试会让两个测试撞同一个目录
    common::temp_dir(&format!("gently-local-{tag}"))
}

fn ctx_at(paths: &AppPaths, sink: Arc<RecordingSink>) -> CoreContext {
    let store = Store::open(&paths.db).expect("打开库");
    CoreContext::new(paths.clone())
        .with_store(store)
        .with_events(sink)
        .with_http(Arc::new(Offline))
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

/// 生成一个可被 symphonia 识别的 PCM WAV：`seconds` 秒、8kHz 单声道 8bit。
fn write_wav(path: &std::path::Path, seconds: u32) {
    let sample_rate: u32 = 8_000;
    let samples = sample_rate * seconds;
    let data_len = samples; // 8bit 单声道：1 字节/样本
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk 大小
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes()); // byte rate
    bytes.extend_from_slice(&1u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&8u16.to_le_bytes()); // bits per sample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend(std::iter::repeat(128u8).take(data_len as usize));
    std::fs::write(path, bytes).unwrap();
}

/*
 * 内嵌封面夹具说明（重要）：
 *
 * 两个格式走**两条不同的代码路径**，所以两个都要有夹具：
 *   - **mp3 / ID3v2**：symphonia 0.5.5 的 mp3 demuxer **不解析 ID3v2**——标题/歌手/专辑/封面
 *     全部只出现在探测阶段的**链式元数据**（`ProbeResult.metadata`）里，容器自己的
 *     `format.metadata()` 是空的（本文件实测）。核心因此必须两边都读（`read_tags` 的合并逻辑），
 *     否则最常见的 mp3 会丢掉全部标签与内嵌封面。
 *   - **FLAC / PICTURE 块**：走容器自己的 `format.metadata()`（链式那份是空的）——正好是合并逻辑
 *     的另一半。FLAC 读取器要求**至少一个合法音频帧**才肯构造（`FlacReader::try_new` 里
 *     `parser.resync(...)?` 会把 `end of stream` 抛出来），所以下面手写了一个静音帧：
 *     1 帧 192 样本、双声道、16bit、44.1kHz、CONSTANT 子帧 = 帧头 4 字节 + 帧号 + CRC-8（poly 0x07）
 *     + 两个常量子帧（各 3 字节）+ CRC-16（poly 0x8005）。
 */
/// 生成一张**真能解码**的纯色 PNG（宽高 `size`，颜色 `rgb`）。
///
/// 为什么要真 PNG：假字节能验证「按字节搬运」，但界面要真的把封面画出来（打包版实测），
/// 所以夹具里放一张 WebView 认得的图；自己拼 IHDR/IDAT/IEND 比引依赖省事——IDAT 用
/// zlib 的**非压缩存储块**（deflate stored），不需要压缩器。
fn solid_png(size: u32, rgb: [u8; 3]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        crc ^ 0xffff_ffff
    }

    fn adler32(bytes: &[u8]) -> u32 {
        let (mut a, mut b) = (1u32, 0u32);
        for byte in bytes {
            a = (a + u32::from(*byte)) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }

    fn chunk(kind: &[u8; 4], body: &[u8], out: &mut Vec<u8>) {
        out.extend((body.len() as u32).to_be_bytes());
        out.extend(kind);
        out.extend(body);
        let mut crc_input = kind.to_vec();
        crc_input.extend(body);
        out.extend(crc32(&crc_input).to_be_bytes());
    }

    // 每行：1 字节过滤器（0 = None）+ 3 字节/像素
    let mut raw = Vec::with_capacity((size * (1 + size * 3)) as usize);
    for _ in 0..size {
        raw.push(0);
        for _ in 0..size {
            raw.extend(rgb);
        }
    }

    let mut zlib = vec![0x78, 0x01]; // zlib 头：deflate、默认窗口
    zlib.push(0x01); // BFINAL=1, BTYPE=00（存储）
    zlib.extend((raw.len() as u16).to_le_bytes());
    zlib.extend((!(raw.len() as u16)).to_le_bytes());
    zlib.extend(&raw);
    zlib.extend(adler32(&raw).to_be_bytes());

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = Vec::new();
    ihdr.extend(size.to_be_bytes());
    ihdr.extend(size.to_be_bytes());
    ihdr.extend([8, 2, 0, 0, 0]); // 8 位、真彩色、无隔行
    chunk(b"IHDR", &ihdr, &mut png);
    chunk(b"IDAT", &zlib, &mut png);
    chunk(b"IEND", &[], &mut png);
    png
}

/// 生成一个带 ID3v2.4 标签的 mp3：标题/歌手/专辑 +（可选）内嵌 PNG，外加一个静音帧
/// （mp3 探测至少需要一个帧头，否则 `get_probe().format` 直接失败）。
/// 用 v2.4 是因为它允许 UTF-8 文本（中文标签是本地曲库的常态），v2.3 只有 ISO-8859-1 / UTF-16。
fn write_mp3_with_id3(
    path: &std::path::Path,
    title: &str,
    artist: &str,
    album: &str,
    cover: Option<&[u8]>,
) {
    /// ID3v2.4 的帧长是 syncsafe（每字节 7 位）
    fn syncsafe(value: u32) -> [u8; 4] {
        [
            ((value >> 21) & 0x7f) as u8,
            ((value >> 14) & 0x7f) as u8,
            ((value >> 7) & 0x7f) as u8,
            (value & 0x7f) as u8,
        ]
    }

    fn text_frame(id: &[u8; 4], text: &str) -> Vec<u8> {
        let mut body = vec![0x03]; // UTF-8
        body.extend(text.as_bytes());
        let mut frame = id.to_vec();
        frame.extend(syncsafe(body.len() as u32));
        frame.extend([0, 0]); // flags
        frame.extend(body);
        frame
    }

    let mut frames = Vec::new();
    frames.extend(text_frame(b"TIT2", title));
    frames.extend(text_frame(b"TPE1", artist));
    frames.extend(text_frame(b"TALB", album));
    if let Some(cover) = cover {
        let mut apic = vec![0x03]; // UTF-8 描述
        apic.extend(b"image/png\0");
        apic.push(0x03); // 前封面
        apic.push(0x00); // 空描述
        apic.extend(cover);
        let mut frame = b"APIC".to_vec();
        frame.extend(syncsafe(apic.len() as u32));
        frame.extend([0, 0]);
        frame.extend(apic);
        frames.extend(frame);
    }

    // ID3v2.4 头：`ID3` + 版本 4.0 + flags 0 + syncsafe 总长
    let mut bytes = b"ID3".to_vec();
    bytes.extend([0x04, 0x00, 0x00]);
    bytes.extend(syncsafe(frames.len() as u32));
    bytes.extend(&frames);

    // MPEG-1 Layer III / 128kbps / 44100Hz：帧长 144×128000/44100 = 417 字节
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    bytes.extend(&frame);

    std::fs::write(path, bytes).unwrap();
}

/// 生成一个能被 symphonia 接受的 FLAC：STREAMINFO + VORBIS_COMMENT + PICTURE + 一个静音帧。
///
/// 用 `format_metadata()`（容器自己的元数据）这条路，正好覆盖合并逻辑里与 mp3 相反的那一半。
fn write_flac_with_picture(
    path: &std::path::Path,
    title: &str,
    artist: &str,
    album: &str,
    cover: &[u8],
) {
    /// CRC-8/CCITT（poly 0x07，初值 0）——FLAC 帧头的校验
    fn crc8(bytes: &[u8]) -> u8 {
        let mut crc = 0u8;
        for byte in bytes {
            crc ^= byte;
            for _ in 0..8 {
                crc = if crc & 0x80 != 0 { (crc << 1) ^ 0x07 } else { crc << 1 };
            }
        }
        crc
    }

    /// CRC-16/ANSI（poly 0x8005，初值 0）——FLAC 帧尾的校验
    fn crc16(bytes: &[u8]) -> u16 {
        let mut crc = 0u16;
        for byte in bytes {
            crc ^= u16::from(*byte) << 8;
            for _ in 0..8 {
                crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x8005 } else { crc << 1 };
            }
        }
        crc
    }

    /// 元数据块：1 字节（最后一块标志 + 类型）+ 3 字节大端长度 + 内容
    fn block(bytes: &mut Vec<u8>, kind: u8, is_last: bool, body: &[u8]) {
        bytes.push(if is_last { 0x80 | kind } else { kind });
        let len = body.len() as u32;
        bytes.extend([(len >> 16) as u8, (len >> 8) as u8, len as u8]);
        bytes.extend(body);
    }

    const SAMPLE_RATE: u32 = 44_100;
    const CHANNELS: u32 = 2;
    const BITS: u32 = 16;
    const BLOCK_SAMPLES: u32 = 192;

    let mut bytes = b"fLaC".to_vec();

    // STREAMINFO（固定块长 192、44.1kHz、双声道、16bit、总样本数 = 一帧）
    let mut stream_info = Vec::new();
    stream_info.extend((BLOCK_SAMPLES as u16).to_be_bytes());
    stream_info.extend((BLOCK_SAMPLES as u16).to_be_bytes());
    stream_info.extend([0, 0, 0]); // 最小帧字节数（未知）
    stream_info.extend([0, 0, 0]); // 最大帧字节数（未知）
    let packed: u64 = (u64::from(SAMPLE_RATE) << 44)
        | (u64::from(CHANNELS - 1) << 41)
        | (u64::from(BITS - 1) << 36)
        | u64::from(BLOCK_SAMPLES);
    stream_info.extend(packed.to_be_bytes());
    stream_info.extend([0u8; 16]); // MD5（全 0 = 没有）
    assert_eq!(stream_info.len(), 34);
    block(&mut bytes, 0x00, false, &stream_info);

    // VORBIS_COMMENT：标签（标题/歌手/专辑）
    let mut comment = Vec::new();
    let vendor = b"gently-test";
    comment.extend((vendor.len() as u32).to_le_bytes());
    comment.extend(vendor);
    let tags = [format!("TITLE={title}"), format!("ARTIST={artist}"), format!("ALBUM={album}")];
    comment.extend((tags.len() as u32).to_le_bytes());
    for tag in &tags {
        comment.extend((tag.len() as u32).to_le_bytes());
        comment.extend(tag.as_bytes());
    }
    block(&mut bytes, 0x04, false, &comment);

    // PICTURE：类型 3（前封面）+ mime + 空描述 + 尺寸 + 图片字节
    let mut picture = Vec::new();
    picture.extend(3u32.to_be_bytes());
    picture.extend((b"image/png".len() as u32).to_be_bytes());
    picture.extend(b"image/png");
    picture.extend(0u32.to_be_bytes()); // 描述长度
    picture.extend(64u32.to_be_bytes()); // 宽
    picture.extend(64u32.to_be_bytes()); // 高
    picture.extend(24u32.to_be_bytes()); // 位深
    picture.extend(0u32.to_be_bytes()); // 索引色
    picture.extend((cover.len() as u32).to_be_bytes());
    picture.extend(cover);
    block(&mut bytes, 0x06, true, &picture);

    // 音频帧：FF F8 + desc + 帧号 0 + CRC-8 + 两个 CONSTANT 子帧 + CRC-16
    let desc: u16 = (0x1 << 12) | (0x9 << 8) | (0x1 << 4) | (0x4 << 1);
    let mut frame = vec![0xFF, 0xF8, (desc >> 8) as u8, desc as u8, 0x00];
    frame.push(crc8(&frame));
    for _ in 0..CHANNELS {
        frame.push(0x00); // 零填充 + CONSTANT 子帧 + 无浪费位
        frame.extend([0x00, 0x00]); // 16bit 常量样本 = 0（静音）
    }
    let footer = crc16(&frame);
    frame.extend(footer.to_be_bytes());
    bytes.extend(&frame);

    std::fs::write(path, bytes).unwrap();
}

/// 最小的 HTTP GET：只用于从回环代理取一张封面（返回 status、headers 原文、body）。
fn http_get(url: &str) -> (u16, String, Vec<u8>) {
    use std::io::{Read, Write};
    let rest = url.strip_prefix("http://").expect("http:// 前缀");
    let (authority, path) = rest.split_once('/').expect("path");
    let mut stream = std::net::TcpStream::connect(authority).expect("连接代理");
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("响应头结束");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("状态码");
    (status, head, raw[split + 4..].to_vec())
}

/// 给**打包版手工实测**生成夹具（默认 `#[ignore]`，`cargo test -- --ignored` 才跑）：
/// 在 `%TEMP%\gently-e2e-cover\` 放三条曲目——mp3（品红封面，走链式元数据）、
/// FLAC（青色封面，走容器 PICTURE 块）、以及一个没有封面的 mp3——
/// 用于在真实应用里扫描该目录、确认本地列表真的画出封面（自动化测不了 WebView 渲染）。
#[test]
#[ignore = "手工实测用：生成带内嵌封面的 mp3/flac 夹具"]
fn emit_cover_fixture_for_the_packaged_app() {
    let dir = std::env::temp_dir().join("gently-e2e-cover");
    std::fs::create_dir_all(&dir).unwrap();
    write_mp3_with_id3(
        &dir.join("embed-cover.mp3"),
        "内嵌封面实测",
        "夹具歌手",
        "夹具专辑",
        Some(&solid_png(64, [255, 0, 255])),
    );
    write_flac_with_picture(
        &dir.join("picture-block.flac"),
        "FLAC 封面实测",
        "夹具歌手",
        "夹具专辑",
        &solid_png(64, [0, 200, 255]),
    );
    write_mp3_with_id3(&dir.join("no-cover.mp3"), "没有封面", "夹具歌手", "夹具专辑", None);
    println!("夹具目录：{}", dir.display());
}

#[test]
fn embedded_cover_is_extracted_cached_and_served_through_the_loopback_proxy() {
    // 纯品红：既真能解码（WebView 能画出来），又在界面上一眼可辨（不是渐变兜底）
    let cover = solid_png(64, [255, 0, 255]);

    let dir = temp_dir("cover");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    let with_cover_path = music.join("with-cover.mp3");
    // 真·内嵌封面：扫描时必须从 ID3v2 的 APIC 里读出来（不是测试自己塞进缓存）
    write_mp3_with_id3(&with_cover_path, "带封面的标题", "夹具歌手", "夹具专辑", Some(&cover));
    write_mp3_with_id3(&music.join("no-cover.mp3"), "没封面", "夹具歌手", "", None);

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let covers = paths.cache.join("covers");
    let expected_name = gently_core::covers::CoverStore::file_name(&with_cover_path, "png");

    let sink = Arc::new(RecordingSink::default());
    let ctx = ctx_at(&paths, sink);

    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(scanned["ok"], json!(true), "{scanned}");
    assert_eq!(scanned["data"]["added"], json!(2));
    assert_eq!(scanned["data"]["unreadable"], json!(0), "夹具要能被 symphonia 认出：{scanned}");
    assert_eq!(
        std::fs::read(covers.join(&expected_name)).ok().as_deref(),
        Some(cover.as_slice()),
        "扫描就该把 APIC 的字节落进封面缓存：{}",
        covers.display()
    );

    let listed = call(&ctx, "library.local.list", json!({}));
    let items = listed["data"]["items"].as_array().unwrap().clone();
    let with_cover = items
        .iter()
        .find(|item| item["fileName"] == json!("with-cover.mp3"))
        .expect("带封面的曲目在列表里");
    let without_cover = items
        .iter()
        .find(|item| item["fileName"] == json!("no-cover.mp3"))
        .expect("没封面的曲目在列表里");

    // ID3v2 的文本标签也必须带出来（合并链式元数据的那条修复）
    assert_eq!(with_cover["title"], json!("带封面的标题"), "{with_cover}");
    assert_eq!(with_cover["artist"], json!("夹具歌手"), "{with_cover}");
    assert_eq!(with_cover["album"], json!("夹具专辑"), "{with_cover}");
    assert_eq!(without_cover["title"], json!("没封面"), "没有封面的 mp3 一样要读标签");

    let url = with_cover["artwork"].as_str().unwrap_or_default().to_string();
    assert!(
        url.starts_with("http://127.0.0.1:") && url.ends_with(&format!("/cover/{expected_name}")),
        "列表应给出指向缓存文件的回环封面地址：{with_cover}"
    );
    assert!(
        without_cover.get("artwork").is_none(),
        "没有内嵌封面就不该有 artwork 字段：{without_cover}"
    );

    // 真的取一次：200 + image/png + 字节与文件里的封面一致
    let (status, head, body) = http_get(&url);
    assert_eq!(status, 200, "{head}");
    assert!(head.to_lowercase().contains("content-type: image/png"), "{head}");
    assert_eq!(body, cover, "代理回的字节必须与内嵌图片一致");

    // 目录穿越与非白名单名字一律 404（封面路由不能变成任意文件读取）
    let base = url.trim_end_matches(|c: char| c != '/').to_string();
    let (status, _, _) = http_get(&format!("{base}..%2F..%2Fgently.db"));
    assert_eq!(status, 404, "目录穿越必须被拒");
    let (status, _, _) = http_get(&format!("{base}not-a-cover-name.png"));
    assert_eq!(status, 404, "不合规文件名必须被拒");

    // 移除曲目：封面缓存跟着清掉（不留孤儿文件）
    let id = with_cover["id"].as_str().unwrap().to_string();
    assert_eq!(call(&ctx, "library.local.remove", json!({ "id": id }))["ok"], json!(true));
    let (status, _, _) = http_get(&url);
    assert_eq!(status, 404, "曲目移除后封面也该消失");
    assert!(
        !covers.join(&expected_name).exists(),
        "封面文件本身也要删掉：{}",
        covers.display()
    );
    let left: Vec<_> = std::fs::read_dir(&covers)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.file_name())).collect())
        .unwrap_or_default();
    assert!(left.is_empty(), "封面目录不该留下任何东西：{left:?}");

    // 没有内嵌封面的曲目被移除时也不能出错（走同一条清理路径）
    let other = without_cover["id"].as_str().unwrap().to_string();
    assert_eq!(call(&ctx, "library.local.remove", json!({ "id": other }))["ok"], json!(true));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rescanning_a_doubled_separator_path_does_not_duplicate_the_track() {
    // 打包版实测撞到的真 bug：把 `C:\\...\\dir`（重复分隔符，Windows 照样认）粘进扫描面板，
    // 同一个文件会被收成**两行**（路径字符串不同 → id 不同）。归一化后必须只有一行。
    let dir = temp_dir("dup");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    write_wav(&music.join("one.wav"), 3);

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));

    let normal = music.to_string_lossy().to_string();
    let doubled = normal.replace('\\', "\\\\").replace('/', "//");
    assert_ne!(normal, doubled, "两种写法必须真的不同");

    assert_eq!(call(&ctx, "library.local.scan", json!({ "dirs": [normal] }))["data"]["added"], json!(1));
    let second = call(&ctx, "library.local.scan", json!({ "dirs": [doubled] }));
    assert_eq!(second["ok"], json!(true), "{second}");
    assert_eq!(second["data"]["added"], json!(0), "同一文件不该被当成新曲目：{second}");
    assert_eq!(second["data"]["removed"], json!(0), "也不该把自己清理掉：{second}");

    let listed = call(&ctx, "library.local.list", json!({}));
    let items = listed["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "曲库里只能有一行：{listed}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn stale_duplicate_row_does_not_delete_the_live_cover() {
    // R37 实测的第二半：旧版本（归一化之前）可能把同一个文件按两种拼法收成两行。
    // 修好 id 之后，旧那行会被当成「本次没再见到」清理掉——但**不能顺手删掉封面文件**，
    // 因为活着的那一行用的就是同一份（否则列表上的封面会莫名退回渐变，实测撞到过）。
    let dir = temp_dir("cover-dup");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    let track_path = music.join("embed.mp3");
    let cover = solid_png(8, [255, 0, 255]);
    write_mp3_with_id3(&track_path, "重复行", "夹具歌手", "夹具专辑", Some(&cover));

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let store = Store::open(&paths.db).unwrap();
    let ctx = CoreContext::new(paths.clone())
        .with_store(store.clone())
        .with_events(Arc::new(RecordingSink::default()))
        .with_http(Arc::new(Offline));

    let normal = music.to_string_lossy().to_string();
    assert_eq!(call(&ctx, "library.local.scan", json!({ "dirs": [normal] }))["data"]["added"], json!(1));
    let listed = call(&ctx, "library.local.list", json!({}));
    let url = listed["data"]["items"][0]["artwork"].as_str().unwrap_or_default().to_string();
    assert!(url.contains("/cover/"), "先要有封面：{listed}");

    // 模拟旧版本留下的重复行（同一文件、重复分隔符的拼法）
    let doubled = normal.replace('\\', "\\\\").replace('/', "//");
    store
        .upsert_local_tracks(&[gently_core::store::LocalTrackInput {
            id: format!("local:{doubled}/embed.mp3"),
            path: format!("{doubled}/embed.mp3"),
            file_name: "embed.mp3".to_string(),
            size: 0,
            title: "重复行".to_string(),
            artist: "夹具歌手".to_string(),
            album: "夹具专辑".to_string(),
            duration_sec: 0,
        }])
        .unwrap();

    let rescanned = call(&ctx, "library.local.scan", json!({ "dirs": [normal] }));
    assert_eq!(rescanned["data"]["removed"], json!(1), "重复行要被清掉：{rescanned}");
    let listed = call(&ctx, "library.local.list", json!({}));
    assert_eq!(listed["data"]["items"].as_array().unwrap().len(), 1);
    let url = listed["data"]["items"][0]["artwork"].as_str().unwrap_or_default().to_string();
    assert!(url.contains("/cover/"), "活着那一行的封面不能被顺手删掉：{listed}");
    let (status, _, body) = http_get(&url);
    assert_eq!(status, 200);
    assert_eq!(body, cover, "封面字节要完好");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn flac_picture_block_is_extracted_through_the_container_metadata_path() {
    // mp3 的封面来自探测阶段的**链式元数据**，FLAC 的来自**容器自己的元数据**——
    // 合并逻辑的另一半。这个测试保证两半都在（去掉任一半，对应格式就会丢封面）。
    let cover = solid_png(32, [0, 200, 255]);
    let dir = temp_dir("flac-cover");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    let flac_path = music.join("with-picture.flac");
    write_flac_with_picture(&flac_path, "无损标题", "无损歌手", "无损专辑", &cover);

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));

    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(scanned["ok"], json!(true), "{scanned}");
    assert_eq!(scanned["data"]["added"], json!(1));
    assert_eq!(scanned["data"]["unreadable"], json!(0), "夹具要能被 symphonia 认出：{scanned}");

    let listed = call(&ctx, "library.local.list", json!({}));
    let item = &listed["data"]["items"][0];
    // 标签来自容器的 VORBIS_COMMENT
    assert_eq!(item["title"], json!("无损标题"), "{listed}");
    assert_eq!(item["artist"], json!("无损歌手"), "{listed}");
    assert_eq!(item["album"], json!("无损专辑"), "{listed}");

    let url = item["artwork"].as_str().unwrap_or_default().to_string();
    assert!(url.contains("/cover/"), "PICTURE 块里的图应该被缓存并给出地址：{listed}");
    let (status, head, body) = http_get(&url);
    assert_eq!(status, 200, "{head}");
    assert!(head.to_lowercase().contains("content-type: image/png"), "{head}");
    assert_eq!(body, cover, "代理回的字节必须与 PICTURE 块里的图一致");

    // 顺带确认封面缓存文件名与源路径（同一份归一化）对得上
    let expected = gently_core::covers::CoverStore::file_name(&flac_path, "png");
    assert!(url.ends_with(&format!("/cover/{expected}")), "{url}");

    std::fs::remove_dir_all(&dir).ok();
}

/// 量一次契约 §11 的**性能预算**（默认 `#[ignore]`，`--ignored --nocapture` 才跑）。
///
/// 契约写的是「扫描 1 万文件 < 10s、FTS5 检索 P95 < 50ms」。这里不去造 1 万个文件（太慢），
/// 而是用 `CORPUS` 个真 WAV 量出**每条文件的成本**与检索 P95，再据此判断预算是否站得住。
#[test]
#[ignore = "性能测量：契约 §11 的扫描/检索预算"]
fn measure_scan_and_search_budget() {
    use std::time::Instant;

    const CORPUS: u32 = 1_000;
    let dir = temp_dir("perf");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    for index in 0..CORPUS {
        write_wav(&music.join(format!("track-{index:04}.wav")), 1);
    }

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));

    let first = Instant::now();
    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    let first_ms = first.elapsed().as_millis();
    assert_eq!(scanned["data"]["added"], json!(CORPUS), "{scanned}");

    let again = Instant::now();
    let rescanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    let rescan_ms = again.elapsed().as_millis();
    assert_eq!(rescanned["data"]["skipped"], json!(CORPUS), "{rescanned}");

    // 检索：取 200 次查询的 P95（每条都命中，走 FTS5）
    let mut samples = Vec::new();
    for index in 0..200 {
        let query = format!("track-{:04}", (index * 7) % CORPUS);
        let began = Instant::now();
        let listed = call(&ctx, "library.local.list", json!({ "query": query }));
        samples.push(began.elapsed().as_micros() as f64 / 1000.0);
        assert!(
            !listed["data"]["items"].as_array().unwrap().is_empty(),
            "查询要命中：{query}"
        );
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];

    println!(
        "语料 {CORPUS} 个 WAV：首扫 {first_ms} ms（{:.2} ms/文件）、重扫 {rescan_ms} ms（{:.2} ms/文件）、检索 P95 {p95:.2} ms",
        first_ms as f64 / f64::from(CORPUS),
        rescan_ms as f64 / f64::from(CORPUS),
    );
    println!(
        "按此成本外推 1 万文件：首扫 {:.1} s、重扫 {:.1} s（契约预算：首扫 < 10 s）",
        first_ms as f64 / f64::from(CORPUS) * 10_000.0 / 1000.0,
        rescan_ms as f64 / f64::from(CORPUS) * 10_000.0 / 1000.0,
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn stored_snapshots_get_a_fresh_local_cover_url() {
    // 收藏/历史/歌单存的是**快照**，里面那份 `artwork` 是当时那个回环端口——端口每次启动都变，
    // 直接下发旧地址，界面只会拿到一张加载失败的图（R40 实测：收藏页那一行没有封面，本地页却有）。
    // 本地封面的名字由路径派生，所以核心在下发前要按路径重新签发一个当前有效的地址。
    let cover = solid_png(16, [255, 0, 255]);
    let dir = temp_dir("snapshot-cover");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    let path = music.join("snap.mp3");
    write_mp3_with_id3(&path, "快照", "夹具歌手", "夹具专辑", Some(&cover));

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));

    assert_eq!(call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }))["data"]["added"], json!(1));
    let listed = call(&ctx, "library.local.list", json!({}));
    let fresh = listed["data"]["items"][0]["artwork"].as_str().unwrap().to_string();

    // 用「上一次运行留下的地址」收藏（端口 1 上什么都没有）
    let stale = "http://127.0.0.1:1/cover/00000000000000000000000000000000.png";
    let reference = format!("local:{}", path.to_string_lossy().replace('\\', "/"));
    let snapshot = json!({
        "id": reference,
        "source": "local",
        "title": "快照",
        "artist": "夹具歌手",
        "album": "夹具专辑",
        "duration": "0:00",
        "durationSec": 0,
        "gradient": "",
        "tags": [],
        "path": path.to_string_lossy().replace('\\', "/"),
        "artwork": stale,
    });
    let saved = call(&ctx, "library.favorites.set", json!({ "ref": reference, "favorite": true, "track": snapshot }));
    assert_eq!(saved["ok"], json!(true), "{saved}");

    let favorites = call(&ctx, "library.favorites.list", json!({}));
    let url = favorites["data"]["items"][0]["artwork"].as_str().unwrap_or_default().to_string();
    assert_ne!(url, stale, "不能把旧端口的地址原样发下去：{favorites}");
    assert!(url.contains("/cover/"), "{favorites}");
    assert!(
        url.starts_with("http://127.0.0.1:") && !url.starts_with("http://127.0.0.1:1/"),
        "要重新签发现行端口：{url}"
    );
    let (status, head, body) = http_get(&url);
    assert_eq!(status, 200, "{head}");
    assert_eq!(body, cover, "重新签发的地址必须真的能取到封面");
    assert_eq!(url, fresh, "与本地列表给的是同一个地址（同一份签发逻辑）");
    // 候选里的那份也要刷新：切源失败回退时播放条用的就是它
    let candidate = favorites["data"]["items"][0]["candidates"][0]["track"]["artwork"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert_eq!(candidate, fresh, "候选曲目的封面同样要重新签发：{favorites}");

    // 歌单里的快照走同一条路（`normalized`）
    let playlist = call(
        &ctx,
        "library.playlists.save",
        json!({ "name": "快照歌单", "trackRefs": [reference], "tracks": [snapshot] }),
    );
    let playlist_url = playlist["data"]["tracks"][0]["artwork"].as_str().unwrap_or_default().to_string();
    assert_ne!(playlist_url, stale, "歌单里的封面也要重新签发：{playlist}");
    let (status, _, body) = http_get(&playlist_url);
    assert_eq!(status, 200);
    assert_eq!(body, cover);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn m4s_container_is_indexed_like_any_other_audio_file() {
    // R53 用户实测：`D:\Music` 里只有一个 `.m4s`（B 站下载下来的音频，ISO-MP4 + AAC），
    // 扫描结果 `scanned=0` → 界面显示「还没有本地音乐」，**看起来像扫描功能坏了**。
    // `.m4s`/`.m4b`/`.m4r` 与 `.m4a`/`.mp4` 是同一个容器，必须照样入库。
    //
    // 仓库**不分发**那份真音频（`src/assets/*.m4s` 在 .gitignore 里，各人本地自备）。
    // 缺夹具时跳过整条：白名单本身由 `core::local_library` 的纯函数单测守着，这里验的是
    // 「扫一遍目录后 m4s 真能入库」，没有真文件就验不了（不假装通过）。
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/assets/yihuik苡慧 - 致你.m4s");
    if !fixture.exists() {
        eprintln!(
            "跳过 m4s 入库用例：{} 不存在（仓库不分发版权音频，见 src/assets/README.md）",
            fixture.display()
        );
        return;
    }

    let dir = temp_dir("m4s");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();

    std::fs::copy(&fixture, music.join("致你.m4s")).expect("复制 m4s 夹具");
    write_wav(&music.join("silence.wav"), 2);
    // 同一个目录里的非音频文件：要被如实地数出来
    std::fs::write(music.join("desktop.ini"), "[.ShellClassInfo]").unwrap();
    std::fs::write(music.join("cover.jpg"), b"jpeg").unwrap();

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let sink = Arc::new(RecordingSink::default());
    let ctx = ctx_at(&paths, sink);

    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(scanned["ok"], json!(true), "{scanned}");
    let data = &scanned["data"];
    assert_eq!(data["scanned"], json!(2), "m4s 必须被认出来：{scanned}");
    assert_eq!(data["added"], json!(2), "{scanned}");
    assert_eq!(data["unreadable"], json!(0), "m4s 走的是 isomp4 探测，应能读出来：{scanned}");
    assert_eq!(data["ignored"], json!(2), "ini + jpg 计入 ignored：{scanned}");

    let listed = call(&ctx, "library.local.list", json!({}));
    let items = listed["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{listed}");
    let track = items
        .iter()
        .find(|item| item["path"].as_str().unwrap().ends_with(".m4s"))
        .expect("m4s 应在库里");
    assert_eq!(track["source"], json!("local"));
    // 没有标签就退回文件名（不去猜）；有标签就用标签——两种都行，但一定要有条目
    assert!(!track["title"].as_str().unwrap().is_empty(), "{track}");
    assert!(track["sizeText"].as_str().unwrap().ends_with("MB"), "{track}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn scan_indexes_audio_and_is_idempotent() {
    let dir = temp_dir("scan");
    let music = dir.join("music");
    std::fs::create_dir_all(music.join("sub")).unwrap();
    write_wav(&music.join("one.wav"), 3);
    write_wav(&music.join("sub/two.wav"), 5);
    std::fs::write(music.join("notes.txt"), "不是音频").unwrap();
    std::fs::write(music.join("broken.wav"), "这其实不是 wav").unwrap();

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let sink = Arc::new(RecordingSink::default());
    let ctx = ctx_at(&paths, sink.clone());

    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(scanned["ok"], json!(true), "{scanned}");
    let data = &scanned["data"];
    // 3 个音频文件（两个好 wav + 一个坏 wav）；txt 连开都不开
    assert_eq!(data["scanned"], json!(3), "{scanned}");
    assert_eq!(data["added"], json!(3));
    assert_eq!(data["updated"], json!(0));
    assert_eq!(data["removed"], json!(0));
    assert_eq!(data["skipped"], json!(0));
    assert_eq!(data["unreadable"], json!(1), "坏文件照样入库，但计入 unreadable");
    // 非音频文件如实报数：`scanned=0` 与「目录是空的」必须能分辨（R53 的 `.m4s` 就是栽在这上面）
    assert_eq!(data["ignored"], json!(1), "notes.txt 计入 ignored：{scanned}");

    // 进度事件：契约里的 library:scan:progress
    let progress: Vec<Value> = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == "library:scan:progress")
        .map(|(_, payload)| payload.clone())
        .collect();
    assert!(!progress.is_empty(), "扫描必须推进度事件");
    assert!(progress.iter().all(|payload| payload["percent"].is_number()));
    assert!(progress.iter().all(|payload| payload["found"].is_number()));

    // 时长来自真实探测（3 秒 / 5 秒）
    let listed = call(&ctx, "library.local.list", json!({}));
    let items = listed["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(listed["data"]["total"], json!(3));
    let one = items.iter().find(|item| item["path"].as_str().unwrap().ends_with("one.wav")).unwrap();
    assert_eq!(one["durationSec"], json!(3), "WAV 时长应被真实解析：{one}");
    assert_eq!(one["duration"], json!("0:03"));
    assert_eq!(one["source"], json!("local"));
    assert!(one["id"].as_str().unwrap().starts_with("local:"));
    assert!(one["sizeText"].as_str().unwrap().ends_with("KB"), "{one}");
    assert!(one["addedAt"].is_number());
    // 读不到标签 → 标题退回文件名
    assert_eq!(one["title"], json!("one"));

    // 重复扫描：同一路径派生同一 id，不重复入库，且**跳过读标签**（大小没变）
    let again = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(again["data"]["added"], json!(0), "{again}");
    assert_eq!(again["data"]["updated"], json!(0));
    assert_eq!(again["data"]["skipped"], json!(3));
    assert_eq!(call(&ctx, "library.local.list", json!({}))["data"]["total"], json!(3));

    // 文件变了（大小不同）→ 更新而不是新增
    write_wav(&music.join("one.wav"), 7);
    let third = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(third["data"]["updated"], json!(1), "{third}");
    assert_eq!(third["data"]["added"], json!(0));
    let one = call(&ctx, "library.local.list", json!({ "query": "one" }))["data"]["items"]
        .as_array()
        .unwrap()[0]
        .clone();
    assert_eq!(one["durationSec"], json!(7), "更新后时长要刷新");

    // 非递归：只扫顶层（sub/ 里的不算）
    let shallow = call(
        &ctx,
        "library.local.scan",
        json!({ "dirs": [music.to_string_lossy()], "recursive": false }),
    );
    assert_eq!(shallow["data"]["scanned"], json!(2), "非递归只看到顶层两个 wav");
    // 关键：非递归扫描**不该**把 sub/ 里的曲目当成「消失」删掉
    assert_eq!(shallow["data"]["removed"], json!(0), "清理只针对本次扫描范围内的路径");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn scan_removes_only_missing_files_inside_the_scanned_dirs() {
    let dir = temp_dir("scan-remove");
    let music = dir.join("music");
    let other = dir.join("other");
    std::fs::create_dir_all(&music).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    write_wav(&music.join("keep.wav"), 1);
    write_wav(&music.join("gone.wav"), 1);
    write_wav(&other.join("elsewhere.wav"), 1);

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));

    let both = call(
        &ctx,
        "library.local.scan",
        json!({ "dirs": [music.to_string_lossy(), other.to_string_lossy()] }),
    );
    assert_eq!(both["data"]["added"], json!(3));

    // 删掉 music 里的一个文件，只重扫 music：该条目被清理，other 的不受影响
    std::fs::remove_file(music.join("gone.wav")).unwrap();
    let rescan = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(rescan["data"]["removed"], json!(1), "{rescan}");
    let items = call(&ctx, "library.local.list", json!({}))["data"]["items"].clone();
    let paths_listed: Vec<&str> =
        items.as_array().unwrap().iter().map(|item| item["path"].as_str().unwrap()).collect();
    assert!(paths_listed.iter().any(|path| path.ends_with("keep.wav")));
    assert!(paths_listed.iter().any(|path| path.ends_with("elsewhere.wav")), "别的目录不该被清理");
    assert!(!paths_listed.iter().any(|path| path.ends_with("gone.wav")));

    // 目录不存在 → 参数非法（而不是静默什么都不做）
    let bad = call(&ctx, "library.local.scan", json!({ "dirs": [dir.join("nope").to_string_lossy()] }));
    assert_eq!(bad["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{bad}");
    let empty = call(&ctx, "library.local.scan", json!({ "dirs": [] }));
    assert_eq!(empty["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{empty}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn local_search_supports_cjk_and_paginates() {
    let dir = temp_dir("search");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    for name in ["夜曲", "晴天", "稻香", "七里香", "床边故事"] {
        write_wav(&music.join(format!("{name}.wav")), 1);
    }

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));
    assert_eq!(
        call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }))["data"]["added"],
        json!(5)
    );

    // 2 个汉字：LIKE 兜底
    let hit = call(&ctx, "library.local.list", json!({ "query": "夜曲" }));
    assert_eq!(hit["data"]["items"].as_array().unwrap().len(), 1, "{hit}");
    assert_eq!(hit["data"]["items"][0]["title"], json!("夜曲"));
    assert_eq!(hit["data"]["total"], json!(1));

    // 3 个字：FTS5（同一套接口，调用方不需要知道走哪条路）
    let hit = call(&ctx, "library.local.list", json!({ "query": "床边故" }));
    assert_eq!(hit["data"]["items"].as_array().unwrap().len(), 1, "{hit}");

    // 搜不到 → 空列表（不是错误），用户输入的 % 不当通配
    assert_eq!(
        call(&ctx, "library.local.list", json!({ "query": "不存在" }))["data"]["items"],
        json!([])
    );
    assert_eq!(
        call(&ctx, "library.local.list", json!({ "query": "%" }))["data"]["total"],
        json!(0)
    );

    // 游标分页：不重不漏
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let params = match &cursor {
            Some(cursor) => json!({ "limit": 2, "cursor": cursor }),
            None => json!({ "limit": 2 }),
        };
        let page = call(&ctx, "library.local.list", params);
        for item in page["data"]["items"].as_array().unwrap() {
            seen.push(item["id"].as_str().unwrap().to_string());
        }
        match page["data"]["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
    }
    assert_eq!(seen.len(), 5, "翻页不重不漏：{seen:?}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn remove_drops_from_library_and_only_deletes_files_when_asked() {
    let dir = temp_dir("remove");
    let music = dir.join("music");
    std::fs::create_dir_all(&music).unwrap();
    write_wav(&music.join("keep.wav"), 1);
    write_wav(&music.join("drop.wav"), 1);

    let paths = AppPaths::resolve(&dir);
    paths.ensure().unwrap();
    let ctx = ctx_at(&paths, Arc::new(RecordingSink::default()));
    call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));

    let items = call(&ctx, "library.local.list", json!({}))["data"]["items"].clone();
    let rows = items.as_array().unwrap();
    let drop = rows.iter().find(|item| item["path"].as_str().unwrap().ends_with("drop.wav")).unwrap();
    let keep = rows.iter().find(|item| item["path"].as_str().unwrap().ends_with("keep.wav")).unwrap();
    let drop_id = drop["id"].as_str().unwrap().to_string();
    let keep_id = keep["id"].as_str().unwrap().to_string();

    // 默认只移出曲库：文件必须还在
    assert_eq!(call(&ctx, "library.local.remove", json!({ "id": drop_id }))["ok"], json!(true));
    assert!(music.join("drop.wav").exists(), "没要求删文件就不能删");
    assert_eq!(call(&ctx, "library.local.list", json!({}))["data"]["total"], json!(1));

    // 「移出曲库」不是删除：文件还在，重扫就会重新入库（语义要说清楚，别让用户以为文件没了）
    let rescan = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(rescan["data"]["added"], json!(1), "{rescan}");
    assert_eq!(call(&ctx, "library.local.list", json!({}))["data"]["total"], json!(2));

    // 重扫后它又回到库里（文件还在盘上），因此能再次移出
    let again = call(&ctx, "library.local.remove", json!({ "id": drop_id }));
    assert_eq!(again["ok"], json!(true), "重扫后应能再次移出：{again}");

    // 再删同一个 id → 明确报未找到（而不是静默成功）
    let missing = call(&ctx, "library.local.remove", json!({ "id": drop_id }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str(), "{missing}");

    // deleteFile：真的删磁盘文件
    assert_eq!(
        call(&ctx, "library.local.remove", json!({ "id": keep_id, "deleteFile": true }))["ok"],
        json!(true)
    );
    assert!(!music.join("keep.wav").exists(), "deleteFile 要真的删掉");
    assert_eq!(call(&ctx, "library.local.list", json!({}))["data"]["total"], json!(0));

    // 库里被改坏成非音频路径时，拒绝删文件（只删记录）
    std::fs::remove_file(music.join("drop.wav")).unwrap(); // 清掉上一段的残留，让这一段可预期
    write_wav(&music.join("again.wav"), 1);
    let scanned = call(&ctx, "library.local.scan", json!({ "dirs": [music.to_string_lossy()] }));
    assert_eq!(scanned["data"]["added"], json!(1), "{scanned}");
    assert_eq!(call(&ctx, "library.local.list", json!({}))["data"]["total"], json!(1));
    let row = call(&ctx, "library.local.list", json!({}))["data"]["items"][0].clone();
    let id = row["id"].as_str().unwrap().to_string();
    {
        // 另开一条连接直接改库（模拟「库里的一行被改坏」）
        let conn = rusqlite::Connection::open(&paths.db).unwrap();
        conn.execute(
            "UPDATE local_tracks SET path = ?1 WHERE id = ?2",
            rusqlite::params![dir.join("secret.txt").to_string_lossy().replace('\\', "/"), id],
        )
        .unwrap();
    }
    let refused = call(&ctx, "library.local.remove", json!({ "id": id, "deleteFile": true }));
    assert_eq!(refused["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{refused}");
    // 记录仍在（拒绝删除时不静默改库）
    assert_eq!(call(&ctx, "library.local.list", json!({}))["data"]["total"], json!(1));

    std::fs::remove_dir_all(&dir).ok();
}
