//! 插件**压缩包**导入的集成测试（契约 `ImportSource{kind:'archive'}`）。
//!
//! 压缩包是不可信输入，因此这里锁定四件事：
//! 1. 三种合法包形（单文件 / 目录包 / 多套一层目录）都能装成同一种落盘布局；
//! 2. **路径穿越被拒**（`../evil.js` 不得写到插件目录之外）；
//! 3. **zip bomb 被拒**（解压后超过体积上限）；
//! 4. 内容不明确的包（多个 `.js`、既无清单也无脚本）给出可执行的错误，而不是含糊失败。

use std::io::Write;
use std::path::{Path, PathBuf};

use gently_core::commands::dispatch;
use gently_core::contract::ErrorCode;
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};
use zip::write::FileOptions;

mod common;

const SINGLE: &str = r#"
// @id archive-single
// @name 压缩包单文件
// @version 1.0.0
// @author someone
// @qualities standard
// @hosts api.example.com
async function search(keyword, page) { return []; }
async function getMediaSource(track, quality) { return null; }
"#;

const DIR_MANIFEST: &str = r#"{ "id": "archive-dir", "name": "压缩包目录包", "version": "2.0.0",
  "author": "someone", "entry": "index.js", "qualities": ["standard"], "hosts": ["api.example.com"] }"#;

const DIR_ENTRY: &str = "async function search(k, p) { return []; }\nasync function getMediaSource(t, q) { return null; }\n";

fn temp_ctx(tag: &str) -> (CoreContext, PathBuf) {
    let dir = common::temp_dir(&format!("archive-{tag}"));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");
    let store = Store::open(&paths.db).expect("打开库");
    (CoreContext::new(paths).with_store(store), dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

/// 写一个 zip：`entries` 是 `(包内相对路径, 内容)`；`declared_size` 可伪装条目大小（zip bomb 测试）。
fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).expect("建压缩包");
    let mut writer = zip::ZipWriter::new(file);
    let options = FileOptions::default();
    for (name, content) in entries {
        writer.start_file(*name, options).expect("写条目");
        writer.write_all(content).expect("写内容");
    }
    writer.finish().expect("收尾");
}

fn import_archive(ctx: &CoreContext, archive: &Path) -> Value {
    call(
        ctx,
        "plugin.import",
        json!({
            "from": { "kind": "archive", "path": archive.to_string_lossy() },
            "consent": true,
        }),
    )
}

#[test]
fn installs_single_file_archive_as_plugin_js() {
    let (ctx, dir) = temp_ctx("single");
    let archive = dir.join("plugin.zip");
    write_zip(&archive, &[("demo.js", SINGLE.as_bytes())]);

    // 预览：只读，不得留下插件目录
    let preview = call(
        &ctx,
        "plugin.preview",
        json!({ "from": { "kind": "archive", "path": archive.to_string_lossy() } }),
    );
    assert_eq!(preview["ok"], true, "{preview}");
    assert_eq!(preview["data"]["manifest"]["id"], "archive-single");
    assert!(!ctx.paths.plugins.join("archive-single").exists(), "预览不得落盘");

    let installed = import_archive(&ctx, &archive);
    assert_eq!(installed["ok"], true, "{installed}");
    // 单文件形态归一化：安装目录里只有 plugin.js
    let target = ctx.paths.plugins.join("archive-single");
    assert!(target.join("plugin.js").is_file());
    assert_eq!(
        std::fs::read_to_string(target.join("plugin.js")).unwrap().trim(),
        SINGLE.trim()
    );
    // 来源记为 archive（用于审计与更新判断）
    assert_eq!(installed["data"]["plugin"]["origin"]["kind"], "archive");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn installs_directory_archive_and_flattens_extra_folder() {
    let (ctx, dir) = temp_ctx("dir");
    let archive = dir.join("pkg.zip");
    // 常见打包方式：外面多一层目录
    write_zip(
        &archive,
        &[
            ("my-plugin/plugin.json", DIR_MANIFEST.as_bytes()),
            ("my-plugin/index.js", DIR_ENTRY.as_bytes()),
            ("my-plugin/README.md", b"docs"),
        ],
    );

    let installed = import_archive(&ctx, &archive);
    assert_eq!(installed["ok"], true, "{installed}");
    let target = ctx.paths.plugins.join("archive-dir");
    assert!(target.join("plugin.json").is_file(), "清单应落在根");
    assert!(target.join("index.js").is_file(), "entry 应保留");
    assert!(target.join("README.md").is_file(), "目录包保留其它资源");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rejects_path_traversal_entries() {
    let (ctx, dir) = temp_ctx("slip");
    let archive = dir.join("evil.zip");
    write_zip(&archive, &[("../evil.js", SINGLE.as_bytes())]);

    let value = import_archive(&ctx, &archive);
    assert_eq!(value["error"]["code"], ErrorCode::PluginInvalidSource.as_str(), "{value}");
    assert!(!dir.join("evil.js").exists(), "不得写到插件目录之外");
    assert!(call(&ctx, "plugin.list", json!({}))["data"].as_array().unwrap().is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rejects_zip_bomb_by_total_size() {
    let (ctx, dir) = temp_ctx("bomb");
    let archive = dir.join("bomb.zip");
    // 9 MiB 的零字节：压缩后很小，解压后超过 8 MiB 上限
    let big = vec![0u8; 9 * 1024 * 1024];
    write_zip(&archive, &[("plugin.js", &big)]);

    let value = import_archive(&ctx, &archive);
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");
    assert!(value["error"]["message"].as_str().unwrap().contains("上限"));
    // 失败不留半成品
    let leftovers: Vec<_> = std::fs::read_dir(&ctx.paths.plugins)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(".staging"))
        .collect();
    assert!(leftovers.is_empty(), "暂存目录应被清理");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reports_ambiguous_and_empty_archives() {
    let (ctx, dir) = temp_ctx("ambiguous");

    let two_js = dir.join("two.zip");
    write_zip(&two_js, &[("a.js", b"// a"), ("b.js", b"// b")]);
    let value = import_archive(&ctx, &two_js);
    assert_eq!(value["error"]["code"], ErrorCode::PluginInvalidSource.as_str(), "{value}");
    let candidates = value["error"]["details"]["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 2, "应列出候选入口：{value}");

    let empty = dir.join("empty.zip");
    write_zip(&empty, &[("notes.txt", b"nothing here")]);
    let value = import_archive(&ctx, &empty);
    assert_eq!(value["error"]["code"], ErrorCode::PluginInvalidSource.as_str(), "{value}");

    let _ = std::fs::remove_dir_all(&dir);
}
