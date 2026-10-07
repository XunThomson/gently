//! 本机数据目录布局（契约 §9）。
//!
//! core 不依赖 tauri，因此**根目录由调用方注入**（Tauri 用 `app_data_dir()`，
//! 测试用临时目录）——这样同一套路径逻辑既能在应用里跑，也能单测。

use std::path::{Path, PathBuf};

use crate::contract::SystemPaths;

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
