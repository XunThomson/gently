//! 启动看门狗（Windows，R140 追加）。
//!
//! 背景：本机遇到 WebView2 运行时/会话状态异常时，`tauri::Builder` 的 setup 能完整走完、
//! 主窗口对象也存在（`get_webview_window("main")` 返回 Some），但 **OS 窗口永远不创建**
//! （`is_visible=false`、`outer_size` 报 `FailedToReceiveMessage`）——用户看到的是
//! 「双击后什么都没有」，终端里也没有错误。
//!
//! 这里只做一件事：启动 12 秒后主窗口仍不可见，就弹一个原生 MessageBox 说明
//! 「WebView2 没有起来、重启/修复运行时时怎么办」，同时写一条 error 日志。
//! **不尝试自动重启或删 profile**：那会让用户的数据状态更难判断。

use std::time::Duration;

use tauri::Manager;

/// 12 秒足够正常的 WebView2 首帧；超过还没窗口就是环境异常。
const GRACE: Duration = Duration::from_secs(12);

pub fn install(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(GRACE);
        let Some(main) = app.get_webview_window("main") else {
            return;
        };
        if main.is_visible().unwrap_or(false) {
            return;
        }
        tracing::error!(
            "主窗口 12 秒内仍不可见：WebView2 初始化失败（不是应用逻辑）。\
             请重启 Windows 后重试；仍失败则修复 Microsoft Edge WebView2 Runtime。"
        );
        #[cfg(windows)]
        show_message(
            "gently 的窗口没有创建出来。\n\n\
             这通常是 WebView2 运行时/会话状态异常（不是设置或曲库损坏）：\n\
             1. 关闭所有 gently 窗口，重启 Windows 后重试；\n\
             2. 仍不行时，修复 Microsoft Edge WebView2 Runtime；\n\
             3. 日志在 %APPDATA%\\com.xun.gently\\logs。\n\n\
             你的曲库与导入文件不会被这一步修改。",
        );
    });
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
