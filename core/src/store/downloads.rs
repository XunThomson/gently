//! 下载任务的持久化（迁移 0006）。
//!
//! 状态机只有五个值（与契约 `DownloadStatus` 一致）：
//! `pending` → `downloading` → `done` / `error`，其中 `downloading ⇄ paused` 可来回。
//! 进度（`received`）落库，因此**重启后 `paused` 的任务可以续传**。

use serde_json::Value;

use crate::contract::Fallible;

use super::{now_millis, Store};

/// 任务状态（字符串与契约一致）。
pub const STATUS_PENDING: &str = "pending";
pub const STATUS_DOWNLOADING: &str = "downloading";
pub const STATUS_PAUSED: &str = "paused";
pub const STATUS_DONE: &str = "done";
pub const STATUS_ERROR: &str = "error";

/// 新建任务需要的东西。
#[derive(Debug, Clone)]
pub struct NewDownload {
    pub id: String,
    pub reference: String,
    pub source: String,
    pub quality: String,
    pub track: Value,
    pub path: String,
}

/// 一条下载任务。
#[derive(Debug, Clone)]
pub struct DownloadRow {
    pub id: String,
    pub reference: String,
    pub source: String,
    pub quality: String,
    pub track: Value,
    pub status: String,
    pub received: i64,
    pub total: Option<i64>,
    pub path: Option<String>,
    pub error: Option<String>,
    pub speed: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Store {
    pub fn insert_download(&self, task: &NewDownload) -> Fallible<DownloadRow> {
        let conn = self.lock()?;
        let now = now_millis();
        conn.execute(
            "INSERT INTO download_tasks
                 (id, ref, source, quality, track, status, received, total, path, error, speed,
                  created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, NULL, 0, ?8, ?8)",
            rusqlite::params![
                task.id,
                task.reference,
                task.source,
                task.quality,
                serde_json::to_string(&task.track)
                    .map_err(|err| crate::contract::CoreError::internal(format!("曲目快照序列化失败：{err}")))?,
                STATUS_PENDING,
                task.path,
                now,
            ],
        )?;
        Ok(DownloadRow {
            id: task.id.clone(),
            reference: task.reference.clone(),
            source: task.source.clone(),
            quality: task.quality.clone(),
            track: task.track.clone(),
            status: STATUS_PENDING.to_string(),
            received: 0,
            total: None,
            path: Some(task.path.clone()),
            error: None,
            speed: 0,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn get_download(&self, id: &str) -> Fallible<Option<DownloadRow>> {
        let conn = self.lock()?;
        Ok(conn
            .query_row("SELECT * FROM download_tasks WHERE id = ?1", [id], row_of)
            .ok())
    }

    pub fn list_downloads(&self) -> Fallible<Vec<DownloadRow>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT * FROM download_tasks ORDER BY created_at DESC")?;
        let collected = stmt.query_map([], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(collected)
    }

    /// 更新进度/状态：`total`/`error`/`speed` 只在给出时覆盖（进度更新很频繁，别把状态写丢）。
    pub fn update_download(
        &self,
        id: &str,
        status: &str,
        received: i64,
        total: Option<i64>,
        error: Option<&str>,
        speed: i64,
    ) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE download_tasks
             SET status = ?2, received = ?3,
                 total = COALESCE(?4, total),
                 error = ?5,
                 speed = ?6,
                 updated_at = ?7
             WHERE id = ?1",
            rusqlite::params![id, status, received.max(0), total, error, speed.max(0), now_millis()],
        )?;
        Ok(())
    }

    /// 只改状态（暂停/续传/落盘路径），不动进度。
    pub fn set_download_status(&self, id: &str, status: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "UPDATE download_tasks SET status = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![id, status, now_millis()],
        )? > 0)
    }

    /// 落盘路径在下载过程中可能被改写（真实扩展名要等解析出媒体地址才知道）。
    pub fn set_download_path(&self, id: &str, path: &str) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE download_tasks SET path = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![id, path, now_millis()],
        )?;
        Ok(())
    }

    pub fn delete_download(&self, id: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM download_tasks WHERE id = ?1", [id])? > 0)
    }

    /// 清理已完成/失败的任务记录（**不删文件**：文件是用户的资产）。
    pub fn clear_finished_downloads(&self) -> Fallible<usize> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "DELETE FROM download_tasks WHERE status IN (?1, ?2)",
            rusqlite::params![STATUS_DONE, STATUS_ERROR],
        )?)
    }
}

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadRow> {
    let text: String = row.get("track")?;
    Ok(DownloadRow {
        id: row.get("id")?,
        reference: row.get("ref")?,
        source: row.get("source")?,
        quality: row.get("quality")?,
        // 坏快照退化成 null：下载列表不该因为一条坏记录整页失败
        track: serde_json::from_str(&text).unwrap_or(Value::Null),
        status: row.get("status")?,
        received: row.get("received")?,
        total: row.get("total")?,
        path: row.get("path")?,
        error: row.get("error")?,
        speed: row.get("speed")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
