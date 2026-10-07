//! 插件凭据读取。
//!
//! **M1b 只提供 trait 与内存实现**：真实的 OS keyring（Windows Credential Manager /
//! macOS Keychain / libsecret）在 M1c 接入 `keyring` crate 时替换 [`MemoryCredentialStore`]。
//! 之所以先定义 trait：插件宿主只依赖这个接口，替换实现不影响沙箱与权限逻辑。
//!
//! 约束（契约 §5.3）：**凭据永不落库、永不进日志**；`credentials.get` 只把值交给声明了
//! `credentials` 权限的那个插件。

use std::collections::HashMap;
use std::sync::Mutex;

pub trait CredentialStore: Send + Sync {
    /// 取某个插件的凭据；未配置返回 None。
    fn get(&self, plugin_id: &str, key: &str) -> Option<String>;
}

/// 内存实现：进程退出即失效，仅用于测试与「尚未接入 keyring」的过渡期。
#[derive(Default)]
pub struct MemoryCredentialStore {
    values: Mutex<HashMap<String, String>>,
}

impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, plugin_id: &str, key: &str, value: &str) {
        if let Ok(mut map) = self.values.lock() {
            map.insert(format!("{plugin_id}/{key}"), value.to_string());
        }
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn get(&self, plugin_id: &str, key: &str) -> Option<String> {
        self.values.lock().ok()?.get(&format!("{plugin_id}/{key}")).cloned()
    }
}
