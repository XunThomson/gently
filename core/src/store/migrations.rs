//! 迁移：`user_version` + 编号 SQL，**前向不可逆**（ADR-0004）。
//!
//! 每个迁移在单个事务里执行，成功后写入 `user_version`；
//! 失败会回滚该迁移并中断启动，避免出现「一半新一半旧」的库。

use rusqlite::Connection;

pub struct Migration {
    pub name: &'static str,
    pub sql: &'static str,
}

/// 迁移列表：**只追加，不修改历史条目**（已发布的迁移改了会让老库对不上）。
pub const MIGRATIONS: &[Migration] = &[
    Migration { name: "0001_init", sql: include_str!("migrations/0001_init.sql") },
    Migration { name: "0002_plugin_state", sql: include_str!("migrations/0002_plugin_state.sql") },
    Migration { name: "0003_subscriptions", sql: include_str!("migrations/0003_subscriptions.sql") },
    Migration { name: "0004_library", sql: include_str!("migrations/0004_library.sql") },
    Migration { name: "0005_local_tracks", sql: include_str!("migrations/0005_local_tracks.sql") },
    Migration { name: "0006_downloads", sql: include_str!("migrations/0006_downloads.sql") },
    Migration { name: "0007_skins", sql: include_str!("migrations/0007_skins.sql") },
    Migration {
        name: "0008_recommend_feedback",
        sql: include_str!("migrations/0008_recommend_feedback.sql"),
    },
];

/// 顺序应用未执行的迁移，返回最终的 `user_version`。
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<i64> {
    let mut version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let target = index as i64 + 1;
        if target <= version {
            continue;
        }

        tracing::info!(migration = migration.name, from = version, to = target, "应用迁移");
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        // user_version 是数据库头字段，但在事务内写入会随事务一起提交/回滚
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()?;
        version = target;
    }

    Ok(version)
}

/// 当前迁移数（= 最新 schema 版本），供文档与守卫测试使用。
pub const fn latest_version() -> i64 {
    MIGRATIONS.len() as i64
}
