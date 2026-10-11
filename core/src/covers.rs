//! 本地文件的**内嵌封面**缓存。
//!
//! 为什么需要：本地曲目的列表快照里没有封面（文件里的标签才带），于是界面只能退回
//! 「标题哈希渐变」。R23 当时没做，理由是「缩成 data URI 会让每一行背几十上百 KB」——
//! 这里换了做法：**扫描时把图片落到 `<data>/covers/<hash>.<ext>`，列表里只给一个回环地址**，
//! 前端 `trackCoverStyle()` 照常当图片用，字节由媒体代理按需读（与音频走同一条回环通道，
//! 只是多了一条 `/cover/<name>` 路由）。
//!
//! 文件名 = 源文件路径的 SHA-256 前 16 字节（32 位十六进制）+ 由 `media_type` 推出的扩展名。
//! 这样 `list` 不必回查数据库就能算出封面在不在（同一路径永远得到同一个名字），
//! 也天然去重（同一个文件被扫多次不会写第二份）。
//!
//! 安全边界：只写**图片扩展名**白名单、单张上限 [`MAX_COVER_BYTES`]，
//! 代理侧只按 `^[0-9a-f]{32}\.(png|jpg|jpeg|webp|gif|bmp)$` 取这个目录里的文件。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 单张内嵌封面上限：超过就当「这张图不适合当封面」，不缓存（避免把几 MB 的扫描件塞进来）。
pub const MAX_COVER_BYTES: usize = 2 * 1024 * 1024;

/// 封面文件允许的扩展名（代理侧与这里必须一致）。
pub const COVER_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// 封面缓存目录 + 回环地址拼装。
#[derive(Debug, Clone)]
pub struct CoverStore {
    dir: PathBuf,
}

impl CoverStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 目录（诊断用）。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 源文件路径 → 封面文件名（同一文件永远同名，`list` 因此不必回查数据库）。
    ///
    /// 走的是与本地曲目 id、曲库 `path` 列**同一份**归一化（`paths::normalize_source_path`）：
    /// 扫描时写封面拿到的是文件系统路径（Windows 上带 `\`），列表里回查用的是库里存下来的字符串，
    /// 两侧只要有一处不同（分隔符方向、重复分隔符）就会算出两个哈希，列表永远找不到刚写下的封面。
    pub fn file_name(source: &Path, extension: &str) -> String {
        let normalized = crate::paths::normalize_source_path(source);
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(32);
        for byte in digest.iter().take(16) {
            hex.push_str(&format!("{byte:02x}"));
        }
        format!("{hex}.{extension}")
    }

    /// `media_type`（`image/jpeg` 这类）→ 扩展名。不认识的类型返回 `None`（不缓存）。
    pub fn extension_for(media_type: &str) -> Option<&'static str> {
        let lower = media_type.to_ascii_lowercase();
        let subtype = lower.split('/').nth(1)?.split(';').next()?.trim();
        match subtype {
            "png" => Some("png"),
            "jpeg" | "jpg" => Some("jpg"),
            "webp" => Some("webp"),
            "gif" => Some("gif"),
            "bmp" => Some("bmp"),
            _ => None,
        }
    }

    /// 写入封面（覆盖式，先写临时文件再改名）。返回写入的文件名。
    ///
    /// 任何一步失败都只是「这张封面没有缓存」，**不影响扫描**——封面是锦上添花，
    /// 不该让整次入库失败（调用方因此拿到 `None` 而不必处理错误）。
    pub fn write(&self, source: &Path, media_type: &str, data: &[u8]) -> Option<String> {
        if data.is_empty() || data.len() > MAX_COVER_BYTES {
            return None;
        }
        let extension = Self::extension_for(media_type)?;
        let name = Self::file_name(source, extension);

        std::fs::create_dir_all(&self.dir).ok()?;
        let target = self.dir.join(&name);
        let tmp = self.dir.join(format!("{name}.part"));
        std::fs::write(&tmp, data).ok()?;
        std::fs::rename(&tmp, &target).ok()?;
        Some(name)
    }

    /// 源文件路径 → 已缓存的封面文件名（没有就 `None`）。
    pub fn existing(&self, source: &Path) -> Option<String> {
        for extension in COVER_EXTENSIONS {
            let name = Self::file_name(source, extension);
            if self.dir.join(&name).is_file() {
                return Some(name);
            }
        }
        None
    }

    /// 删掉某个源文件的全部封面变体（曲目被移出曲库时调用，别留孤儿文件）。
    pub fn remove(&self, source: &Path) {
        for extension in COVER_EXTENSIONS {
            let path = self.dir.join(Self::file_name(source, extension));
            let _ = std::fs::remove_file(path);
        }
    }

    /// 封面名 → 磁盘路径；**名字不合法或文件不存在就返回 `None`**（代理侧的唯一入口）。
    pub fn resolve(&self, name: &str) -> Option<PathBuf> {
        if !is_cover_name(name) {
            return None;
        }
        let path = self.dir.join(name);
        path.is_file().then_some(path)
    }
}

/// 封面文件名是否合法（代理侧用它挡住目录穿越与任意文件读取）。
pub fn is_cover_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 32
        && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && COVER_EXTENSIONS.contains(&extension)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 进程内唯一的临时目录（同一进程里并行跑测试也不能撞车）。
    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "gently-covers-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).expect("创建临时目录");
        path
    }

    #[test]
    fn names_are_deterministic_and_extension_bound() {
        let source = Path::new("D:/Music/a.flac");
        let first = CoverStore::file_name(source, "png");
        assert_eq!(first, CoverStore::file_name(source, "png"), "同一路径必须同名");
        assert_ne!(first, CoverStore::file_name(source, "jpg"), "扩展名进名字");
        assert!(is_cover_name(&first));
        assert!(is_cover_name(&CoverStore::file_name(source, "jpeg")));
    }

    #[test]
    fn names_are_separator_insensitive() {
        // 扫描侧给的是文件系统路径，列表侧给的是数据库里统一的 `/` 路径：必须同名
        let written = CoverStore::file_name(Path::new("D:\\Music\\a.flac"), "png");
        let listed = CoverStore::file_name(Path::new("D:/Music/a.flac"), "png");
        assert_eq!(written, listed, "分隔符不同也必须算出同一个封面名");
        // 重复分隔符同理（用户粘贴 `D:\\Music` 时 Windows 也认，但不归一会变成两个键）
        let doubled = CoverStore::file_name(Path::new("D:\\\\Music//a.flac"), "png");
        assert_eq!(written, doubled, "重复分隔符也必须算出同一个封面名");
    }

    #[test]
    fn normalize_source_path_collapses_separators_and_drops_trailing() {
        use crate::paths::normalize_source_path as n;
        assert_eq!(n(Path::new("D:\\Music\\a.flac")), "D:/Music/a.flac");
        assert_eq!(n(Path::new("D:\\\\Music//a.flac")), "D:/Music/a.flac");
        assert_eq!(n(Path::new("D:\\Music\\")), "D:/Music");
        assert_eq!(n(Path::new("/")), "/");
    }

    #[test]
    fn resolve_rejects_traversal_and_unknown_names() {
        let dir = temp_dir("cover-resolve");
        let store = CoverStore::new(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("deadbeefdeadbeefdeadbeefdeadbeef.png"), b"x").unwrap();

        assert!(store.resolve("deadbeefdeadbeefdeadbeefdeadbeef.png").is_some());
        // 目录穿越、长度不对、扩展名不在白名单、非十六进制：一律拒绝
        assert!(store.resolve("../deadbeefdeadbeefdeadbeefdeadbeef.png").is_none());
        assert!(store.resolve("deadbeef.png").is_none());
        assert!(store.resolve("deadbeefdeadbeefdeadbeefdeadbeef.mp3").is_none());
        assert!(store.resolve("DEADBEEFDEADBEEFDEADBEEFDEADBEEF.png").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_then_existing_then_remove() {
        let dir = temp_dir("cover-roundtrip");
        let store = CoverStore::new(dir.clone());
        let source = Path::new("D:/Music/b.mp3");

        assert!(store.existing(source).is_none());
        let name = store.write(source, "image/jpeg", b"jpeg-bytes").expect("写入封面");
        assert_eq!(name, CoverStore::file_name(source, "jpg"));
        assert_eq!(store.existing(source), Some(name.clone()));
        assert_eq!(std::fs::read(dir.join(&name)).unwrap(), b"jpeg-bytes");

        // 未知类型与超大图片都不缓存（返回 None，不报错）
        assert!(store.write(source, "image/tiff", b"x").is_none());
        assert!(store.write(source, "image/png", &vec![0u8; MAX_COVER_BYTES + 1]).is_none());

        store.remove(source);
        assert!(store.existing(source).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
