//! 推荐反馈的持久化（迁移 0008）。
//!
//! 反馈是**弱信号**：append-only，只影响下一次打分，不改变曲库。

use serde_json::Value;

use crate::contract::Fallible;

use super::{now_millis, Store};

/// 一条反馈。
#[derive(Debug, Clone)]
pub struct FeedbackRow {
    pub reference: String,
    pub source: String,
    pub action: String,
    pub progress: Option<f64>,
    pub track: Value,
    pub created_at: i64,
}

impl Store {
    pub fn push_feedback(
        &self,
        reference: &str,
        source: &str,
        action: &str,
        progress: Option<f64>,
        track: &Value,
    ) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO recommend_feedback (ref, source, action, progress, track, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                reference,
                source,
                action,
                progress,
                serde_json::to_string(track).unwrap_or_else(|_| "null".to_string()),
                now_millis(),
            ],
        )?;
        Ok(())
    }

    /// 最近的反馈（新→旧）。画像只消费近期窗口，避免几个月前的点击长期主导打分。
    pub fn list_feedback(&self, limit: usize) -> Fallible<Vec<FeedbackRow>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT * FROM recommend_feedback ORDER BY created_at DESC, id DESC LIMIT ?1")?;
        let collected = stmt
            .query_map([limit as i64], |row| {
                let text: String = row.get("track")?;
                Ok(FeedbackRow {
                    reference: row.get("ref")?,
                    source: row.get("source")?,
                    action: row.get("action")?,
                    progress: row.get("progress")?,
                    track: serde_json::from_str(&text).unwrap_or(Value::Null),
                    created_at: row.get("created_at")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(collected)
    }

    pub fn count_feedback(&self) -> Fallible<i64> {
        let conn = self.lock()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM recommend_feedback", [], |row| row.get(0))?)
    }
}
