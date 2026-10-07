//! SQLite 访问层（ADR-0004）。
//!
//! **M0 的实现范围**：打开数据库、固定 PRAGMA、跑迁移、读写 `meta` 表。
//! ADR-0004 描述的「单写线程 + 读连接池」是为真实写入压力准备的；
//! 在业务表（M3）落地前先用一条连接 + `Mutex` 串行化即可——
//! 现在就把线程模型搭起来属于过度设计，且没有数据能验证它。
//! 迁移框架、PRAGMA 与 `user_version` 语义现在就固定下来，后续换线程模型不影响表结构。
//!
//! 注意：本模块内部统一返回 `Fallible<T>`（`Result<_, CoreError>`），
//! 这样可以直接用 `?`；信封只在命令边界生成。

mod migrations;

pub use migrations::latest_version;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension};

use crate::contract::{CoreError, Fallible};
use migrations::MIGRATIONS;

/// 数据库句柄。
pub struct Store {
    conn: Mutex<Connection>,
    schema_version: i64,
}

/// 供诊断页展示的数据库状态。
#[derive(Debug, Clone)]
pub struct StoreInfo {
    pub schema_version: i64,
    pub journal_mode: String,
    pub foreign_keys: bool,
}

impl Store {
    /// 打开（或创建）数据库并应用迁移。
    pub fn open(path: &Path) -> Fallible<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// 内存数据库：仅用于测试（迁移与查询逻辑与文件库一致）。
    pub fn open_in_memory() -> Fallible<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut conn: Connection) -> Fallible<Self> {
        apply_pragmas(&conn)?;
        let schema_version = migrations::migrate(&mut conn)?;
        tracing::info!(schema_version, migrations = MIGRATIONS.len(), "SQLite 就绪");
        Ok(Self { conn: Mutex::new(conn), schema_version })
    }

    pub fn schema_version(&self) -> i64 {
        self.schema_version
    }

    /// 读 PRAGMA 字符串（诊断用）。
    pub fn pragma_str(&self, name: &str) -> Fallible<String> {
        let conn = self.lock()?;
        let value: String = conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))?;
        Ok(value)
    }

    /// 读 PRAGMA 整数。
    pub fn pragma_int(&self, name: &str) -> Fallible<i64> {
        let conn = self.lock()?;
        let value: i64 = conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))?;
        Ok(value)
    }

    pub fn info(&self) -> Fallible<StoreInfo> {
        Ok(StoreInfo {
            schema_version: self.schema_version,
            journal_mode: self.pragma_str("journal_mode")?,
            foreign_keys: self.pragma_int("foreign_keys")? != 0,
        })
    }

    /// 写元信息（M0 唯一有实际写入语义的表，用来验证迁移与事务链路）。
    pub fn meta_set(&self, key: &str, value: &str) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO meta(key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![key, value, now_millis()],
        )?;
        Ok(())
    }

    pub fn meta_get(&self, key: &str) -> Fallible<Option<String>> {
        let conn = self.lock()?;
        let value = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0))
            .optional()?;
        Ok(value)
    }

    /// 计数查询：表还不存在时返回 0 而不是报错（诊断页需要这个容忍度）。
    pub fn count_or_zero(&self, table: &str) -> i64 {
        // 表名只来自内部常量；仍做一次字符白名单校验，避免将来被误用成注入点
        if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return 0;
        }
        let Ok(conn) = self.lock() else { return 0 };
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
    }

    fn lock(&self) -> Fallible<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| CoreError::internal("数据库连接锁已中毒（上一次写入 panic）"))
    }
}

/// PRAGMA 必须在事务外设置（`journal_mode` 尤其如此）。
fn apply_pragmas(conn: &Connection) -> Fallible<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FTS5 是 M3「本地曲库检索」的前提（契约 §11：FTS5 检索 P95 < 50ms）。
    /// `bundled` 编进来的 SQLite 是否带 FTS5 取决于编译开关，**必须提前验证**——
    /// 否则会在 M3 才发现用不了，代价高得多。
    #[test]
    fn fts5_is_available() {
        let store = Store::open_in_memory().expect("内存库");
        let conn = store.lock().expect("连接");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE track_fts USING fts5(title, artist, album, tokenize = 'unicode61');
             INSERT INTO track_fts(title, artist, album) VALUES ('夜曲', '周杰伦', '十一月的萧邦');",
        )
        .expect("bundled SQLite 应支持 FTS5");

        let hits: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH '夜曲'", [], |row| {
                row.get(0)
            })
            .expect("FTS5 查询");
        assert_eq!(hits, 1);
    }

    #[test]
    fn pragmas_are_applied() {
        let store = Store::open_in_memory().expect("内存库");
        // 内存库的 journal_mode 是 memory（文件库才是 wal），这里验证外键与 busy_timeout
        assert_ne!(store.pragma_int("foreign_keys").unwrap(), 0, "外键未开启");
        assert_eq!(store.pragma_int("busy_timeout").unwrap(), 5000);
    }
}
