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
            type = "audio/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            startActivityForResult(invoke, intent, "onPickAudio")
        } catch (err: Exception) {
            // 有些机型没有可处理 ACTION_OPEN_DOCUMENT 的应用：如实回错，不要假装「用户取消了」
            invoke.reject("打不开系统的文件选择器：${err.message}", err)
        }
    }

    /** 选择器返回：拷文件可能很慢，**放到后台线程**，拷完再回调（不卡 UI）。 */
    @ActivityCallback
    fun onPickAudio(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.resolve(JSObject().apply {
                put("imported", 0)
                put("failed", 0)
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
            for (uri in uris) {
                val target = uniqueFile(dir, displayName(uri) ?: "imported-${System.currentTimeMillis()}.audio")
                if (copyTo(uri, target)) imported++ else failed++
            }
            invoke.resolve(JSObject().apply {
                put("imported", imported)
                put("failed", failed)
                put("cancelled", false)
                put("dir", dir.absolutePath)
            })
        }
    }

    /** SAF 里的显示名（含扩展名）；读不到就返回 null，由调用方兜一个名字 */
    private fun displayName(uri: Uri): String? = try {
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
}
