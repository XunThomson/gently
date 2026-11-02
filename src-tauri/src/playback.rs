//! 播放通知 / 前台服务的**宿主侧桥**（Android，P2-1 · R112）。
//!
//! 分工：
//! - 前端（`services/playbackBanner.service.ts`）只在「开始 / 停止」时调一次 `playback_banner`；
//! - 本模块把一个 Tauri 插件注册到 Kotlin 侧（`com.xun.gently.PlaybackPlugin`），
//!   再用 `run_mobile_plugin("update", payload)` 把状态推过去；
//! - 播放状态仍以前端 store 为**唯一权威**：Kotlin 只负责「保持前台服务 + 显示通知」，
//!   不读播放位置、不自己计时。
//!
//! 为什么不用系统事件而用命令：Tauri 的移动端桥只支持「命令」这一个方向（Rust → Kotlin），
//! 所以「开始播放」必须由前端显式发起；这也正好符合「用户动作之前不做多余的事」。
//!
//! 非 Android 平台：`plugin()` 返回一个空插件、`update()` 直接返回 Ok——
//! 桌面端因此完全不需要 `cfg` 判断，也不会多出一条永远失败的调用。

use tauri::{plugin::TauriPlugin, Wry};

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use std::sync::OnceLock;

    static HANDLE: OnceLock<tauri::plugin::PluginHandle<Wry>> = OnceLock::new();

    /// 注册 Kotlin 侧插件（名字必须与前端 `invoke` 的命令无关：命令走 `playback_banner`）。
    pub fn plugin() -> TauriPlugin<Wry> {
        tauri::plugin::Builder::new("gently-playback")
            .setup(|_app, api| {
                let handle = api.register_android_plugin("com.xun.gently", "PlaybackPlugin")?;
                let _ = HANDLE.set(handle);
                Ok(())
            })
            .build()
    }

    /// 把「在播什么 / 在不在播」推给前台服务（通知按钮的图标据此切换）。
    pub fn update(active: bool, title: &str, artist: &str, playing: bool) -> Result<(), String> {
        let handle = HANDLE.get().ok_or_else(|| "播放通知插件尚未注册".to_string())?;
        let payload = serde_json::json!({
            "active": active,
            "title": title,
            "artist": artist,
            "playing": playing,
        });
        handle
            .run_mobile_plugin::<serde_json::Value>("update", payload)
            .map_err(|err| format!("播放通知调用失败：{err}"))?;
        Ok(())
    }
}

/// 宿主插件（桌面：空插件，什么也不做）。
pub fn plugin() -> TauriPlugin<Wry> {
    #[cfg(target_os = "android")]
    {
        android::plugin()
    }
    #[cfg(not(target_os = "android"))]
    {
        tauri::plugin::Builder::new("gently-playback").build()
    }
}

/// 同步播放通知。桌面端是空操作（保持 `Ok`，前端不必分平台）。
pub fn update(active: bool, title: &str, artist: &str, playing: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::update(active, title, artist, playing)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (active, title, artist, playing);
        Ok(())
    }
}
