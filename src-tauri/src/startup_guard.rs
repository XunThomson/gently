//! 启动看门狗（Windows，R140 追加 / R142 细化）。
//!
//! 背景：本机遇到 WebView2 运行时/会话状态异常时，`tauri::Builder` 的 setup 能完整走完、
//! 主窗口对象也存在（`get_webview_window("main")` 返回 Some），但 **OS 窗口永远不创建**
//! （`is_visible=false`、`outer_size` 报 `FailedToReceiveMessage`）——用户看到的是
//! 「双击后什么都没有」，终端里也没有错误。
//!
//! R142 的真因：工作区/构建产物被打上 **Low 完整性标签**，标准令牌的
//! `TOKEN_MANDATORY_POLICY_NEW_PROCESS_MIN` 让 `gently.exe` 也以 Low 运行；
//! Low 进程写不了 Medium 的 WebView2 profile，所以浏览器进程根本不会启动。
//! 只修 `esbuild.exe` 是不够的，工作区、`target`、`release` 里的 exe 都要修。
//!
//! 这里做两件事：
//! 1. Low 完整性：立即给出**专门**提示（并退出，避免留下一个点不到的隐藏进程）；
//! 2. 其余环境问题：启动 12 秒后主窗口仍不可见，弹原生 MessageBox 说明排查顺序。
//! **不尝试自动重启或删 profile**：那会让用户的数据状态更难判断。

use std::time::Duration;

use tauri::Manager;

use crate::integrity::IntegrityLevel;

/// 12 秒足够正常的 WebView2 首帧；超过还没窗口就是环境异常。
const GRACE: Duration = Duration::from_secs(12);

pub fn install(app: tauri::AppHandle, integrity: IntegrityLevel) {
    std::thread::spawn(move || {
        if integrity.is_low() {
            /* 给日志/事件循环一拍，先把控制台与日志里的「进程完整性级别」写出去 */
            std::thread::sleep(Duration::from_secs(1));
            tracing::error!(
                integrity = integrity.label(),
                rid = ?integrity.rid(),
                "主窗口无法创建：进程完整性级别为 Low（WebView2 无法初始化）。\
                 请用普通 PowerShell 启动，并在管理员终端修复工作区与构建产物的完整性标签；\
                 只修 esbuild 不够，见 docs/GOTCHAS.md 与 scripts/check-integrity.ps1。"
            );
            #[cfg(windows)]
            show_low_integrity_message();
            app.exit(1);
            return;
        }

        std::thread::sleep(GRACE);
        let Some(main) = app.get_webview_window("main") else {
            return;
        };
        let visible = main.is_visible().unwrap_or(false);
        if visible {
            return;
        }

        let size = main.outer_size();
        tracing::error!(
            integrity = integrity.label(),
            rid = ?integrity.rid(),
            visible,
            outer_size = ?size,
            "主窗口 12 秒内仍不可见：WebView2 初始化失败（不是应用逻辑）。\
             请重启 Windows 后重试；仍失败则修复 Microsoft Edge WebView2 Runtime。"
        );
        #[cfg(windows)]
        show_message(
            "gently 的窗口没有创建出来。\n\n\
             这通常是 WebView2 运行时/会话状态异常（不是设置或曲库损坏）：\n\
             1. 关闭所有 gently 窗口，重启 Windows 后重试；\n\
             2. 仍不行时，修复 Microsoft Edge WebView2 Runtime；\n\
             3. 先看日志里的「进程完整性级别」：如果是 Low，请用\n\
                scripts/check-integrity.ps1 -Fix 修复标签后从普通 PowerShell 启动；\n\
             4. 日志在 %APPDATA%\\com.xun.gently\\logs。\n\n\
             你的曲库与导入文件不会被这一步修改。",
        );
    });
}

#[cfg(windows)]
fn show_low_integrity_message() {
    show_message(
        "gently 的进程完整性级别是 Low（S-1-16-4096）。\n\
         WebView2 因此无法初始化，主窗口不会出现。\n\n\
         常见原因：从受限/沙箱终端启动，或工作区与构建产物被低完整性标签标记。\n\
         注意：标准登录令牌会取「父进程 IL」与「exe 文件 IL」的较小值，\n\
         所以只从普通终端启动还不够，exe 本身也必须是 Medium。\n\n\
         修复（在“以管理员身份运行”的 PowerShell 中）：\n\
         icacls \"<仓库路径>\" /setintegritylevel \"(OI)(CI)Medium\" /T\n\n\
         然后从普通 PowerShell 启动；不要从 Low 终端启动。\n\
         也可运行 scripts/check-integrity.ps1 检查，-Fix 执行修复。\n\n\
         你的曲库与导入文件不会被这一步修改。",
    );
}

#[cfg(windows)]
fn show_message(text: &str) {
    use std::ptr::null_mut;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    let text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let caption: Vec<u16> = "gently".encode_utf16().chain(std::iter::once(0)).collect();
    // MB_ICONWARNING | MB_SETFOREGROUND
    unsafe {
        MessageBoxW(null_mut(), text.as_ptr(), caption.as_ptr(), 0x30 | 0x10000);
    }
}
