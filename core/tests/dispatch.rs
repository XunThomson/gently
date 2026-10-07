//! 分发守卫测试。
//!
//! 这里锁住三条不变量：
//! 1. **契约清单里的每个命令都被分发认识**（否则前端调用会得到 `common.not_found`，
//!    而这本该是「未实现」——两者的区别决定前端行为）；
//! 2. 未登记的名字返回 `not_found`，与「已登记未实现」的 `not_implemented` 可区分；
//! 3. system 域三个命令在 M0 就是真实实现（不是占位）。

use gently_core::commands::{dispatch, implemented_count};
use gently_core::contract::{COMMAND_NAMES, ErrorCode};
use gently_core::{AppPaths, CoreContext};
use serde_json::json;

fn ctx() -> CoreContext {
    let dir = std::env::temp_dir().join(format!("gently-dispatch-{}", std::process::id()));
    let paths = AppPaths::resolve(dir);
    paths.ensure().expect("建目录");
    CoreContext::new(paths)
}

fn code_of(value: &serde_json::Value) -> &str {
    value["error"]["code"].as_str().unwrap_or("<none>")
}

/// 契约登记的每个命令都必须被分发「认识」。
///
/// 判据是「**不返回 `common.not_found`**」——那是「命令未登记」的信号。
/// 命令用什么参数返回什么（未实现 / 参数非法）不在本测试的范围内：
/// `system.reveal` 传空参数本来就该报 `invalid_argument`。
#[test]
fn every_contract_command_is_routed() {
    let ctx = ctx();
    let mut unknown = Vec::new();

    for name in COMMAND_NAMES {
        let value = serde_json::to_value(dispatch(&ctx, name, json!({}))).unwrap();
        if code_of(&value) == ErrorCode::NotFound.as_str() {
            unknown.push(*name);
        }
    }

    assert!(unknown.is_empty(), "契约里有命令没有被分发路由：{unknown:?}");
}

#[test]
fn unregistered_command_is_not_found_not_not_implemented() {
    let ctx = ctx();
    let value = serde_json::to_value(dispatch(&ctx, "catalog.nonexistent", json!({}))).unwrap();
    assert_eq!(code_of(&value), ErrorCode::NotFound.as_str());
    assert!(value["error"]["details"]["knownCount"].is_number());
}

#[test]
fn system_status_is_really_implemented() {
    let ctx = ctx();
    let value = serde_json::to_value(dispatch(&ctx, "system.status", json!({}))).unwrap();
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["pluginRuntime"], json!("none"), "M0 尚未接入 QuickJS");
    assert_eq!(value["data"]["dbReady"], json!(false), "未打开库时应为降级状态");
    assert!(value["data"]["counts"]["favorites"].is_number());
    assert!(value["traceId"].is_string());
}

#[test]
fn system_paths_exposes_the_managed_layout() {
    let ctx = ctx();
    let value = serde_json::to_value(dispatch(&ctx, "system.paths", json!({}))).unwrap();
    for key in ["data", "cache", "plugins", "subscriptions", "skins", "downloads", "logs"] {
        assert!(value["data"][key].is_string(), "缺少 {key}");
    }
}

/// 目录白名单：前端不能借 `system.reveal` 打开任意路径。
#[test]
fn reveal_rejects_paths_outside_managed_roots() {
    let ctx = ctx();
    let outside = if cfg!(windows) { "C:/Windows/System32" } else { "/etc" };
    let value = serde_json::to_value(dispatch(&ctx, "system.reveal", json!({ "path": outside }))).unwrap();
    assert_eq!(code_of(&value), ErrorCode::InvalidArgument.as_str(), "{value}");
}

#[test]
fn reveal_reports_missing_path() {
    let ctx = ctx();
    let missing = ctx.paths.logs.join("does-not-exist");
    let value =
        serde_json::to_value(dispatch(&ctx, "system.reveal", json!({ "path": missing.to_string_lossy() })))
            .unwrap();
    assert_eq!(code_of(&value), ErrorCode::NotFound.as_str(), "{value}");
}

#[test]
fn invalid_params_are_reported_as_invalid_argument() {
    let ctx = ctx();
    let value = serde_json::to_value(dispatch(&ctx, "system.reveal", json!({ "wrong": 1 }))).unwrap();
    assert_eq!(code_of(&value), ErrorCode::InvalidArgument.as_str(), "{value}");
    assert!(value["error"]["details"]["reason"].is_string());
}

#[test]
fn implemented_count_matches_milestone_scope() {
    // M0：system 三条；M1a：插件预览 + 安装 + 列表 + 卸载 + 启停/优先级
    assert_eq!(implemented_count(), 9, "已实现命令数变了就要同步这里与 ROADMAP");
}
