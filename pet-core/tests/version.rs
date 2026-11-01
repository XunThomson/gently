//! 版本与体积：宠物包声明的兼容性必须**真的被检查**。
//!
//! 真实缺口（R106）：`minPetCoreVersion` 一直只做「非空校验」——写什么都不影响安装，
//! 那它对用户就是一句空话：包用了新核心才有的能力（`fit` / `lookRows`），装在旧核心上
//! 「看得见装上了、画出来不对」，比直接拒绝更难查。
//!
//! 这里锁四件事：
//! 1. 要求「更新的核心」的包被明确拒绝（`pet.incompatible`）；
//! 2. 要求「更旧的核心」的包正常安装；
//! 3. `version` 必须是语义化版本；
//! 4. `pet.json` 原文超过 512 KiB 被拒绝（规格也是不可信数据）。

use pet_core::dispatch;
use pet_core::{Engine, PET_CORE_VERSION};
use serde_json::json;

fn spec_with(id: &str, version: &str, minimum: &str) -> String {
    json!({
        "id": id,
        "name": "版本宠物",
        "version": version,
        "author": "tester",
        "animations": [
            {"name": "idle", "frames": 4, "frameMs": 200, "loop": true}
        ],
        "behaviors": [],
        "minPetCoreVersion": minimum
    })
    .to_string()
}

fn engine() -> (Engine, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "gently-pet-version-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let engine = Engine::open(&dir).unwrap();
    (engine, dir)
}

#[test]
fn a_package_that_needs_a_newer_core_is_rejected() {
    let (mut engine, dir) = engine();
    /* 比当前核心高一个大版本：明确不兼容 */
    let error = engine
        .install(&spec_with("pet-needs-newer", "1.0.0", "99.0.0"), 1_000)
        .expect_err("要求更新的核心时不该装进去");
    assert_eq!(error.code.as_str(), "pet.incompatible", "{}", error.message);
    assert!(error.message.contains("99.0.0"), "错误里要写清楚要求的是什么版本：{}", error.message);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_package_that_asks_for_an_older_core_installs() {
    let (mut engine, dir) = engine();
    let spec = engine
        .install(&spec_with("pet-needs-older", "1.0.0", "0.1.0"), 1_000)
        .expect("要求更旧的核心应当能装");
    assert_eq!(spec.id, "pet-needs-older");
    /* 同版本也算满足（`>=` 语义） */
    assert!(engine
        .install(&spec_with("pet-needs-same", "1.0.0", PET_CORE_VERSION), 2_000)
        .is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_package_without_a_minimum_version_still_installs() {
    let (mut engine, dir) = engine();
    /* 空字符串 = 没声明：老包一个都不能因此装不上 */
    assert!(engine.install(&spec_with("pet-no-min", "1.0.0", ""), 1_000).is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn version_must_look_like_a_semantic_version() {
    let (mut engine, dir) = engine();
    let error = engine
        .install(&spec_with("pet-bad-version", "not-a-version", ""), 1_000)
        .expect_err("乱写的 version 应当被拒绝");
    assert_eq!(error.code.as_str(), "pet.invalid_package");

    let error = engine
        .install(&spec_with("pet-bad-min", "1.0.0", "newest"), 1_000)
        .expect_err("乱写的 minPetCoreVersion 应当被拒绝");
    assert_eq!(error.code.as_str(), "pet.invalid_package");

    /* 短写（`1.0`）与带后缀（`1.0.0-rc1`）都是合法语义化版本 */
    assert!(engine.install(&spec_with("pet-short-version", "1.0", ""), 2_000).is_ok());
    assert!(engine
        .install(&spec_with("pet-pre-version", "1.0.0-rc1", "0.9"), 3_000)
        .is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_oversized_spec_is_rejected_before_parsing() {
    let (mut engine, dir) = engine();
    /* 把一个字段撑到超过 512 KiB：不必是合法 JSON——体积检查在校验之前 */
    let mut huge = spec_with("pet-huge", "1.0.0", "");
    huge.push_str(&"x".repeat(520 * 1024));
    let error = engine.install(&huge, 1_000).expect_err("超大规格应当被拒绝");
    assert_eq!(error.code.as_str(), "pet.limit_exceeded", "{}", error.message);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn state_reports_the_core_version() {
    let (mut engine, dir) = engine();
    engine.install(&spec_with("pet-state-version", "1.0.0", ""), 1_000).unwrap();
    let result = dispatch(&mut engine, "pet.state", json!({}), 2_000).unwrap();
    let value = serde_json::to_value(&result).unwrap();
    let core_version = value["coreVersion"].as_str().expect("state 要带 coreVersion");
    assert_eq!(core_version, PET_CORE_VERSION);
    std::fs::remove_dir_all(&dir).ok();
}
