//! 本机库的持久化（迁移 0004）：收藏 / 歌单 / 播放历史。
//!
//! 三条约定：
//! 1. **曲目快照存 JSON**：插件可能被卸载或改接口，本机库必须能独立列出条目；
//! 2. **引用 `source:trackId` 是去重键**：收藏与历史按 ref 归并；
//! 3. **游标分页**：`(时间戳, 主键)` 复合游标倒序下发，`nextCursor` 对调用方不透明。
//!
//! 「快照从哪来」的取舍写在 `crate::library`：**调用方带上 Track**（它手上就有），
//! 缺了就退化成最小占位曲目——核心不为了补一个标题去调插件（写入路径不该依赖网络）。

use rusqlite::{params, Row};
use serde_json::Value;

use crate::contract::{CoreError, Fallible};

use super::Store;

/// 默认每页条数（契约 `PageQuery.limit` 的缺省值）。
pub const DEFAULT_PAGE: usize = 50;
/// 每页上限（契约：1~500）。
pub const MAX_PAGE: usize = 500;

/// 库里存的一条曲目（快照 + 引用）。
#[derive(Debug, Clone)]
pub struct StoredTrack {
    pub reference: String,
    pub source: String,
    pub track: Value,
}

/// 一页结果：条目 + 下一页游标（没有下一页时为 None）。
#[derive(Debug, Clone)]
pub struct PageRows<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: i64,
}

/// 收藏行。
#[derive(Debug, Clone)]
pub struct FavoriteRow {
    pub stored: StoredTrack,
    pub created_at: i64,
}

/// 播放历史行（`play_count` 是该 ref 的累计播放次数）。
#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub stored: StoredTrack,
    pub played_sec: i64,
    pub completed: bool,
    pub played_at: i64,
    pub play_count: i64,
}

/// 歌单行（含按 position 排序的曲目）。
#[derive(Debug, Clone)]
pub struct PlaylistRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tracks: Vec<StoredTrack>,
}

/// 规范化分页参数：`limit` 夹到 1~500，缺省 50。
pub fn normalize_limit(limit: Option<u32>) -> usize {
    match limit {
        Some(value) => (value as usize).clamp(1, MAX_PAGE),
        None => DEFAULT_PAGE,
    }
}

impl Store {
    // ---------------------------------------------------------------- 收藏

    pub fn set_favorite(
        &self,
        reference: &str,
        source: &str,
        track: &Value,
        favorite: bool,
    ) -> Fallible<bool> {
        let conn = self.lock()?;
        if favorite {
            // 重复收藏是幂等更新：快照取最新一次（插件接口变了也能刷新）
            conn.execute(
                "INSERT INTO favorites (ref, source, track, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(ref) DO UPDATE SET source = excluded.source, track = excluded.track",
                params![reference, source, track_text(track)?, super::now_millis()],
            )?;
        } else {
            conn.execute("DELETE FROM favorites WHERE ref = ?1", [reference])?;
        }
        Ok(favorite)
    }

    pub fn is_favorite(&self, reference: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        let found: Option<i64> =
            conn.query_row("SELECT 1 FROM favorites WHERE ref = ?1", [reference], |row| row.get(0))
                .ok();
        Ok(found.is_some())
    }

    pub fn list_favorites(&self, limit: usize, cursor: Option<&str>) -> Fallible<PageRows<FavoriteRow>> {
        let conn = self.lock()?;
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM favorites", [], |row| row.get(0))?;
        let (after_at, after_ref) = split_cursor(cursor);

        // 多取一条用来判断「还有下一页」，避免再查一次
        let mut stmt = conn.prepare(
            "SELECT ref, source, track, created_at FROM favorites
             WHERE (?1 IS NULL)
                OR created_at < ?1
                OR (created_at = ?1 AND ref < ?2)
             ORDER BY created_at DESC, ref DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![after_at, after_ref, (limit + 1) as i64], |row| {
            Ok(FavoriteRow { stored: stored_track(row)?, created_at: row.get("created_at")? })
        })?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        let next_cursor = if items.len() > limit {
            items.truncate(limit);
            items.last().map(|row| format!("{}:{}", row.created_at, row.stored.reference))
        } else {
            None
        };
        Ok(PageRows { items, next_cursor, total })
    }

    // ---------------------------------------------------------------- 播放历史

    pub fn push_history(
        &self,
        reference: &str,
        source: &str,
        track: &Value,
        played_sec: i64,
        completed: bool,
    ) -> Fallible<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO play_history (ref, source, track, played_sec, completed, played_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                reference,
                source,
                track_text(track)?,
                played_sec.max(0),
                i64::from(completed),
                super::now_millis(),
            ],
        )?;
        Ok(())
    }

    /// 最近播放：**每首歌一行**（取最近一次播放），`play_count` 是累计次数。
    ///
    /// 为什么在库里聚合而不是让界面去重：`play_history` 是「每次播放一行」（统计需要），
    /// 但「最近播放」这个视图要的是「每首歌一行」。放两边各算一次必然走样
    /// （界面若按 id 去重还会踩到 React key 重复 + 全部行高亮，R121 实测）。
    /// 窗口函数在 SQLite 3.25+（rusqlite 自带的最新版）可用。
    pub fn list_history(&self, limit: usize, cursor: Option<&str>) -> Fallible<PageRows<HistoryRow>> {
        let conn = self.lock()?;
        let total: i64 =
            conn.query_row("SELECT COUNT(DISTINCT ref) FROM play_history", [], |row| row.get(0))?;
        let (after_at, after_id) = split_cursor(cursor);

        // 主键（id）只用于复合游标，因此只在这一层内部流转，不外泄到 HistoryRow
        let mut stmt = conn.prepare(
            "WITH ranked AS (
                 SELECT id, ref, source, track, played_sec, completed, played_at,
                        ROW_NUMBER() OVER (PARTITION BY ref ORDER BY played_at DESC, id DESC) AS rn,
                        COUNT(*) OVER (PARTITION BY ref) AS play_count
                 FROM play_history
             )
             SELECT id, ref, source, track, played_sec, completed, played_at, play_count
             FROM ranked
             WHERE rn = 1
               AND ((?1 IS NULL)
                    OR played_at < ?1
                    OR (played_at = ?1 AND id < ?2))
             ORDER BY played_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![after_at, after_id, (limit + 1) as i64], |row| {
            Ok((
                HistoryRow {
                    stored: stored_track(row)?,
                    played_sec: row.get("played_sec")?,
                    completed: row.get::<_, i64>("completed")? != 0,
                    played_at: row.get("played_at")?,
                    play_count: row.get("play_count")?,
                },
                row.get::<_, i64>("id")?,
            ))
        })?;
        let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        // 多取的那条只用来判断「还有下一页」；游标必须指向本页最后一条
        let has_more = rows.len() > limit;
        if has_more {
            rows.truncate(limit);
        }
        let next_cursor = if has_more {
            rows.last().map(|(row, id)| format!("{}:{id}", row.played_at))
        } else {
            None
        };
        Ok(PageRows { items: rows.into_iter().map(|(row, _)| row).collect(), next_cursor, total })
    }

    // ---------------------------------------------------------------- 歌单

    pub fn list_playlists(&self) -> Fallible<Vec<PlaylistRow>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, updated_at FROM playlists ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PlaylistRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    tracks: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut track_stmt = conn.prepare(
            "SELECT ref, source, track FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC",
        )?;
        rows.into_iter()
            .map(|mut playlist| {
                playlist.tracks = track_stmt
                    .query_map([&playlist.id], stored_track)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(playlist)
            })
            .collect()
    }

    pub fn get_playlist(&self, id: &str) -> Fallible<Option<PlaylistRow>> {
        Ok(self.list_playlists()?.into_iter().find(|playlist| playlist.id == id))
    }

    /// 新建或覆盖一个歌单（曲目整体替换，顺序即传入顺序）。
    pub fn save_playlist(&self, id: Option<&str>, name: &str, tracks: &[StoredTrack]) -> Fallible<PlaylistRow> {
        let now = super::now_millis();
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let playlist_id = match id {
            Some(existing) => {
                let updated = tx.execute(
                    "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1",
                    params![existing, name, now],
                )?;
                if updated == 0 {
                    return Err(CoreError::not_found(format!("歌单不存在：{existing}")));
                }
                tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", [existing])?;
                existing.to_string()
            }
            None => {
                // id 由 SQLite 生成：省掉一个 uuid 依赖，也不会与已有歌单撞车
                tx.execute(
                    "INSERT INTO playlists (id, name, created_at, updated_at)
                     VALUES ('pl-' || lower(hex(randomblob(8))), ?1, ?2, ?2)",
                    params![name, now],
                )?;
                tx.query_row("SELECT id FROM playlists WHERE rowid = last_insert_rowid()", [], |row| {
                    row.get(0)
                })?
            }
        };

        for (position, track) in tracks.iter().enumerate() {
            tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, position, ref, source, track)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    playlist_id,
                    position as i64,
                    track.reference,
                    track.source,
                    track_text(&track.track)?,
                ],
            )?;
        }

        let created_at: i64 = tx.query_row(
            "SELECT created_at FROM playlists WHERE id = ?1",
            [&playlist_id],
            |row| row.get(0),
        )?;
        tx.commit()?;

        Ok(PlaylistRow {
            id: playlist_id,
            name: name.to_string(),
            created_at,
            updated_at: now,
            tracks: tracks.to_vec(),
        })
    }

    /// 删除歌单（曲目靠外键级联一起删）。返回是否真的删掉了。
    pub fn delete_playlist(&self, id: &str) -> Fallible<bool> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM playlists WHERE id = ?1", [id])? > 0)
    }

    // ---------------------------------------------------------------- 统计

    /// 清空播放历史（收藏不受影响）。返回删掉的行数。
    pub fn clear_history(&self) -> Fallible<usize> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM play_history", [])?)
    }

    pub fn count_favorites(&self) -> Fallible<i64> {
        let conn = self.lock()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM favorites", [], |row| row.get(0))?)
    }

    pub fn count_history(&self) -> Fallible<i64> {
        let conn = self.lock()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM play_history", [], |row| row.get(0))?)
    }
}

/// 把快照序列化成列值。
fn track_text(track: &Value) -> Fallible<String> {
    serde_json::to_string(track).map_err(|err| CoreError::internal(format!("曲目快照序列化失败：{err}")))
}

/// 读一行曲目快照（损坏的快照退化成空对象，而不是让整页读取失败）。
fn stored_track(row: &Row<'_>) -> rusqlite::Result<StoredTrack> {
    let text: String = row.get("track")?;
    Ok(StoredTrack {
        reference: row.get("ref")?,
        source: row.get("source")?,
        track: serde_json::from_str(&text).unwrap_or(Value::Null),
    })
}



/// 游标格式 `时间戳:主键`；解析不出来就当「从头开始」（游标对调用方不透明）。
fn split_cursor(cursor: Option<&str>) -> (Option<i64>, String) {
    let Some(cursor) = cursor else { return (None, String::new()) };
    match cursor.split_once(':') {
        Some((at, key)) => match at.parse::<i64>() {
            Ok(at) => (Some(at), key.to_string()),
            Err(_) => (None, String::new()),
        },
        None => (None, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> Store {
        Store::open_in_memory().expect("内存库")
    }

    fn track(id: &str, title: &str) -> Value {
        json!({"id": id, "title": title, "artist": "歌手", "durationSec": 100})
    }

    #[test]
    fn favorites_are_idempotent_and_paginate_by_cursor() {
        let store = store();
        for index in 0..3 {
            let reference = format!("src:t{index}");
            store
                .set_favorite(&reference, "src", &track(&format!("src:t{index}"), "歌"), true)
                .unwrap();
        }
        assert_eq!(store.count_favorites().unwrap(), 3);
        // 重复收藏是更新而不是新增
        store.set_favorite("src:t0", "src", &track("src:t0", "新标题"), true).unwrap();
        assert_eq!(store.count_favorites().unwrap(), 3);
        assert!(store.is_favorite("src:t0").unwrap());

        let first = store.list_favorites(2, None).unwrap();
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.total, 3);
        assert!(first.next_cursor.is_some());

        let second = store.list_favorites(2, first.next_cursor.as_deref()).unwrap();
        assert_eq!(second.items.len(), 1, "第二页应只剩一条");
        assert!(second.next_cursor.is_none(), "到底了就不该再给游标");

        // 取消收藏
        store.set_favorite("src:t0", "src", &Value::Null, false).unwrap();
        assert!(!store.is_favorite("src:t0").unwrap());
        assert_eq!(store.count_favorites().unwrap(), 2);
    }

    #[test]
    fn history_keeps_every_play_but_lists_one_row_per_track() {
        let store = store();
        for _ in 0..2 {
            store.push_history("src:a", "src", &track("src:a", "甲"), 30, false).unwrap();
        }
        store.push_history("src:b", "src", &track("src:b", "乙"), 200, true).unwrap();

        assert_eq!(store.count_history().unwrap(), 3, "每次播放都留一行（统计要它）");
        let page = store.list_history(10, None).unwrap();
        assert_eq!(page.items.len(), 2, "「最近播放」每首歌一行");
        let first = page.items.iter().find(|row| row.stored.reference == "src:a").unwrap();
        assert_eq!(first.play_count, 2, "同一首歌的累计次数");
        assert_eq!(page.total, 2, "总数也是歌数，不是播放次数");

        // 游标翻页不重不漏
        let first_page = store.list_history(1, None).unwrap();
        assert_eq!(first_page.items.len(), 1);
        let second_page = store.list_history(1, first_page.next_cursor.as_deref()).unwrap();
        assert_eq!(second_page.items.len(), 1);
        assert_ne!(
            first_page.items[0].played_at.to_string() + &first_page.items[0].stored.reference,
            second_page.items[0].played_at.to_string() + &second_page.items[0].stored.reference,
        );
    }

    #[test]
    fn playlists_keep_order_and_cascade_on_delete() {
        let store = store();
        let tracks = vec![
            StoredTrack { reference: "src:a".into(), source: "src".into(), track: track("src:a", "甲") },
            StoredTrack { reference: "src:b".into(), source: "src".into(), track: track("src:b", "乙") },
        ];
        let created = store.save_playlist(None, "我的歌单", &tracks).unwrap();
        assert!(created.id.starts_with("pl-"));
        assert_eq!(created.tracks.len(), 2);

        let listed = store.list_playlists().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].tracks[0].reference, "src:a", "顺序必须保留");

        // 覆盖保存：整体替换曲目
        let updated = store
            .save_playlist(Some(&created.id), "改名了", &tracks[1..].to_vec())
            .unwrap();
        assert_eq!(updated.name, "改名了");
        assert_eq!(store.list_playlists().unwrap()[0].tracks.len(), 1);
        assert_eq!(store.list_playlists().unwrap()[0].created_at, created.created_at, "created_at 不该被改写");

        // 覆盖不存在的歌单 → 明确报错
        assert!(store.save_playlist(Some("pl-nope"), "x", &[]).is_err());

        assert!(store.delete_playlist(&created.id).unwrap());
        assert!(store.list_playlists().unwrap().is_empty());
        assert!(!store.delete_playlist(&created.id).unwrap(), "再删一次返回 false");
    }

    #[test]
    fn broken_snapshot_does_not_break_the_page() {
        let store = store();
        store.set_favorite("src:x", "src", &track("src:x", "甲"), true).unwrap();
        {
            let conn = store.lock().unwrap();
            conn.execute("UPDATE favorites SET track = '{坏掉的 JSON'", []).unwrap();
        }
        let page = store.list_favorites(10, None).unwrap();
        assert_eq!(page.items.len(), 1, "坏快照退化成 null，而不是让整页失败");
        assert_eq!(page.items[0].stored.reference, "src:x");
    }
}
