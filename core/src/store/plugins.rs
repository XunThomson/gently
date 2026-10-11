//! 插件状态的持久化（`plugin_state` / `plugin_config`，迁移 0002）。
//!
//! 分工：**文件在磁盘、状态在库**。库只存「来源、校验和、启用、优先级、清单快照」，
//! 插件代码本身不落库（避免把不可信内容塞进 SQLite，也便于用户直接查看/替换文件）。

use rusqlite::{params, OptionalExtension, Row};

use crate::contract::{CoreError, ErrorCode, Fallible};
use crate::plugin::{InstalledPlugin, PluginManifest};

use super::Store;

fn row_to_record(row: &Row<'_>) -> rusqlite::Result<InstalledPlugin> {
    let manifest_json: String = row.get("manifest")?;
    let manifest: PluginManifest = serde_json::from_str(&manifest_json).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })?;
    Ok(InstalledPlugin {
        manifest,
        enabled: row.get::<_, i64>("enabled")? != 0,
        priority: row.get("priority")?,
        origin_kind: row.get("origin_kind")?,
        origin_value: row.get("origin_value")?,
        sha256: row.get("sha256")?,
        installed_at: row.get("installed_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const SELECT: &str = "SELECT * FROM plugin_state";

impl Store {
    /// 写入或覆盖一条插件记录（安装/更新都走它）。
    pub fn upsert_plugin(&self, record: &InstalledPlugin) -> Fallible<()> {
        let manifest_json = serde_json::to_string(&record.manifest)
            .map_err(|err| CoreError::internal(format!("清单序列化失败：{err}")))?;
        let conn = self.lock()?;

        // 更新时保留原 installed_at 与用户设置（enabled / priority）
        conn.execute(
            "INSERT INTO plugin_state
                 (id, name, version, enabled, priority, origin_kind, origin_value, sha256, manifest,
                  installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 version = excluded.version,
                 origin_kind = excluded.origin_kind,
                 origin_value = excluded.origin_value,
                 sha256 = excluded.sha256,
                 manifest = excluded.manifest,
                 updated_at = excluded.updated_at",
            params![
                record.manifest.id,
                record.manifest.name,
                record.manifest.version,
                i64::from(record.enabled),
                record.priority,
                record.origin_kind,
                record.origin_value,
                record.sha256,
                manifest_json,
                record.updated_at,
            ],
        )?;
        Ok(())
    }

    /// 按「优先级 → 名称」列出插件（与 `plugin_state_order` 索引一致）。
    pub fn list_plugins(&self) -> Fallible<Vec<InstalledPlugin>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY priority ASC, name ASC"))?;
        let rows = stmt.query_map([], row_to_record)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_plugin(&self, id: &str) -> Fallible<Option<InstalledPlugin>> {
        let conn = self.lock()?;
        let record = conn
            .query_row(&format!("{SELECT} WHERE id = ?1"), [id], row_to_record)
            .optional()?;
        Ok(record)
    }

    /// 删除记录；返回是否真的删掉了（false = 本来就不存在）。
    pub fn remove_plugin(&self, id: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM plugin_state WHERE id = ?1", [id])? > 0)
    }

    pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Fallible<bool> {
        let conn = self.lock()?;
        let changed = conn.execute(
            "UPDATE plugin_state SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, i64::from(enabled), super::now_millis()],
        )?;
        Ok(changed > 0)
    }

    /// 优先级：数值越小越优先（决定播放候选回退顺序）。
    pub fn set_plugin_priority(&self, id: &str, priority: i64) -> Fallible<bool> {
        if !(0..=9999).contains(&priority) {
            return Err(CoreError::invalid_argument("priority 必须在 0~9999 之间")
                .with_details(serde_json::json!({ "value": priority })));
        }
        let conn = self.lock()?;
        let changed = conn.execute(
            "UPDATE plugin_state SET priority = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, priority, super::now_millis()],
        )?;
        Ok(changed > 0)
    }

    /// 读取插件配置；返回 `(values, revision)`。
    pub fn get_plugin_config(&self, id: &str) -> Fallible<Option<(serde_json::Value, i64)>> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT values_json, revision FROM plugin_config WHERE plugin_id = ?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;

        match row {
            None => Ok(None),
            Some((json, revision)) => {
                let values = serde_json::from_str(&json).map_err(|err| {
                    CoreError::internal(format!("插件配置损坏（{id}）：{err}"))
                })?;
                Ok(Some((values, revision)))
            }
        }
    }

    /// 写入插件配置；`revision` 不匹配 → `common.conflict`（乐观并发，供多窗口场景）。
    pub fn put_plugin_config(
        &self,
        id: &str,
        values: &serde_json::Value,
        revision: i64,
    ) -> Fallible<i64> {
        let json = serde_json::to_string(values)
            .map_err(|err| CoreError::internal(format!("配置序列化失败：{err}")))?;
        let conn = self.lock()?;

        let current: Option<i64> = conn
            .query_row("SELECT revision FROM plugin_config WHERE plugin_id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;

        match current {
            // 从未写过：接受 revision 0 或 1
            None if revision <= 1 => {
                conn.execute(
                    "INSERT INTO plugin_config (plugin_id, values_json, revision, updated_at)
                     VALUES (?1, ?2, 1, ?3)",
                    params![id, json, super::now_millis()],
                )?;
                Ok(1)
            }
            None => Err(CoreError::new(
                ErrorCode::Conflict,
                "配置 revision 不匹配（本地尚无配置）",
            )
            // `current` 让前端不必再查一次就能重试
            .with_details(serde_json::json!({ "current": 0, "expected": 1, "got": revision }))),
            Some(found) if found == revision => {
                let next = found + 1;
                conn.execute(
                    "UPDATE plugin_config SET values_json = ?2, revision = ?3, updated_at = ?4
                     WHERE plugin_id = ?1",
                    params![id, json, next, super::now_millis()],
                )?;
                Ok(next)
            }
            Some(found) => Err(CoreError::new(ErrorCode::Conflict, "配置已被其它窗口修改")
                .with_details(serde_json::json!({ "current": found, "expected": found, "got": revision }))),
        }
    }
}
