//! 数据目录：解析优先级与迁移（R87）。
//!
//! 这些断言锁的是**用户能不能把数据放到自己想要的位置**，以及搬家的过程会不会
//! 把原有数据弄坏——都属于「数据安全」范畴，因此每条都要有测试。

mod common;

use std::path::Path;

use gently_core::paths::{
    clear_data_location, migrate_data_dir, read_data_location, resolve_data_paths,
    write_data_location, AppPaths, DataDirSource, DATA_LOCATION_FILE, PORTABLE_MARKER,
};

#[test]
fn default_root_is_the_injected_base() {
    let base = common::temp_dir("datadir-default");
    let (paths, source) = resolve_data_paths(&base, None, None);
    assert_eq!(source, DataDirSource::Default);
    assert_eq!(paths.data, base);
    assert!(!paths.meta.portable);
    assert_eq!(paths.meta.pointer_home, base);
}

#[test]
fn portable_marker_moves_data_next_to_the_exe() {
    let base = common::temp_dir("datadir-portable-base");
    let exe_dir = common::temp_dir("datadir-portable-exe");
    std::fs::write(exe_dir.join(PORTABLE_MARKER), b"portable").unwrap();

    let (paths, source) = resolve_data_paths(&base, Some(&exe_dir), None);
    assert_eq!(source, DataDirSource::Portable);
    assert_eq!(paths.data, exe_dir.join("data"));
    // 便携版的指针也放在 exe 同目录：不往 %APPDATA% 里留东西
    assert_eq!(paths.meta.pointer_home, exe_dir);
    assert!(paths.meta.portable);
}

#[test]
fn pointer_file_wins_over_portable_and_default() {
    let base = common::temp_dir("datadir-pointer-base");
    let target = common::temp_dir("datadir-pointer-target");
    write_data_location(&base, &target).unwrap();
    assert!(base.join(DATA_LOCATION_FILE).is_file());
    assert_eq!(read_data_location(&base), Some(target.clone()));

    let (paths, source) = resolve_data_paths(&base, None, None);
    assert_eq!(source, DataDirSource::Pointer);
    assert_eq!(paths.data, target);
    // 指针目录仍然是默认位置：用户回到默认目录时改的就是这个目录
    assert_eq!(paths.meta.default_base, base);
}

#[test]
fn env_override_wins_over_everything() {
    let base = common::temp_dir("datadir-env-base");
    let target = common::temp_dir("datadir-env-target");
    let other = common::temp_dir("datadir-env-other");
    write_data_location(&base, &other).unwrap();

    let (paths, source) = resolve_data_paths(&base, None, Some(target.to_str().unwrap()));
    assert_eq!(source, DataDirSource::Override);
    assert_eq!(paths.data, target);

    // 空白的环境变量不算覆盖（否则一次手滑的 `set GENTLY_DATA_DIR=` 就会把数据搬到空路径）
    let (again, source_again) = resolve_data_paths(&base, None, Some("   "));
    assert_eq!(source_again, DataDirSource::Pointer);
    assert_eq!(again.data, other);
}

#[test]
fn relative_or_broken_pointer_is_ignored() {
    let base = common::temp_dir("datadir-bad-pointer");
    // 相对路径：重启后含义可能变，不能信
    std::fs::write(base.join(DATA_LOCATION_FILE), br#"{"dataDir":"relative/dir"}"#).unwrap();
    assert_eq!(read_data_location(&base), None);
    let (paths, source) = resolve_data_paths(&base, None, None);
    assert_eq!(source, DataDirSource::Default);
    assert_eq!(paths.data, base);

    // 坏 JSON 同样当「没有指针」
    std::fs::write(base.join(DATA_LOCATION_FILE), b"{not json").unwrap();
    assert_eq!(read_data_location(&base), None);
}

#[test]
fn clear_pointer_returns_to_default() {
    let base = common::temp_dir("datadir-clear");
    let target = common::temp_dir("datadir-clear-target");
    write_data_location(&base, &target).unwrap();
    clear_data_location(&base).unwrap();
    assert!(!base.join(DATA_LOCATION_FILE).is_file());
    // 已经清掉了再清一次也不算错误
    clear_data_location(&base).unwrap();
    let (paths, source) = resolve_data_paths(&base, None, None);
    assert_eq!(source, DataDirSource::Default);
    assert_eq!(paths.data, base);
}

#[test]
fn migration_copies_data_writes_pointer_and_skips_cache() {
    let base = common::temp_dir("datadir-migrate-base");
    let current = AppPaths::resolve(&base);
    current.ensure().unwrap();

    // 一份真实可打开的库：迁移后的自检要能通过
    let conn = rusqlite::Connection::open(&current.db).unwrap();
    conn.execute_batch("CREATE TABLE probe(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO probe(name) VALUES ('x');")
        .unwrap();
    drop(conn);

    std::fs::write(current.plugins.join("demo.js"), b"// plugin").unwrap();
    std::fs::write(current.data.join("cache-settings.json"), br#"{"limitBytes":1}"#).unwrap();
    // 缓存与日志不该被搬走（可重建 / 留在原机器更好排查）
    std::fs::write(current.cache.join("big.bin"), vec![0u8; 1024]).unwrap();
    std::fs::write(current.logs.join("gently.log"), b"log").unwrap();
    // 旁观文件也不能漏
    std::fs::write(current.data.join("gently.db-wal"), b"wal").unwrap();

    let target = common::temp_dir("datadir-migrate-target");
    let report = migrate_data_dir(&current, &target).unwrap();

    assert_eq!(report.target.replace('\\', "/"), target.to_string_lossy().replace('\\', "/"));
    assert!(report.requires_restart);
    assert!(report.copied_files >= 2, "至少要拷到 db 与插件文件");
    assert!(report.copied_bytes > 0);

    assert!(target.join("gently.db").is_file());
    assert!(target.join("plugins").join("demo.js").is_file());
    assert!(target.join("cache-settings.json").is_file());
    assert!(!target.join("cache").exists(), "缓存不该搬");
    assert!(!target.join("logs").exists(), "日志不该搬");
    assert!(!target.join("gently.db-wal").exists(), "SQLite 旁挂文件不该搬");

    // 指针写好 → 下次启动读它
    assert_eq!(read_data_location(&base), Some(target.clone()));

    // 旧数据**保留**（迁移不是破坏性操作）
    assert!(current.db.is_file());
    assert!(current.plugins.join("demo.js").is_file());
}

#[test]
fn migration_rejects_same_inside_and_relative_targets() {
    let base = common::temp_dir("datadir-reject-base");
    let current = AppPaths::resolve(&base);
    current.ensure().unwrap();

    let same = migrate_data_dir(&current, &base).unwrap_err();
    assert_eq!(same.code.as_str(), "common.invalid_argument");

    let inside = migrate_data_dir(&current, &base.join("moved")).unwrap_err();
    assert_eq!(inside.code.as_str(), "common.invalid_argument");

    // 目标若是当前目录的上级，拷贝会递归吞掉自己
    let parent = base.parent().unwrap().to_path_buf();
    let above = migrate_data_dir(&current, &parent).unwrap_err();
    assert_eq!(above.code.as_str(), "common.invalid_argument");

    let relative = migrate_data_dir(&current, Path::new("moved-data")).unwrap_err();
    assert_eq!(relative.code.as_str(), "common.invalid_argument");

    // 以上全部失败都不该留下指针
    assert_eq!(read_data_location(&base), None);
}

#[test]
fn broken_database_copy_does_not_write_pointer() {
    let base = common::temp_dir("datadir-broken-base");
    let current = AppPaths::resolve(&base);
    current.ensure().unwrap();
    // 不是 SQLite 文件的「库」：副本自检必须失败
    std::fs::write(&current.db, b"this is not a database").unwrap();

    let target = common::temp_dir("datadir-broken-target");
    let err = migrate_data_dir(&current, &target).unwrap_err();
    assert_eq!(err.code.as_str(), "library.io_error");

    // 关键：指针没写 → 下次启动仍然在原目录（用户不会「迁移失败却找不到数据」）
    assert_eq!(read_data_location(&base), None);
    // 坏副本也要清掉，别留在用户的目标目录里
    assert!(!target.join("gently.db").is_file());
}

#[test]
fn migration_survives_empty_data_dir() {
    let base = common::temp_dir("datadir-empty-base");
    let current = AppPaths::resolve(&base);
    std::fs::create_dir_all(&current.data).unwrap();

    let target = common::temp_dir("datadir-empty-target");
    let report = migrate_data_dir(&current, &target).unwrap();
    assert_eq!(report.copied_files, 0);
    assert!(read_data_location(&base).is_some());
}

/// R88 的接缝：数据目录里不只有音乐库，宠物库（独立引擎、独立文件）也在里面。
/// 旁挂文件必须**按后缀**跳过、且**每一份** `*.db` 副本都要自检。
#[test]
fn migration_verifies_every_database_copy_not_just_the_music_library() {
    let base = common::temp_dir("datadir-multi-db");
    let current = AppPaths::resolve(&base);
    current.ensure().unwrap();

    let conn = rusqlite::Connection::open(&current.db).unwrap();
    conn.execute_batch("CREATE TABLE probe(id INTEGER PRIMARY KEY);").unwrap();
    drop(conn);

    let pet_dir = current.data.join("pet");
    std::fs::create_dir_all(&pet_dir).unwrap();
    let pet_db = pet_dir.join("pet.db");
    let conn = rusqlite::Connection::open(&pet_db).unwrap();
    conn.execute_batch("CREATE TABLE pets(id TEXT PRIMARY KEY, affection INTEGER);")
        .unwrap();
    drop(conn);
    // 旁挂文件：不能只认音乐库那几个名字，否则宠物库的 -wal/-shm 会被热拷过去
    std::fs::write(pet_dir.join("pet.db-wal"), b"stale-wal").unwrap();
    std::fs::write(pet_dir.join("pet.db-shm"), b"stale-shm").unwrap();

    let target = common::temp_dir("datadir-multi-db-target");
    migrate_data_dir(&current, &target).unwrap();

    assert!(target.join("pet").join("pet.db").is_file(), "宠物库必须一起迁移");
    assert!(!target.join("pet").join("pet.db-wal").exists(), "宠物库的 -wal 也要跳过");
    assert!(!target.join("pet").join("pet.db-shm").exists(), "宠物库的 -shm 也要跳过");

    let copied = rusqlite::Connection::open_with_flags(
        target.join("pet").join("pet.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let tables: i64 = copied
        .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table'", [], |row| row.get(0))
        .unwrap();
    assert!(tables >= 1, "宠物库副本应当能打开并读到表");
    drop(copied);

    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&target).ok();
}

/// 宠物库坏了必须**阻断**迁移：只查音乐库的实现会让这次迁移「成功」，然后宠物数据就没了。
#[test]
fn a_broken_pet_database_blocks_the_migration() {
    let base = common::temp_dir("datadir-broken-pet");
    let current = AppPaths::resolve(&base);
    current.ensure().unwrap();
    let conn = rusqlite::Connection::open(&current.db).unwrap();
    conn.execute_batch("CREATE TABLE probe(id INTEGER PRIMARY KEY);").unwrap();
    drop(conn);
    let pet_dir = current.data.join("pet");
    std::fs::create_dir_all(&pet_dir).unwrap();
    std::fs::write(pet_dir.join("pet.db"), b"not a database").unwrap();

    let target = common::temp_dir("datadir-broken-pet-target");
    let err = migrate_data_dir(&current, &target).unwrap_err();
    assert_eq!(err.code.as_str(), "library.io_error");
    assert!(err.message.contains("pet.db"), "错误要指出是哪份副本坏了：{}", err.message);
    assert_eq!(read_data_location(&base), None, "坏副本不能写指针");

    std::fs::remove_dir_all(&base).ok();
}
