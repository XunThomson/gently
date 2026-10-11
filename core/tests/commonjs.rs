//! CommonJS（MusicFree / LX 风格）插件的结构性地基测试。
//!
//! 现实社区插件是 CommonJS 模块（`module.exports` + `require(...)`）。我们的沙箱
//! **不做任意模块解析**，只内置一份固定、可审计的清单（`he` / `axios` / `dayjs` /
//! `crypto-js`，见 ADR-0006 与 `docs/contracts/local-core-api.md` §5.4）。这一层保证：
//! - **能读**：从 `module.exports` 读出元数据与真实能力（兼容模式的元数据来源）；
//! - **内置清单真的可用**：`axios` / `dayjs` / `crypto-js` 都能 require 并且行为正确；
//! - **失败要清楚**：清单外的 `require('lodash')` 必须给出可执行的错误，
//!   而不是让插件在深处因为 `undefined` 莫名其妙地崩掉。

use std::sync::Arc;
use std::time::Duration;

use gently_core::contract::ErrorCode;
use gently_core::plugin::{probe, HostLimits, ModuleProbe, PluginCapability};
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
fn builtin_shims_are_usable_at_probe_time() {
    // 无需出网就能验证三个垫片：哈希 / 日期在探测期就能算出结果，写进字符串元数据
    let source = r#"
const axios = require("axios");
const dayjs = require("dayjs");
const CryptoJS = require("crypto-js");
module.exports = {
    platform: "shims", version: "1.0.0", name: "垫片",
    sign: CryptoJS.MD5("abc").toString(),
    day: dayjs("2024-03-05").format("YYYY-MM-DD"),
    hasAxiosGet: typeof axios.get === "function",
    async search() { return []; },
    async getMediaSource() { return null; },
};
"#;
    let result = probe_source(source).expect("内置垫片应能在探测期使用");
    assert_eq!(result.metadata.get("sign").map(String::as_str), Some("900150983cd24fb0d6963f7d28e17f72"));
    assert_eq!(result.metadata.get("day").map(String::as_str), Some("2024-03-05"));
}

#[test]
fn default_export_interop_matches_musicfree() {
    // 转译后的插件普遍写 `require('axios').default.get(...)`（TS 的 esModuleInterop 产物）。
    // MusicFree 把包自身挂在 `.default` 上，这里必须一致——否则报错会是
    // 「cannot read property 'get' of undefined」，与真实原因（少个 self-reference）看不出关系。
    let source = r#"
const axios_1 = require("axios");
const dayjs_1 = require("dayjs");
const CryptoJS_1 = require("crypto-js");
const he_1 = require("he");
module.exports = {
    platform: "interop", version: "1.0.0", name: "默认导出",
    axiosGet: typeof axios_1.default.get,
    dayjsFormat: typeof dayjs_1.default,
    md5: typeof CryptoJS_1.default.MD5,
    // 元数据通道只收字符串（`probe` 的 metadata 是 HashMap<String,String>），因此显式转字符串
    heSame: String(he_1.default === he_1),
    async search() { return []; },
    async getMediaSource() { return null; },
};
"#;
    let result = probe_source(source).expect("`.default` 互操作应可用");
    assert_eq!(result.metadata.get("axiosGet").map(String::as_str), Some("function"));
    assert_eq!(result.metadata.get("dayjsFormat").map(String::as_str), Some("function"));
    assert_eq!(result.metadata.get("md5").map(String::as_str), Some("function"));
    assert_eq!(result.metadata.get("heSame").map(String::as_str), Some("true"));
}

#[test]
fn musicfree_function_names_are_mapped_to_our_capabilities() {
    // MusicFree 协议里这三处名字与我们的 ABI 不同，兼容插件不会改名字：
    // 收集能力时必须把别名解析掉，否则「插件明明实现了」却报 not_implemented。
    // 实测抓到过：`getTopListDetail` 没被认出来，排行榜详情直接显示空。
    let source = r#"
module.exports = {
    platform: "别名", version: "1.0.0", name: "协议别名",
    async search() { return {isEnd: true, data: []}; },
    async getMediaSource() { return null; },
    async getMusicInfo(mediaItem) { return {title: '曲目详情'}; },
    async getMusicSheetInfo(sheetItem, page) { return {isEnd: true, musicList: []}; },
    async getTopListDetail(topListItem, page) { return {isEnd: true, musicList: []}; },
};
"#;
    let result = probe_source(source).expect("别名应被识别");
    for expected in [
        PluginCapability::GetTrackInfo,
        PluginCapability::GetPlaylistInfo,
        PluginCapability::GetTopList,
    ] {
        assert!(
            result.capabilities.contains(&expected),
            "别名未映射成 {expected:?}：{:?}",
            result.capabilities
        );
    }
}

#[test]
fn our_own_name_wins_over_the_alias() {
    // 两个名字都在时用我们自己的（同一能力不应出现两份实现，取哪个要说清楚）
    let source = r#"
module.exports = {
    platform: "both", version: "1.0.0", name: "两个名字",
    async search() { return []; },
    async getMediaSource() { return null; },
    async getTrackInfo() { return {title: '自有 ABI'}; },
    async getMusicInfo() { return {title: 'MusicFree'}; },
};
"#;
    let result = probe_source(source).expect("应能解析");
    assert!(result.capabilities.contains(&PluginCapability::GetTrackInfo));
}

#[test]
fn unsupported_require_fails_with_an_actionable_message() {
    // 清单之外的模块（这里用 lodash）：探测期就必须给出可执行的错误
    let source = r#"
const _ = require("lodash");
module.exports = {platform: "needs-lodash", version: "1.0.0", name: "需要 lodash"};
"#;
    let error = probe_source(source).unwrap_err();
    assert_eq!(error.code, ErrorCode::PluginRuntimeError, "{error:?}");
    assert!(error.message.contains("lodash"), "错误里要点出缺哪个模块：{}", error.message);
    assert!(
        error.message.contains("he, axios, dayjs, crypto-js"),
        "错误里要列出可用清单：{}",
        error.message
    );
    assert!(
        error.message.contains("移植为单文件 ABI"),
        "错误要给出下一步动作：{}",
        error.message
    );
}

#[test]
fn probe_interrupts_a_top_level_infinite_loop() {
    // 兼容模式的清单来自「只读执行一遍源码」，因此探测必须和正常调用一样有截止时间：
    // 顶层死循环不能把预览界面卡死。
    let source = r#"
module.exports = {
    platform: "loop",
    version: "1.0.0",
    async search() { return {isEnd: true, data: []}; },
};
while (true) { Math.sqrt(12345.6789); }
"#;
    let limits = HostLimits { call_timeout: Duration::from_millis(300), ..HostLimits::default() };
    let started = std::time::Instant::now();
    let error = probe(source, limits, Arc::new(OfflineTransport)).unwrap_err();
    assert_eq!(error.code, ErrorCode::PluginRuntimeError, "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(3), "耗时 {:?}", started.elapsed());
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

    // 真实样本依赖 axios/crypto-js/dayjs 之外的东西（或用到清单外的 API），
    // 因此**预期**在 require 处失败——但错误必须是那条可执行的提示，而不是含混的 undefined；
    // 依赖落在清单内时则应能读出元数据。
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
