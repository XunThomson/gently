//! 用户皮肤的持久化（迁移 0007）。
//!
//! 皮肤 = 一份 `ThemeSkin` JSON，**整份存库**（小文档、导出即分享）；
//! 只有列表与去重需要的几个字段单独成列。**激活状态在 `meta` 表**
//! （`skin.active`）：它是「当前选择」而非皮肤自身的属性。

use serde_json::Value;

use crate::contract::{CoreError, Fallible};

use super::{now_millis, Store};

/// `meta` 表里记录「当前激活的皮肤 id」的键（空串表示恢复默认主题）。
pub const ACTIVE_KEY: &str = "skin.active";

/// 一条已安装的皮肤。
#[derive(Debug, Clone)]
pub struct SkinRow {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: Option<String>,
    pub document: Value,
    pub origin_kind: String,
    pub origin_value: String,
    pub sha256: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
}

impl Store {
    /// 写入或覆盖一份皮肤（覆盖时保留 `installed_at`）。
    pub fn upsert_skin(
        &self,
        id: &str,
        name: &str,
        author: &str,
        version: Option<&str>,
        document: &Value,
        origin_kind: &str,
        origin_value: &str,
        sha256: Option<&str>,
    ) -> Fallible<SkinRow> {
        let document_text = serde_json::to_string(document)
            .map_err(|err| CoreError::internal(format!("皮肤序列化失败：{err}")))?;
        let now = now_millis();
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO skins
                 (id, name, author, version, document, origin_kind, origin_value, sha256,
                  installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 author = excluded.author,
                 version = excluded.version,
                 document = excluded.document,
                 origin_kind = excluded.origin_kind,
                 origin_value = excluded.origin_value,
                 sha256 = excluded.sha256,
                 updated_at = excluded.updated_at",
            rusqlite::params![id, name, author, version, document_text, origin_kind, origin_value, sha256, now],
        )?;
        Ok(SkinRow {
            id: id.to_string(),
            name: name.to_string(),
            author: author.to_string(),
            version: version.map(str::to_string),
            document: document.clone(),
            origin_kind: origin_kind.to_string(),
            origin_value: origin_value.to_string(),
            sha256: sha256.map(str::to_string),
            installed_at: now,
            updated_at: now,
        })
    }

    pub fn list_skins(&self) -> Fallible<Vec<SkinRow>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT * FROM skins ORDER BY updated_at DESC, id ASC")?;
        let collected = stmt.query_map([], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(collected)
    }

    pub fn get_skin(&self, id: &str) -> Fallible<Option<SkinRow>> {
        let conn = self.lock()?;
        Ok(conn.query_row("SELECT * FROM skins WHERE id = ?1", [id], row_of).ok())
    }

    pub fn delete_skin(&self, id: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM skins WHERE id = ?1", [id])? > 0)
    }

    /// 当前激活的皮肤 id（`None` = 默认主题）。
    pub fn active_skin(&self) -> Fallible<Option<String>> {
        Ok(self.meta_get(ACTIVE_KEY)?.filter(|value| !value.is_empty()))
    }

    /// 设置/清除激活皮肤（`None` 恢复默认主题）。
    pub fn set_active_skin(&self, id: Option<&str>) -> Fallible<()> {
        self.meta_set(ACTIVE_KEY, id.unwrap_or_default())
    }
}

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkinRow> {
    let text: String = row.get("document")?;
    Ok(SkinRow {
        id: row.get("id")?,
        name: row.get("name")?,
        author: row.get("author")?,
        version: row.get("version")?,
        // 坏文档退化成空对象而不是让整个列表失败（导入时已经校验过一次）
        document: serde_json::from_str(&text).unwrap_or(Value::Null),
        origin_kind: row.get("origin_kind")?,
        origin_value: row.get("origin_value")?,
        sha256: row.get("sha256")?,
        installed_at: row.get("installed_at")?,
        updated_at: row.get("updated_at")?,
    })
}
