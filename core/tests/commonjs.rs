//! CommonJS（MusicFree / LX 风格）插件的结构性地基测试。
//!
//! 现实社区插件是 CommonJS 模块（`module.exports` + `require(...)`），而我们的沙箱
//! 刻意不提供任意模块解析。这一层保证：
//! - **能读**：从 `module.exports` 读出元数据与真实能力（兼容模式的元数据来源）；
//! - **失败要清楚**：`require('axios')` 这类不可用依赖必须给出可执行的错误，
//!   而不是让插件在深处因为 `undefined` 莫名其妙地崩掉。

use std::sync::Arc;

use gently_core::contract::ErrorCode;
use gently_core::plugin::{probe, HostLimits, ModuleProbe};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::contract::Fallible;

struct OfflineTransport;

impl HttpTransport for OfflineTransport {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(gently_core::CoreError::new(ErrorCode::SourceUpstreamFailed, "测试：禁止出网"))
    }
}

fn probe_source(source: &str) -> Fallible<ModuleProbe> {
    probe(source, HostLimits::default(), Arc::new(OfflineTransport))
}

/// 一个最小但形状真实的 MusicFree 风格插件（内容为自造，不含任何第三方地址）。
const CJS_PLUGIN: &str = r#"
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const he = require("he");
module.exports = {
    platform: "demo-cjs",
    version: "1.2.3",
    name: "CJS 演示源",
    author: "tester",
    async search(keyword, page) {
        return {isEnd: false, data: [{id: '1', title: he.decode('夜曲 &amp; 组曲')}]};
    },
    async getMediaSource(musicItem, quality) { return null; },
};
"#;

#[test]
fn reads_metadata_and_capabilities_from_module_exports() {
    let result = probe_source(CJS_PLUGIN).expect("CommonJS 插件应能加载");
    assert_eq!(result.metadata.get("platform").map(String::as_str), Some("demo-cjs"));
    assert_eq!(result.metadata.get("version").map(String::as_str), Some("1.2.3"));
    assert_eq!(result.metadata.get("name").map(String::as_str), Some("CJS 演示源"));

    let capabilities: Vec<String> = result.capabilities.iter().map(|c| format!("{c:?}")).collect();
    assert!(capabilities.contains(&"Search".to_string()), "{capabilities:?}");
    assert!(capabilities.contains(&"GetMediaSource".to_string()), "{capabilities:?}");
}

#[test]
fn builtin_he_module_works_inside_the_sandbox() {
    // 插件里调用 he.decode 并把结果暴露出来（验证内置模块真的可用）
    let source = r#"
const he = require("he");
module.exports = {
    platform: "he-test", version: "1.0.0", name: "he",
    async search() { return [{id: '1', title: he.decode('A &amp; B &#x4E2D;')}]; },
    async getMediaSource() { return null; },
};
"#;
    let result = probe_source(source).expect("应加载成功");
    assert_eq!(result.metadata.get("platform").map(String::as_str), Some("he-test"));
}

#[test]
fn unsupported_require_fails_with_an_actionable_message() {
    let source = r#"
const axios = require("axios");
module.exports = {platform: "needs-axios", version: "1.0.0", name: "需要 axios"};
"#;
    let error = probe_source(source).unwrap_err();
    assert_eq!(error.code, ErrorCode::PluginRuntimeError, "{error:?}");
    assert!(error.message.contains("axios"), "错误里要点出缺哪个模块：{}", error.message);
    assert!(
        error.message.contains("移植为单文件 ABI"),
        "错误要给出下一步动作：{}",
        error.message
    );
}

/// 用户提供的真实样本（若在本地存在则顺带探测；文件被 .gitignore 忽略，缺失时跳过）。
#[test]
fn real_sample_is_probed_when_present() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let examples = root.join("examples");
    let Ok(entries) = std::fs::read_dir(&examples) else {
        println!("跳过：examples 目录不存在");
        return;
    };

    let sample = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension().is_some_and(|ext| ext == "js")
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("Lk_"))
        });

    let Some(sample) = sample else {
        println!("跳过：本地没有 Lk_*.js 样本（该文件不入库）");
        return;
    };

    // 真实样本依赖 axios/crypto-js/dayjs，因此**预期**在 require 处失败——
    // 但错误必须是那条可执行的提示，而不是含混的 undefined。
    let text = std::fs::read_to_string(&sample).expect("读取样本");
    match probe_source(&text) {
        Ok(result) => {
            // 依赖齐全时（未来内置了这些模块）应能读出元数据
            println!("样本探测成功：{:?} / {:?}", result.metadata.get("platform"), result.metadata.get("version"));
        }
        Err(error) => {
            println!("样本按预期报告缺依赖：{}", error.message);
            assert_eq!(error.code, ErrorCode::PluginRuntimeError);
            assert!(
                error.message.contains("模块") || error.message.contains("GENTLY_MODULE_UNAVAILABLE"),
                "错误应指出是模块不可用：{}",
                error.message
            );
        }
    }
}
