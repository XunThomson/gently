//! 插件凭据读写。
//!
//! **桌面端落 OS 凭据库**（[`super::keyring::OsCredentialStore`]，Windows Credential Manager /
//! macOS Keychain / Linux Secret Service 走各自的系统接口），**不可用时退回内存实现**
//! （[`MemoryCredentialStore`]，进程退出即失效）——两个实现同一 trait，
//! 插件宿主与命令层只依赖接口，替换实现不影响沙箱与权限逻辑。
//!
//! 约束（契约 §5.3）：**凭据永不落库、永不进日志**；`credentials.get` 只把值交给声明了
//! `credentials` 权限的那个插件；命令层的语义（只读写清单声明的键、永不回值）与实现无关。
//!
//! 为什么不是 `keyring` crate：它不在本机离线 registry 缓存里（离线构建不可得），
//! 而系统凭据 API 本身很窄（读/写/删/枚举四个调用），直接调用比引一个大依赖更可控。

use std::collections::HashMap;
use std::sync::Mutex;

pub trait CredentialStore: Send + Sync {
    /// 取某个插件的凭据；未配置返回 `None`。
    fn get(&self, plugin_id: &str, key: &str) -> Option<String>;

    /// 写入或清除（`None` = 清除）。
    fn set(&self, plugin_id: &str, key: &str, value: Option<&str>);

    /// 该插件**已配置值**的键（`credentials.status` 只回「是否已配置」，永不回值）。
    fn keys(&self, plugin_id: &str) -> Vec<String>;

    /// 落点标识：`system.status` 会带上它，界面据此说明「重启后是否还要重新填写」。
    fn backend(&self) -> &'static str {
        "memory"
    }
}

/// 内存实现：进程退出即失效。用于测试，以及系统凭据库不可用时的兜底。
#[derive(Default)]
pub struct MemoryCredentialStore {
    values: Mutex<HashMap<String, String>>,
}

impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(plugin_id: &str, key: &str) -> String {
        format!("{plugin_id}/{key}")
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn get(&self, plugin_id: &str, key: &str) -> Option<String> {
        self.values.lock().ok()?.get(&Self::slot(plugin_id, key)).cloned()
    }

    fn set(&self, plugin_id: &str, key: &str, value: Option<&str>) {
        let Ok(mut map) = self.values.lock() else { return };
        let slot = Self::slot(plugin_id, key);
        match value {
            Some(value) => {
                map.insert(slot, value.to_string());
            }
            None => {
                map.remove(&slot);
            }
        }
    }

    fn keys(&self, plugin_id: &str) -> Vec<String> {
        let prefix = format!("{plugin_id}/");
        let Ok(map) = self.values.lock() else { return Vec::new() };
        map.keys()
            .filter_map(|slot| slot.strip_prefix(&prefix).map(str::to_string))
            .collect()
    }
}

/// 选一个可用的凭据存储：优先系统凭据库，不可用则退回内存（并留下一条 warn）。
///
/// 「不可用」包括：非 Windows/macOS（Linux 需要 Secret Service，未接）、
/// 系统 API 调用失败（如凭据库被策略禁用）。**不静默降级**——调用方会看到日志，
/// 界面上的凭据提示也据此显示「重启后需要重新填写」。
pub fn open_store() -> std::sync::Arc<dyn CredentialStore> {
    #[cfg(target_os = "android")]
    {
        std::sync::Arc::new(MemoryCredentialStore::new())
    }

    #[cfg(not(target_os = "android"))]
    {
        match super::keyring::OsCredentialStore::open() {
            Ok(store) => {
                tracing::info!(backend = store.backend(), "凭据存储已就绪");
                std::sync::Arc::new(store)
            }
            Err(err) => {
                tracing::warn!(
                %err,
                "系统凭据库不可用，凭据降级为进程内存储（重启后需要重新填写）"
            );
                std::sync::Arc::new(MemoryCredentialStore::new())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_clears() {
        let store = MemoryCredentialStore::new();
        store.set("p1", "cookie", Some("secret"));
        assert_eq!(store.get("p1", "cookie").as_deref(), Some("secret"));
        assert_eq!(store.keys("p1"), vec!["cookie".to_string()]);
        // 插件之间互不可见
        assert!(store.get("p2", "cookie").is_none());
        assert!(store.keys("p2").is_empty());

        store.set("p1", "cookie", None);
        assert!(store.get("p1", "cookie").is_none());
        assert!(store.keys("p1").is_empty());
    }
}
