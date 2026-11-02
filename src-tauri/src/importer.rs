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

    /// 导入的落点目录（`<filesDir>/music`）：判断「哪些曲目是导入进来的副本」要用它。
    pub fn import_dir() -> Result<String, String> {
        let handle = HANDLE.get().ok_or_else(|| "导入插件尚未注册".to_string())?;
        let reply = handle
            .run_mobile_plugin::<ImportDir>("importedDir", serde_json::json!({}))
            .map_err(|err| format!("读导入目录失败：{err}"))?;
        Ok(reply.dir)
    }

    /// 这次导入到哪了（R136）：拷文件的进度由 Kotlin 维护，这里只是读走快照。
    pub fn progress() -> Result<ImportProgress, String> {
        let handle = HANDLE.get().ok_or_else(|| "导入插件尚未注册".to_string())?;
        handle
            .run_mobile_plugin::<ImportProgress>("importProgress", serde_json::json!({}))
            .map_err(|err| format!("读导入进度失败：{err}"))
    }
}

/// Kotlin `importedDir` 的返回体
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ImportDir {
    #[serde(default)]
    pub dir: String,
}

/// 一次导入的进度快照（R136，与 Kotlin `ImportPlugin.Progress` 字段一一对应）。
///
/// 为什么是「快照 + 轮询」：Kotlin → Rust 没有回调通道，而 Rust → Kotlin 是现成的。
/// 前端在导入期间每 250ms 问一次 `import_progress`——一轮导入几十次调用，代价可以忽略，
/// 换来的是「拷 200 MB 文件时界面不再长时间停在『导入中…』」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// 是否有导入在进行
    pub active: bool,
    /// 正在拷的文件名（还没开始时为空串）
    #[serde(default)]
    pub file_name: String,
    /// 第几个文件（从 1 开始；0 = 还没开始）
    #[serde(default)]
    pub file_index: u32,
    /// 这次一共选了几个文件
    #[serde(default)]
    pub file_count: u32,
    /// 已拷字节 / 总字节（读不到大小就是 0，界面按「未知总量」显示）
    #[serde(default)]
    pub bytes_done: u64,
    #[serde(default)]
    pub bytes_total: u64,
    #[serde(default)]
    pub imported: u32,
    #[serde(default)]
    pub failed: u32,
    #[serde(default)]
    pub skipped: u32,
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

/// 导入的落点目录；桌面端没有这回事（返回空串，前端因此不会列出「导入的副本」）。
pub fn import_dir() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        android::import_dir()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(String::new())
    }
}

/// 一次导入的进度；桌面端永远 `active: false`（没有系统文件选择器这条路）。
pub fn progress() -> Result<ImportProgress, String> {
    #[cfg(target_os = "android")]
    {
        android::progress()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(ImportProgress::default())
    }
}
