package com.xun.gently

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.concurrent.thread

/**
 * 导入音频（P3，R114）：用系统的 **SAF**（`ACTION_OPEN_DOCUMENT`）选文件，
 * 拷进应用私有目录 `<filesDir>/music`，再由前端触发 `library.local.scan` 入库。
 *
 * 为什么必须是 SAF：安卓上没有「把路径粘贴进来」这条路——普通用户拿不到
 * `/storage/emulated/0/...` 这种绝对路径，之前只能靠 adb push 往应用目录塞文件。
 * SAF 还**不需要任何存储权限**：用户选了什么，系统就临时授权读那一个 URI。
 *
 * 为什么是「拷一份」而不是「把 URI 记进库」：
 * - 曲库与播放都按**文件路径**工作（`library.local.scan` / 本地代理按路径读盘），
 *   content:// URI 进来会牵动核心、代理、封面三条链路；
 * - URI 的授权是临时的，用户清理「最近打开」或卸载来源应用后就失效；
 * - 拷贝进应用私有目录后，原文件删掉也不影响曲库（用户意图是「收进我的音乐」）。
 */
@TauriPlugin
class ImportPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun pickAudio(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            /* 不能只按「音频类型」过滤：系统的 MIME 库不认 `.m4s` / `.m4b` 这类封装，
                它们会被**灰掉、根本选不了**（R118 真机实测：同一个文件改成 `.mp3`
                就能选，`.m4s` 是灰的）。所以放开到「音频 + 未知类型」，
                选完再由 `isAudioName` 按扩展名筛——认得的扩展名以核心为准
                （`core/src/local_library.rs::AUDIO_EXTENSIONS`）。 */
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "application/octet-stream"))
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            startActivityForResult(invoke, intent, "onPickAudio")
        } catch (err: Exception) {
            // 有些机型没有可处理 ACTION_OPEN_DOCUMENT 的应用：如实回错，不要假装「用户取消了」
            invoke.reject("打不开系统的文件选择器：${err.message}", err)
        }
    }

    /**
     * 导入用的落点目录（`<filesDir>/music`）。
     *
     * 为什么要问原生：界面上要能列出「哪些曲目是导入进来的副本」，并让用户一键清理。
     * 判断依据是**路径前缀**，而这个目录只有原生知道（`filesDir` 随包名/用户变化，
     * 前端不该猜）。同一个安装里它是稳定的，前端可以缓存。
     */
    @Command
    fun importedDir(invoke: Invoke) {
        val dir = File(activity.filesDir, "music").apply { mkdirs() }
        invoke.resolve(JSObject().apply { put("dir", dir.absolutePath) })
    }

    /** 选择器返回：拷文件可能很慢，**放到后台线程**，拷完再回调（不卡 UI）。 */
    @ActivityCallback
    fun onPickAudio(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.resolve(JSObject().apply {
                put("imported", 0)
                put("failed", 0)
                put("skipped", 0)
                put("cancelled", true)
                put("dir", "")
            })
            return
        }

        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let { uris.add(it) }
            }
        }
        data.data?.let { single -> if (uris.isEmpty()) uris.add(single) }

        thread(name = "gently-import") {
            val dir = File(activity.filesDir, "music").apply { mkdirs() }
            var imported = 0
            var failed = 0
            var skipped = 0
            for (uri in uris) {
                val name = displayName(uri) ?: "imported-${System.currentTimeMillis()}.audio"
                /* 放开 MIME 之后用户可能选到图片/文档：按核心认得的扩展名筛掉，
                    并且**如实告诉用户跳过了几个**（静默丢弃会让人以为导入失败） */
                if (!isAudioName(name)) {
                    skipped += 1
                    continue
                }
                val target = uniqueFile(dir, name)
                if (copyTo(uri, target)) imported++ else failed++
            }
            invoke.resolve(JSObject().apply {
                put("imported", imported)
                put("failed", failed)
                put("skipped", skipped)
                put("cancelled", false)
                put("dir", dir.absolutePath)
            })
        }
    }

    /**
     * 认不认得这个扩展名。
     *
     * 与核心保持**同一份名单**（`core/src/local_library.rs::AUDIO_EXTENSIONS`，12 个）：
     * 那边多认一种，这边就该跟着加——否则用户在手机上选得了，拷进来却被这里丢掉。
     */
    private fun isAudioName(name: String): Boolean {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return false
        return name.substring(dot + 1).lowercase() in AUDIO_EXTENSIONS
    }

    /** SAF 里的显示名（含扩展名）；读不到就返回 null，由调用方兜一个名字 */    private fun displayName(uri: Uri): String? = try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) cursor.getString(index) else null
                } else {
                    null
                }
            }
    } catch (err: Exception) {
        null
    }

    /** 同名文件不覆盖：`a.mp3` → `a-1.mp3`（用户可能想留两份不同版本） */
    private fun uniqueFile(dir: File, name: String): File {
        val safe = name.replace('/', '_').replace('\\', '_').trim().ifEmpty { "imported.audio" }
        val dot = safe.lastIndexOf('.')
        val base = if (dot > 0) safe.substring(0, dot) else safe
        val ext = if (dot > 0) safe.substring(dot) else ""
        var candidate = File(dir, safe)
        var index = 1
        while (candidate.exists()) {
            candidate = File(dir, "$base-$index$ext")
            index += 1
        }
        return candidate
    }

    private fun copyTo(uri: Uri, target: File): Boolean = try {
        activity.contentResolver.openInputStream(uri).use { input ->
            if (input == null) return false
            target.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
        }
        target.length() > 0
    } catch (err: Exception) {
        // 单个文件失败不影响其它文件：调用方只关心「导入了几首 / 失败几首」
        target.delete()
        false
    }

    companion object {
        /**
         * 与核心的 `AUDIO_EXTENSIONS` 一一对应（`core/src/local_library.rs`）。
         *
         * 只列这个构建真能解码的：`wma` / `ape` / `aiff` 等 symphonia 没开对应 feature，
         * 列进来只会让「导入成功但播不了」。
         */
        private val AUDIO_EXTENSIONS = setOf(
            "mp3", "flac", "m4a", "m4b", "m4r", "m4s", "mp4", "aac", "ogg", "oga", "opus", "wav",
        )
    }
}
