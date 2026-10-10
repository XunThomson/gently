//! 存储守卫测试：验证 ADR-0004 的关键承诺（PRAGMA 生效、迁移幂等、可重开）。

use gently_core::paths::AppPaths;
use gently_core::store::{latest_version, Store};

/// 临时目录：避免引入额外依赖，测试结束自行清理。
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let unique = format!(
        "gently-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

#[test]
fn migrates_to_latest_and_sets_wal() {
    let dir = temp_dir("store-migrate");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");

    let store = Store::open(&paths.db).expect("打开数据库");
    assert_eq!(store.schema_version(), latest_version(), "应迁移到最新版本");
    assert_eq!(latest_version(), 3, "meta + plugin_state/plugin_config + subscriptions");

    let info = store.info().expect("读取信息");
    assert_eq!(info.journal_mode.to_lowercase(), "wal", "WAL 未生效");
    assert!(info.foreign_keys, "外键约束未开启");
    assert_eq!(info.schema_version, latest_version());

    // 未落地的业务表计数应为 0 而不是报错（诊断页需要这个容忍度）
    assert_eq!(store.count_or_zero("favorites"), 0);

    drop(store);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn reopening_is_idempotent() {
    let dir = temp_dir("store-reopen");
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");

    {
        let store = Store::open(&paths.db).expect("首次打开");
        store.meta_set("last_run", "first").expect("写入元信息");
    }

    // 二次打开：迁移不应重复执行，数据应保留
    let store = Store::open(&paths.db).expect("再次打开");
    assert_eq!(store.schema_version(), latest_version());
    assert_eq!(store.meta_get("last_run").unwrap().as_deref(), Some("first"));

    // upsert 语义：同一 key 覆盖而不是报错
    store.meta_set("last_run", "second").expect("覆盖元信息");
    assert_eq!(store.meta_get("last_run").unwrap().as_deref(), Some("second"));
    assert_eq!(store.meta_get("missing").unwrap(), None);

    drop(store);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn in_memory_store_works_for_fast_tests() {
    let store = Store::open_in_memory().expect("内存库");
    assert_eq!(store.schema_version(), latest_version());
    store.meta_set("k", "v").unwrap();
    assert_eq!(store.meta_get("k").unwrap().as_deref(), Some("v"));
}
