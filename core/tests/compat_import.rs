//! 兼容模式接入层（ADR-0006 待完成第 3 项）的集成测试：
//! 「头部 `@compat`」与「导入参数 `compat: true`」两条入口，以及没有头部时从 `module.exports`
//! 合成清单的规则。
//!
//! 重点：
//! 1. **默认关闭**——没有头部元数据、又没开兼容模式时，错误必须告诉用户「怎么办」；
//! 2. **合出来的清单要稳**——id 由 platform 派生（升级不换 id）、版本非法降级为 0.0.0、
//!    权限一定含 network、能力以运行时探测为准；
//! 3. **预览仍然只读**——合成清单要执行插件顶层代码，但不能落盘；
//! 4. **安装后真的能用**——按合成清单落盘、入库、并能在沙箱里被调用。

use gently_core::commands::dispatch;
use gently_core::contract::ErrorCode;
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// MusicFree 风格：**没有头部注释**，元数据与能力都在 `module.exports` 上。
const MUSICFREE: &str = r#"
"use strict";
const CryptoJS = require("crypto-js");
module.exports = {
    platform: "示例兼容源",
    version: "1.2.3",
    author: "someone",
    description: "仅用于测试",
    srcUrl: "https://example.com/plugin.js",
    async search(query, page, type) {
        return {isEnd: true, data: [{id: '1', title: '夜曲', artist: '周杰伦', duration: 226}]};
    },
    async getMediaSource(musicItem, quality) {
        return {url: 'https://cdn.example.com/' + musicItem.id + '.m4a', headers: {}};
    },
    sign: CryptoJS.MD5("abc").toString(),
    async getLyric(musicItem) { return {rawLrc: "[00:01.00]测试"}; },
};
"#;

/// 顶层就发请求的插件：探测期必然被拒（白名单为空），错误要能解释原因。
const EAGER_NETWORK: &str = r#"
module.exports = {
    platform: "顶层请求",
    version: "0.0.1",
    async search() { return {isEnd: true, data: []}; },
    extra: fetch("https://api.example.com/x").then(() => "done"),
};
"#;

fn temp_ctx(tag: &str) -> (CoreContext, std::path::PathBuf) {
    let dir = common::temp_dir(&format!("compat-{tag}"));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");
    let store = Store::open(&paths.db).expect("打开库");
    (CoreContext::new(paths).with_store(store), dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn preview(ctx: &CoreContext, content: &str, compat: bool) -> Value {
    call(
        ctx,
        "plugin.preview",
        json!({ "from": { "kind": "paste", "content": content }, "compat": compat }),
    )
}

fn import(ctx: &CoreContext, content: &str, compat: bool) -> Value {
    call(
        ctx,
        "plugin.import",
        json!({ "from": { "kind": "paste", "content": content }, "consent": true, "compat": compat }),
    )
}

#[test]
fn headerless_plugin_needs_the_explicit_compat_switch() {
    let (ctx, dir) = temp_ctx("needs-switch");

    // 默认关闭：报「缺少必填字段」，并给出可执行的下一步
    let denied = preview(&ctx, MUSICFREE, false);
    assert_eq!(denied["error"]["code"], ErrorCode::PluginInvalidSource.as_str(), "{denied}");
    assert!(
        denied["error"]["message"].as_str().unwrap().contains("兼容模式"),
        "错误要说清怎么办：{denied}"
    );
    // 缺字段的细节仍在（界面据此定位）
    let missing = denied["error"]["details"]["missing"].as_array().unwrap();
    assert!(missing.contains(&json!("id")));

    // 开了兼容模式 → 合成清单，且**不落盘**
    let ok = preview(&ctx, MUSICFREE, true);
    assert_eq!(ok["ok"], json!(true), "{ok}");
    assert_eq!(ok["data"]["compat"], json!(true));
    assert_eq!(ok["data"]["manifest"]["name"], json!("示例兼容源"));
    assert_eq!(ok["data"]["manifest"]["version"], json!("1.2.3"));
    assert_eq!(ok["data"]["manifest"]["author"], json!("someone"));
    assert_eq!(ok["data"]["manifest"]["description"], json!("仅用于测试"));
    // srcUrl 当作主页记录（我们不自动更新，只展示）
    assert_eq!(ok["data"]["manifest"]["homepage"], json!("https://example.com/plugin.js"));
    // 兼容模式必然出网；hosts 留空（白名单正是兼容模式放弃的东西）
    assert_eq!(ok["data"]["permissions"], json!(["network"]));
    assert_eq!(ok["data"]["manifest"]["hosts"], json!([]));

    let entries: Vec<_> = std::fs::read_dir(&ctx.paths.plugins).unwrap().collect();
    assert!(entries.is_empty(), "预览不应写入任何文件");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn synthesized_manifest_is_stable_and_detects_real_capabilities() {
    let (ctx, dir) = temp_ctx("synthesize");

    let first = preview(&ctx, MUSICFREE, true);
    let id = first["data"]["manifest"]["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("compat-"), "合出来的 id 要有可识别前缀：{id}");
    assert_eq!(id.len(), "compat-".len() + 8);

    // 同一插件改了内容（版本升级）：id 必须不变，否则升级会变成「又装了一个插件」
    let upgraded = MUSICFREE.replace("\"1.2.3\"", "\"1.3.0\"");
    let second = preview(&ctx, &upgraded, true);
    assert_eq!(second["data"]["manifest"]["id"], json!(id));

    // 能力来自**运行时探测**：箭头函数/导出对象里的写法静态扫描认不全
    let capabilities = first["data"]["manifest"]["capabilities"].as_array().unwrap();
    for expected in ["search", "getMediaSource", "getLyric"] {
        assert!(capabilities.contains(&json!(expected)), "缺 {expected}：{capabilities:?}");
    }

    // 警告里必须有一句「权限弱于自有 ABI」——界面另有专门提示位，但数据侧也要说清
    let warnings = first["data"]["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning.as_str().unwrap().contains("权限弱于自有 ABI")),
        "{warnings:?}"
    );
    // 音质没声明（MusicFree 没有这个字段）→ 按 standard 并说明
    assert_eq!(first["data"]["manifest"]["qualities"], json!(["standard"]));
    assert!(warnings.iter().any(|warning| warning.as_str().unwrap().contains("standard")));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn non_semver_version_falls_back_to_zero() {
    let (ctx, dir) = temp_ctx("version");
    let source = MUSICFREE.replace("\"1.2.3\"", "\"1.2\"");
    let value = preview(&ctx, &source, true);
    assert_eq!(value["data"]["manifest"]["version"], json!("0.0.0"), "{value}");
    let warnings = value["data"]["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning.as_str().unwrap().contains("不是语义化版本")),
        "{warnings:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn eager_network_in_probe_is_explained() {
    let (ctx, dir) = temp_ctx("eager");
    let value = preview(&ctx, EAGER_NETWORK, true);
    assert_eq!(value["ok"], json!(false), "{value}");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("探测期不能出网") || message.contains("顶层"),
        "要解释为什么探测失败：{message}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn compat_plugin_installs_and_runs_from_the_synthesized_manifest() {
    let (ctx, dir) = temp_ctx("install");

    let result = import(&ctx, MUSICFREE, true);
    assert_eq!(result["ok"], json!(true), "{result}");
    let id = result["data"]["plugin"]["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("compat-"));
    // 摘要里带 compat：界面据此打标记（不能把兼容插件呈现为同等安全）
    assert_eq!(result["data"]["plugin"]["compat"], json!(true));

    // 入库 + 列表可见
    let listed = call(&ctx, "plugin.list", json!({}));
    assert_eq!(listed["data"][0]["id"], json!(id));
    assert_eq!(listed["data"][0]["compat"], json!(true));

    // 安装只落盘；reload 建运行时并真实探测能力（require 垫片也要能用）
    let reloaded = call(&ctx, "plugin.reload", json!({ "id": id }));
    assert_eq!(reloaded["ok"], json!(true), "{reloaded}");
    let capabilities = reloaded["data"]["manifest"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("search")), "{capabilities:?}");

    // 覆盖安装同一插件：按 platform 派生的 id 不变 → 是替换而不是新增
    let again = import(&ctx, MUSICFREE, true);
    assert_eq!(again["data"]["plugin"]["id"], json!(id));
    assert_eq!(again["data"]["replaced"], json!(true));
    assert_eq!(call(&ctx, "plugin.list", json!({}))["data"].as_array().unwrap().len(), 1);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn user_variables_become_credential_fields() {
    // MusicFree 的 `module.exports.userVariables` 就是「插件要向用户索取哪些变量」。
    // 我们把它当凭据声明：预览界面据此列出字段，用户填完后插件用 env.getUserVariables() 读到。
    let (ctx, dir) = temp_ctx("vars");
    let source = r#"
module.exports = {
    platform: "变量兼容源",
    version: "1.0.0",
    userVariables: [
        {key: "cookie", label: "Cookie", required: true},
        {key: "token"},
        {label: "没有 key 的条目会被忽略"},
    ],
    async search() { return {isEnd: true, data: []}; },
    async getMediaSource() { return null; },
};
"#;

    let value = preview(&ctx, source, true);
    assert_eq!(value["ok"], json!(true), "{value}");

    let credentials = value["data"]["credentials"].as_array().unwrap();
    assert_eq!(credentials.len(), 2, "只保留有 key 的条目：{credentials:?}");
    assert_eq!(credentials[0]["key"], json!("cookie"));
    assert_eq!(credentials[0]["label"], json!("Cookie"));
    assert_eq!(credentials[0]["required"], json!(true));
    assert_eq!(credentials[1]["key"], json!("token"));
    assert_eq!(credentials[1]["label"], json!("token"), "缺 label 时退回 key");

    // 声明了变量 → 必须同时给出凭据权限（否则用户填了也读不到）
    let permissions = value["data"]["permissions"].as_array().unwrap();
    assert!(permissions.contains(&json!("credentials")), "{permissions:?}");
    let warnings = value["data"]["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning.as_str().unwrap().contains("用户变量")),
        "要提示「需要在插件页填写」：{warnings:?}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn directory_package_can_be_forced_into_compat_mode() {
    let (ctx, dir) = temp_ctx("dir-compat");
    let package = ctx.paths.data.join("pkg");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("plugin.json"),
        r#"{"id":"dir-source","name":"目录包","version":"1.0.0","author":"someone","entry":"main.js"}"#,
    )
    .unwrap();
    std::fs::write(package.join("main.js"), "module.exports = {async search() { return []; }};\n")
        .unwrap();

    // 目录包清单是完整的，但用户显式选了兼容模式 → 记录兼容 + 推导出 network
    let value = call(
        &ctx,
        "plugin.preview",
        json!({ "from": { "kind": "dir", "path": package.to_string_lossy() }, "compat": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["compat"], json!(true));
    assert_eq!(value["data"]["permissions"], json!(["network"]));
    let warnings = value["data"]["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning.as_str().unwrap().contains("@compat")),
        "要说明「源码里没有 @compat，是按你的选择开启的」：{warnings:?}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn headerless_plain_script_still_installs_but_says_what_it_lost() {
    // 没有元数据、也没有 module.exports（就是一段裸脚本）：
    // 能力探测仍然有效，但身份只能来自内容摘要——必须把代价说清楚，而不是拒绝
    let (ctx, dir) = temp_ctx("bare");
    let source =
        "async function search() { return []; }\nasync function getMediaSource() { return null; }\n";
    let value = preview(&ctx, source, true);

    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["manifest"]["name"], json!("未命名兼容插件"));
    assert_eq!(value["data"]["manifest"]["author"], json!("未声明"));
    let id = value["data"]["manifest"]["id"].as_str().unwrap();
    assert!(id.starts_with("compat-"));
    let warnings = value["data"]["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("更新插件会被视为另一个插件")),
        "{warnings:?}"
    );
    let capabilities = value["data"]["manifest"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("search")), "{capabilities:?}");

    std::fs::remove_dir_all(&dir).ok();
}
