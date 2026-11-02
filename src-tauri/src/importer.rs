//! 导入音频（Android SAF）的宿主侧桥（P3 · R114）。
//!
//! 链路：`views/local/components/ScanPanel` → `services/import.service.ts`
//! → 宿主命令 `import_audio` → 本模块 → Tauri 移动插件 → Kotlin `ImportPlugin`
//! （`ACTION_OPEN_DOCUMENT` 选文件 → 拷进应用私有目录 `<filesDir>/music`）
//! → 前端拿回 `{imported, failed, skipped, dir}` → 用核心的 `library.local.scan` 入库。
//!
//! 为什么走宿主而不是核心：文件选择器是**操作系统**的能力，核心不认识 Activity；
//! 核心只做「给目录，扫出入库」这一件事（`library.local.scan` 早就有了）。
//!
//! 非 Android 平台：插件是空插件，命令直接回「这台设备上没有系统文件选择器」
//! ——桌面端本来就能粘贴路径，不需要这条路。

use serde::{Deserialize, Serialize};
use tauri::{plugin::TauriPlugin, Wry};

/// 导入结果（与 Kotlin 侧 `JSObject` 的字段一一对应）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: u32,
    pub failed: u32,
    /// 选进来但不是音频、被跳过的文件数（R118：选择器不再只过滤 `audio/*`，
    /// 因为系统 MIME 库不认 `.m4s`，只过滤音频等于把这类文件灰掉、根本选不了）
    #[serde(default)]
    pub skipped: u32,
    pub cancelled: bool,
    /// 文件的落点目录（前端拿它去调 `library.local.scan`）；取消时为空串
    #[serde(default)]
    pub dir: String,
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use std::sync::OnceLock;

    static HANDLE: OnceLock<tauri::plugin::PluginHandle<Wry>> = OnceLock::new();

    pub fn plugin() -> TauriPlugin<Wry> {
        tauri::plugin::Builder::new("gently-import")
            .setup(|_app, api| {
                let handle = api.register_android_plugin("com.xun.gently", "ImportPlugin")?;
                let _ = HANDLE.set(handle);
                Ok(())
            })
            .build()
    }

    pub async fn pick_audio() -> Result<ImportOutcome, String> {
        let handle = HANDLE.get().ok_or_else(|| "导入插件尚未注册".to_string())?;
        /* 用**异步**变体：用户挑文件可能要几十秒，不能用同步版把运行时线程占住 */
        handle
            .run_mobile_plugin_async::<ImportOutcome>("pickAudio", serde_json::json!({}))
            .await
            .map_err(|err| format!("打开文件选择器失败：{err}"))
    }
}

pub fn plugin() -> TauriPlugin<Wry> {
    #[cfg(target_os = "android")]
    {
        android::plugin()
    }
    #[cfg(not(target_os = "android"))]
    {
        tauri::plugin::Builder::new("gently-import").build()
    }
}

pub async fn pick_audio() -> Result<ImportOutcome, String> {
    #[cfg(target_os = "android")]
    {
        android::pick_audio().await
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("这台设备上没有系统文件选择器（桌面端请直接填目录后扫描）".to_string())
    }
}
