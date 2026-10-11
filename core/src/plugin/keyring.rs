//! 系统凭据库实现（Windows Credential Manager）。
//!
//! 依赖取舍：`keyring` crate 不在本机离线 registry 缓存里；而系统凭据 API 只需要
//! 读 / 写 / 删 / 枚举四个调用，直接用 `windows-sys`（**已在缓存里**）调 Win32 更可控，
//! 也不必为「存一条字符串」引一整套平台抽象。
//!
//! 结构：
//! - **目标名** `gently:<plugin_id>:<key>`：凭据库是扁平的（没有命名空间），
//!   前缀让我们既能按插件隔离，又能用 `CredEnumerateW` 按插件枚举；
//! - **值** 以 UTF-16LE 字节存进 `CredentialBlob`（Credential Manager 的原生编码）；
//! - 类型固定 `CRED_TYPE_GENERIC`，持久性 `CRED_PERSIST_LOCAL_MACHINE`（跟用户走，不漫游）；
//! - 任何一步失败都**不 panic**：读失败当「没有」，写失败记 warn（调用方看到的是
//!   `credentials.status` 里的「未配置」，而不是崩在宿主里）。
//!
//! 非 Windows 平台：`open()` 返回 `Unsupported`，由调用方退回内存实现
//! （macOS Keychain / Linux Secret Service 未接入，README 与契约里如实写明）。

use super::credentials::CredentialStore;

/// 目标名前缀：`gently:<plugin_id>:<key>`
const TARGET_PREFIX: &str = "gently";

/// 把一个值的最长长度限制住：Credential Manager 的 blob 上限是 5×512 字节，
/// 这里按 UTF-16 计（一个字符两字节）取一个安全值。
#[cfg(windows)]
const MAX_VALUE_CHARS: usize = 1280;

#[cfg(windows)]
pub struct OsCredentialStore {
    /// 实际写入的目标名前缀（测试时可换成独有前缀，避免污染用户的凭据库）
    prefix: String,
}

#[cfg(windows)]
impl OsCredentialStore {
    /// 打开系统凭据库；不可用时返回 `Err(说明)`，调用方据此退回内存实现。
    pub fn open() -> Result<Self, String> {
        Ok(Self { prefix: TARGET_PREFIX.to_string() })
    }

    /// 测试/排障用：换一个目标名前缀（生产走 `open()`）。
    #[cfg(test)]
    fn with_prefix(prefix: &str) -> Self {
        Self { prefix: prefix.to_string() }
    }

    fn target(&self, plugin_id: &str, key: &str) -> String {
        format!("{}:{}:{}", self.prefix, plugin_id, key)
    }
}

#[cfg(windows)]
impl CredentialStore for OsCredentialStore {
    fn get(&self, plugin_id: &str, key: &str) -> Option<String> {
        windows_impl::read(&self.target(plugin_id, key))
    }

    fn set(&self, plugin_id: &str, key: &str, value: Option<&str>) {
        let target = self.target(plugin_id, key);
        match value {
            Some(value) => {
                if let Err(err) = windows_impl::write(&target, plugin_id, value) {
                    tracing::warn!(target = %target, %err, "写入系统凭据失败");
                }
            }
            None => {
                if let Err(err) = windows_impl::delete(&target) {
                    tracing::warn!(target = %target, %err, "删除系统凭据失败");
                }
            }
        }
    }

    fn keys(&self, plugin_id: &str) -> Vec<String> {
        let prefix = format!("{}:{}:", self.prefix, plugin_id);
        windows_impl::list(&prefix)
    }

    fn backend(&self) -> &'static str {
        "windows-credential-manager"
    }
}

/// 非 Windows：明确不支持（返回 Err → 调用方退回内存实现），而不是假装成功。
#[cfg(not(windows))]
pub struct OsCredentialStore;

#[cfg(not(windows))]
impl OsCredentialStore {
    pub fn open() -> Result<Self, String> {
        Err("当前平台未接入系统凭据库（macOS Keychain / Linux Secret Service 待补）".to_string())
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
        CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    /// 把 Rust 字符串转成以 NUL 结尾的 UTF-16 向量。
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 系统错误码 → 可读说明（`GetLastError` 语义：0 表示成功）。
    fn last_error() -> u32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32
    }

    /// 读一条凭据；不存在或读取失败都返回 `None`。
    pub fn read(target: &str) -> Option<String> {
        let target_wide = wide(target);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();

        // SAFETY: `CredReadW` 成功时会把新分配的 CREDENTIALW 指针写进 `credential`；
        // 失败时不写，我们直接返回。指针在 `CredFree` 之前保持有效。
        let ok = unsafe {
            CredReadW(
                target_wide.as_ptr(),
                CRED_TYPE_GENERIC,
                0,
                &mut credential as *mut *mut CREDENTIALW,
            )
        };
        if ok == 0 || credential.is_null() {
            return None;
        }

        let value = unsafe {
            let entry = &*credential;
            let bytes = std::slice::from_raw_parts(
                entry.CredentialBlob,
                entry.CredentialBlobSize as usize,
            );
            // 凭据以 UTF-16LE 存储：按 u16 解释后丢掉结尾的 NUL
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let text = String::from_utf16_lossy(&units);
            CredFree(credential as *const c_void);
            text.trim_end_matches('\0').to_string()
        };
        Some(value)
    }

    /// 写一条凭据（已存在则覆盖）。
    pub fn write(target: &str, user: &str, value: &str) -> Result<(), String> {
        // 长度上限：Credential Manager 的 blob 最大 5×512 字节，取一个保守的安全值
        let units: Vec<u16> = value.encode_utf16().collect();
        if units.len() > super::MAX_VALUE_CHARS {
            return Err(format!(
                "凭据值过长（{} > {} 个字符），系统凭据库放不下",
                units.len(),
                super::MAX_VALUE_CHARS
            ));
        }
        let mut blob: Vec<u8> = Vec::with_capacity(units.len() * 2);
        for unit in &units {
            blob.extend_from_slice(&unit.to_le_bytes());
        }

        let mut target_wide = wide(target);
        let mut user_wide = wide(user);
        let entry = CREDENTIALW {
            Flags: CRED_FLAGS::default(),
            Type: CRED_TYPE_GENERIC,
            TargetName: target_wide.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user_wide.as_mut_ptr(),
        };

        // SAFETY: 所有指针都指向本函数栈上的有效缓冲，且在调用期间不会被移动。
        let ok = unsafe { CredWriteW(&entry, 0) };
        if ok == 0 {
            return Err(format!("CredWriteW 失败（错误码 {}）", last_error()));
        }
        Ok(())
    }

    /// 删除一条凭据；不存在不算错误（清除一个没配过的键是正常操作）。
    pub fn delete(target: &str) -> Result<(), String> {
        let target_wide = wide(target);
        // SAFETY: `CredDeleteW` 只读目标名，不需要释放返回值。
        let ok = unsafe { CredDeleteW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = last_error();
            if code == ERROR_NOT_FOUND {
                return Ok(());
            }
            return Err(format!("CredDeleteW 失败（错误码 {code}）"));
        }
        Ok(())
    }

    /// 按前缀枚举目标名，返回去掉前缀的部分（即凭据键）。
    pub fn list(prefix: &str) -> Vec<String> {
        let filter = wide(&format!("{prefix}*"));
        let mut count: u32 = 0;
        let mut entries: *mut *mut CREDENTIALW = std::ptr::null_mut();

        // SAFETY: `CredEnumerateW` 成功时分配一个 CREDENTIALW* 数组写进 `entries`。
        let ok = unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut entries) };
        if ok == 0 || entries.is_null() {
            // 没有任何匹配项时返回 ERROR_NOT_FOUND：这是正常情况，不是错误
            return Vec::new();
        }

        let mut keys = Vec::new();
        unsafe {
            for index in 0..count as usize {
                let entry = *entries.add(index);
                if entry.is_null() {
                    continue;
                }
                let name = (*entry).TargetName;
                if name.is_null() {
                    continue;
                }
                // 读到第一个 NUL 为止
                let mut len = 0usize;
                while *name.add(len) != 0 {
                    len += 1;
                }
                let full = String::from_utf16_lossy(std::slice::from_raw_parts(name, len));
                if let Some(key) = full.strip_prefix(prefix) {
                    keys.push(key.to_string());
                }
            }
            CredFree(entries as *const c_void);
        }
        keys.sort();
        keys
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 测试用独立前缀：既能验证真实凭据库的行为，又不会碰用户的其它凭据。
    ///
    /// **每个测试一个前缀**：`cargo test` 默认并行跑测试，共用前缀会让两个测试互相
    /// 清掉对方的键（踩过一次，表现为偶发失败）。
    const PREFIX_ROUNDTRIP: &str = "gently-selftest-roundtrip";
    const PREFIX_OVERSIZE: &str = "gently-selftest-oversize";

    fn cleanup(store: &OsCredentialStore) {
        for key in store.keys("plugin-test") {
            store.set("plugin-test", &key, None);
        }
    }

    #[test]
    fn os_store_round_trips_through_the_system_keyring() {
        let store = OsCredentialStore::with_prefix(PREFIX_ROUNDTRIP);
        cleanup(&store);

        store.set("plugin-test", "cookie", Some("SESS=abc"));
        assert_eq!(store.get("plugin-test", "cookie").as_deref(), Some("SESS=abc"));
        assert_eq!(store.keys("plugin-test"), vec!["cookie".to_string()]);

        // 覆盖写：后写的值生效
        store.set("plugin-test", "cookie", Some("SESS=def"));
        assert_eq!(store.get("plugin-test", "cookie").as_deref(), Some("SESS=def"));

        // 多个键按插件隔离
        store.set("plugin-test", "token", Some("t1"));
        assert_eq!(store.keys("plugin-test"), vec!["cookie".to_string(), "token".to_string()]);
        assert!(store.get("other-plugin", "cookie").is_none());
        assert!(store.keys("other-plugin").is_empty());

        // 清除（含「清除一个本来就不存在的键」：不报错，只是没有变化）
        store.set("plugin-test", "cookie", None);
        assert!(store.get("plugin-test", "cookie").is_none());
        store.set("plugin-test", "missing", None);
        assert_eq!(store.keys("plugin-test"), vec!["token".to_string()]);

        cleanup(&store);
        assert!(store.keys("plugin-test").is_empty());
    }

    #[test]
    fn rejects_values_that_do_not_fit_the_system_store() {
        let store = OsCredentialStore::with_prefix(PREFIX_OVERSIZE);
        cleanup(&store);

        let huge = "x".repeat(super::MAX_VALUE_CHARS + 1);
        store.set("plugin-test", "huge", Some(&huge));
        // 写不进去（超过系统上限）：读回来就是「没有」，而不是半截值
        assert!(store.get("plugin-test", "huge").is_none());
        cleanup(&store);
    }
}
