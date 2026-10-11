//! 本机数据目录布局（契约 §9）。
//!
//! core 不依赖 tauri，因此**根目录由调用方注入**（Tauri 用 `app_data_dir()`，
//! 测试用临时目录）——这样同一套路径逻辑既能在应用里跑，也能单测。

use std::path::{Path, PathBuf};

use crate::contract::SystemPaths;

/// **源文件路径的稳定字符串形式**（本地曲目 id、曲库里的 `path` 列、封面缓存文件名共用同一个）。
///
/// 规则：`\` → `/`，折叠重复分隔符，去掉末尾分隔符。
///
/// 为什么必须归一：Windows 接受 `C:\\Music\\a.mp3` 这种重复分隔符的写法，用户粘贴目录时很容易带上。
/// 不归一就会把**同一个文件**按两种拼法收进曲库两次（打包版实测真的出现了两行），
/// 而且扫描侧（文件系统路径，单个 `\`）与列表侧（库里的路径）算出的封面哈希也会对不上。
///
/// 不做 `..`/`.` 解析：那要 `canonicalize`，会引入 `\\?\` 前缀并让已有曲库的 id 全部失效——
/// 收益只是多认一种写法，不值得。
pub fn normalize_source_path(path: &Path) -> String {
    normalize_source_path_str(&path.to_string_lossy())
}

/// [`normalize_source_path`] 的字符串版（库里存的是字符串，清理时要按同一份规则比较）。
pub fn normalize_source_path_str(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.replace('\\', "/").chars() {
        if ch == '/' {
            if !out.ends_with('/') {
                out.push('/');
            }
        } else {
            out.push(ch);
        }
    }
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// `<appData>/gently/` 下的全部路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub data: PathBuf,
    /// 可随时整目录删除的缓存（榜单/歌词/封面）
    pub cache: PathBuf,
    pub plugins: PathBuf,
    /// 订阅索引缓存（断网可用）
    pub subscriptions: PathBuf,
    pub skins: PathBuf,
    pub downloads: PathBuf,
    pub logs: PathBuf,
    /// SQLite 文件
    pub db: PathBuf,
}

impl AppPaths {
    /// 由数据根目录推导全部子路径。
    pub fn resolve(base: impl AsRef<Path>) -> Self {
        let data = base.as_ref().to_path_buf();
        Self {
            cache: data.join("cache"),
            plugins: data.join("plugins"),
            subscriptions: data.join("subscriptions"),
            skins: data.join("skins"),
            downloads: data.join("downloads"),
            logs: data.join("logs"),
            db: data.join("gently.db"),
            data,
        }
    }

    /// 建目录（幂等）。启动时调用一次，失败不应阻塞应用——
    /// 由调用方决定降级策略（见 `src-tauri` 的启动流程）。
    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [
            &self.data,
            &self.cache,
            &self.plugins,
            &self.subscriptions,
            &self.skins,
            &self.downloads,
            &self.logs,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    /// 全部受管目录（用于 `system.reveal` 的白名单校验：不允许前端传任意路径）。
    pub fn managed_roots(&self) -> [&Path; 7] {
        [
            &self.data,
            &self.cache,
            &self.plugins,
            &self.subscriptions,
            &self.skins,
            &self.downloads,
            &self.logs,
        ]
    }

    /// 路径是否位于某个受管目录内（含等于本身）。
    pub fn is_managed(&self, candidate: &Path) -> bool {
        let normalized = normalize(candidate);
        self.managed_roots()
            .iter()
            .any(|root| normalized.starts_with(normalize(root)))
    }

    /// 输出给前端的字符串形式（统一为正斜杠，避免 Windows 反斜杠在 JSON 里被转义）。
    pub fn to_dto(&self) -> SystemPaths {
        let s = |p: &PathBuf| p.to_string_lossy().replace('\\', "/");
        SystemPaths {
            data: s(&self.data),
            cache: s(&self.cache),
            plugins: s(&self.plugins),
            subscriptions: s(&self.subscriptions),
            skins: s(&self.skins),
            downloads: s(&self.downloads),
            logs: s(&self.logs),
        }
    }
}

/// 尽力规范化：去掉 `.`/`..` 段（不触碰文件系统，路径可能还不存在）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_expected_layout() {
        let p = AppPaths::resolve("/tmp/gently");
        assert_eq!(p.db, PathBuf::from("/tmp/gently/gently.db"));
        assert_eq!(p.subscriptions, PathBuf::from("/tmp/gently/subscriptions"));
    }

    #[test]
    fn managed_check_rejects_outside_paths() {
        let p = AppPaths::resolve("/tmp/gently");
        assert!(p.is_managed(Path::new("/tmp/gently/logs/app.log")));
        assert!(p.is_managed(Path::new("/tmp/gently")));
        // 越权路径必须被拒（前端可能传任意字符串）
        assert!(!p.is_managed(Path::new("/tmp/other/file")));
        assert!(!p.is_managed(Path::new("/etc/passwd")));
        // 用 .. 逃逸也要被拒
        assert!(!p.is_managed(Path::new("/tmp/gently/../other")));
    }
}
