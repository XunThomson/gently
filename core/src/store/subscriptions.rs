//! 订阅持久化（`subscriptions` 表，迁移 0003）。

use rusqlite::{params, OptionalExtension, Row};

use crate::contract::Fallible;
use crate::plugin::Subscription;

use super::Store;

fn row_to_subscription(row: &Row<'_>) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: row.get("id")?,
        name: row.get("name")?,
        url: row.get("url")?,
        updated_at: row.get("updated_at")?,
        count: row.get("count")?,
        error: row.get("last_error")?,
    })
}

impl Store {
    /// 新增订阅；URL 已存在时返回既有的（幂等，避免同一仓库加两次）。
    pub fn add_subscription(&self, id: &str, name: &str, url: &str) -> Fallible<Subscription> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO subscriptions (id, name, url, count, created_at)
             VALUES (?1, ?2, ?3, 0, ?4)
             ON CONFLICT(url) DO NOTHING",
            params![id, name, url, super::now_millis()],
        )?;

        conn.query_row(
            "SELECT * FROM subscriptions WHERE url = ?1",
            [url],
            row_to_subscription,
        )
        .map_err(Into::into)
    }

    pub fn list_subscriptions(&self) -> Fallible<Vec<Subscription>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT * FROM subscriptions ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], row_to_subscription)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_subscription(&self, id: &str) -> Fallible<Option<Subscription>> {
        let conn = self.lock()?;
        let found = conn
            .query_row("SELECT * FROM subscriptions WHERE id = ?1", [id], row_to_subscription)
            .optional()?;
        Ok(found)
    }

    pub fn remove_subscription(&self, id: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM subscriptions WHERE id = ?1", [id])? > 0)
    }

    /// 记录一次成功刷新；失败时调用 [`Store::mark_subscription_error`]（保留旧索引）。
    pub fn mark_subscription_refreshed(&self, id: &str, count: i64) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE subscriptions SET count = ?2, updated_at = ?3, last_error = NULL WHERE id = ?1",
            params![id, count, super::now_millis()],
        )?;
        Ok(())
    }

    pub fn mark_subscription_error(&self, id: &str, error: &str) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute("UPDATE subscriptions SET last_error = ?2 WHERE id = ?1", params![id, error])?;
        Ok(())
    }
}
