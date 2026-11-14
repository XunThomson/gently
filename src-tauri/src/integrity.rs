//! 进程完整性级别（Windows Mandatory Integrity Control）。
//!
//! 为什么宿主需要知道这件事：标准登录令牌带有
//! `TOKEN_MANDATORY_POLICY_NEW_PROCESS_MIN`，子进程的完整性级别取
//! 「父进程 IL」与「可执行文件 IL」的较小值。工作区/构建产物一旦被标成
//! Low，即使从普通终端启动，`gently.exe` 也会以 Low 运行：
//! - 写不了 Medium 的 `%APPDATA%` / `%LOCALAPPDATA%`（日志、配置、WebView2 profile）；
//! - WebView2 初始化失败，主窗口永远不可见。
//!
//! 这里只做**只读检测**（`GetTokenInformation(TokenIntegrityLevel)`），
//! 不修改任何标签。修复标签必须由用户在管理员终端执行 `icacls /setintegritylevel`。

/// Windows 的四种标准完整性级别；`Unknown` 保留原始 RID 便于诊断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrityLevel {
    Low,
    Medium,
    High,
    System,
    Unknown(u32),
}

impl IntegrityLevel {
    pub fn is_low(self) -> bool {
        matches!(self, Self::Low)
    }

    /// 日志/弹窗里的短标签
    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
            Self::System => "System",
            Self::Unknown(_) => "Unknown",
        }
    }

    /// 完整性 SID 的最后一个子授权（RID）；未知时给 `None`。
    pub fn rid(self) -> Option<u32> {
        match self {
            Self::Low => Some(0x1000),
            Self::Medium => Some(0x2000),
            Self::High => Some(0x3000),
            Self::System => Some(0x4000),
            Self::Unknown(rid) if rid != 0 => Some(rid),
            Self::Unknown(_) => None,
        }
    }

    fn from_rid(rid: u32) -> Self {
        match rid {
            0x1000 => Self::Low,
            0x2000 => Self::Medium,
            0x3000 => Self::High,
            0x4000 => Self::System,
            other => Self::Unknown(other),
        }
    }
}

/// 当前进程的完整性级别；非 Windows 平台返回 `Unknown(0)`。
#[cfg(windows)]
pub fn current() -> IntegrityLevel {
    windows::current()
}

#[cfg(not(windows))]
pub fn current() -> IntegrityLevel {
    IntegrityLevel::Unknown(0)
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;

    use super::IntegrityLevel;

    type Bool = i32;

    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_INTEGRITY_LEVEL: u32 = 25;

    #[repr(C)]
    struct SidAndAttributes {
        sid: *mut c_void,
        attributes: u32,
    }

    #[repr(C)]
    struct TokenMandatoryLabel {
        label: SidAndAttributes,
    }

    // `GetTokenInformation(TokenIntegrityLevel)` 返回 `TOKEN_MANDATORY_LABEL`，
    // 且缓冲区里还要放得下它指向的 SID。先问所需长度、再按长度分配；固定 16 字节
    // 会在部分令牌上返回 `ERROR_INSUFFICIENT_BUFFER`。
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, desired_access: u32, token: *mut *mut c_void) -> Bool;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            info: *mut c_void,
            len: u32,
            returned: *mut u32,
        ) -> Bool;
        fn GetSidSubAuthorityCount(sid: *mut c_void) -> *mut u8;
        fn GetSidSubAuthority(sid: *mut c_void, index: u32) -> *mut u32;
        fn CloseHandle(handle: *mut c_void) -> Bool;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }

    pub fn current() -> IntegrityLevel {
        unsafe {
            let mut token: *mut c_void = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 || token.is_null() {
                return IntegrityLevel::Unknown(1);
            }

            /* 第一次调用只问长度：预期返回 false + ERROR_INSUFFICIENT_BUFFER */
            let mut needed: u32 = 0;
            let _ = GetTokenInformation(
                token,
                TOKEN_INTEGRITY_LEVEL,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
            if needed == 0 {
                let _ = CloseHandle(token);
                return IntegrityLevel::Unknown(2);
            }

            /* 用 u64 分配，保证按 8 字节对齐；长度向上取整到 8 的倍数 */
            let mut words = vec![0u64; ((needed as usize + 7) / 8).max(1)];
            let ok = GetTokenInformation(
                token,
                TOKEN_INTEGRITY_LEVEL,
                words.as_mut_ptr() as *mut c_void,
                (words.len() * std::mem::size_of::<u64>()) as u32,
                &mut needed,
            );
            let _ = CloseHandle(token);

            if ok == 0 {
                return IntegrityLevel::Unknown(3);
            }
            let label = &*(words.as_ptr() as *const TokenMandatoryLabel);
            if label.label.sid.is_null() {
                return IntegrityLevel::Unknown(4);
            }

            let count_ptr = GetSidSubAuthorityCount(label.label.sid);
            if count_ptr.is_null() {
                return IntegrityLevel::Unknown(5);
            }
            let count = *count_ptr;
            if count == 0 {
                return IntegrityLevel::Unknown(6);
            }

            let rid_ptr = GetSidSubAuthority(label.label.sid, (count - 1) as u32);
            if rid_ptr.is_null() {
                return IntegrityLevel::Unknown(7);
            }
            IntegrityLevel::from_rid(*rid_ptr)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::IntegrityLevel;

    #[test]
    fn known_rids_map_to_levels() {
        assert_eq!(IntegrityLevel::from_rid(0x1000), IntegrityLevel::Low);
        assert_eq!(IntegrityLevel::from_rid(0x2000), IntegrityLevel::Medium);
        assert_eq!(IntegrityLevel::from_rid(0x3000), IntegrityLevel::High);
        assert_eq!(IntegrityLevel::from_rid(0x4000), IntegrityLevel::System);
    }

    #[test]
    fn unknown_rids_keep_their_value_for_diagnostics() {
        let level = IntegrityLevel::from_rid(0x1234);
        assert_eq!(level, IntegrityLevel::Unknown(0x1234));
        assert_eq!(level.rid(), Some(0x1234));
        assert_eq!(level.label(), "Unknown");
        assert!(!level.is_low());
    }

    #[test]
    fn low_is_the_only_level_that_blocks_webview2() {
        assert!(IntegrityLevel::Low.is_low());
        assert!(!IntegrityLevel::Medium.is_low());
        assert!(!IntegrityLevel::High.is_low());
        assert!(!IntegrityLevel::System.is_low());
    }

    #[cfg(windows)]
    #[test]
    fn current_process_integrity_is_readable() {
        let level = super::current();
        println!("current integrity = {level:?}");
        assert_ne!(level, IntegrityLevel::Unknown(0), "GetTokenInformation 失败");
        assert!(level.rid().is_some());
    }
}
