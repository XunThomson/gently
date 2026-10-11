//! 本地曲库的持久化（迁移 0005）：扫描结果 + FTS5 检索。
//!
//! - `local:<规范化路径>` 是主键：同一文件重复扫描必须命中同一行（路径是稳定标识）；
//! - `size` 用于**快速重扫**：大小没变就跳过读标签；
//! - 检索：`trigram` 词元化支持中英文子串；**1~2 个字符的查询退回 LIKE**
//!   （trigram 至少要 3 个字符才有词元），两条路径都在这里收口。

use std::collections::HashMap;

use rusqlite::{params, Row};

use crate::contract::Fallible;

use super::{now_millis, PageRows, Store};

/// 扫描得到的一条本地曲目（写库用）。
#[derive(Debug, Clone)]
pub struct LocalTrackInput {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub size: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_sec: i64,
}

/// 库里的一条本地曲目。
#[derive(Debug, Clone)]
pub struct LocalTrackRow {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub size: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_sec: i64,
    pub added_at: i64,
    pub updated_at: i64,
}

/// 一次写入的结果：新增 / 更新各多少条。
#[derive(Debug, Clone, Copy, Default)]
pub struct UpsertOutcome {
    pub added: usize,
    pub updated: usize,
}

fn row_of(row: &Row<'_>) -> rusqlite::Result<LocalTrackRow> {
    Ok(LocalTrackRow {
        id: row.get("id")?,
        path: row.get("path")?,
        file_name: row.get("file_name")?,
        size: row.get("size")?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        album: row.get("album")?,
        duration_sec: row.get("duration_sec")?,
        added_at: row.get("added_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl Store {
    /// 批量写入（一次事务）：扫描可能一次几千条，逐条提交会把 WAL 撑爆。
    ///
    /// 返回 (新增, 更新)：已存在的行只更新元数据与 `updated_at`，`added_at` 保持不变。
    pub fn upsert_local_tracks(&self, tracks: &[LocalTrackInput]) -> Fallible<UpsertOutcome> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let now = now_millis();
        let mut outcome = UpsertOutcome::default();

        for track in tracks {
            let exists: Option<i64> = tx
                .query_row("SELECT 1 FROM local_tracks WHERE id = ?1", [&track.id], |row| row.get(0))
                .ok();
            tx.execute(
                "INSERT INTO local_tracks
                     (id, path, file_name, size, title, artist, album, duration_sec, added_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                     path = excluded.path,
                     file_name = excluded.file_name,
                     size = excluded.size,
                     title = excluded.title,
                     artist = excluded.artist,
                     album = excluded.album,
                     duration_sec = excluded.duration_sec,
                     updated_at = excluded.updated_at",
                params![
                    track.id,
                    track.path,
                    track.file_name,
                    track.size,
                    track.title,
                    track.artist,
                    track.album,
                    track.duration_sec,
                    now,
                ],
            )?;
            if exists.is_some() {
                outcome.updated += 1;
            } else {
                outcome.added += 1;
            }
        }

        tx.commit()?;
        Ok(outcome)
    }

    /// 已入库的曲目（`id` → 文件大小）：扫描前用它判断「新增 / 更新 / 跳过 / 已删除」。
    pub fn local_track_index(&self) -> Fallible<HashMap<String, (String, i64)>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT id, path, size FROM local_tracks")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>("id")?, (row.get::<_, String>("path")?, row.get::<_, i64>("size")?)))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// 删除若干条（按 id）。返回真的删掉的行数。
    pub fn remove_local_tracks(&self, ids: &[String]) -> Fallible<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let mut removed = 0usize;
        for id in ids {
            removed += tx.execute("DELETE FROM local_tracks WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(removed)
    }

    /// 按 id 取一条（`library.local.remove` 需要它的路径）。
    pub fn get_local_track(&self, id: &str) -> Fallible<Option<LocalTrackRow>> {
        let conn = self.lock()?;
        let found = conn
            .query_row("SELECT * FROM local_tracks WHERE id = ?1", [id], row_of)
            .ok();
        Ok(found)
    }

    /// 列表 +（可选）文本检索，`(added_at, id)` 复合游标倒序。
    pub fn list_local_tracks(
        &self,
        limit: usize,
        cursor: Option<&str>,
        query: Option<&str>,
    ) -> Fallible<PageRows<LocalTrackRow>> {
        let conn = self.lock()?;
        let (after_at, after_id) = split_cursor(cursor);
        let search = query.map(str::trim).filter(|text| !text.is_empty());

        let total: i64 = match search {
            Some(text) => count_matching(&conn, text)?,
            None => conn.query_row("SELECT COUNT(*) FROM local_tracks", [], |row| row.get(0))?,
        };

        // 检索词与游标条件都用参数绑定；FTS 的 MATCH 串在下面单独消毒
        let rows: Vec<LocalTrackRow> = match search {
            Some(text) => {
                let (sql, fts) = search_sql(text);
                let mut stmt = conn.prepare(&sql)?;
                // 先落到局部变量再返回：MappedRows 借用了 stmt，直接当块尾表达式会与 stmt 的生命周期打架
                let collected = if let Some(fts) = fts {
                    stmt.query_map(params![fts, after_at, after_id, (limit + 1) as i64], row_of)?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                } else {
                    let like = format!("%{}%", escape_like(text));
                    stmt.query_map(params![like, after_at, after_id, (limit + 1) as i64], row_of)?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                collected
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT * FROM local_tracks
                     WHERE (?1 IS NULL) OR added_at < ?1 OR (added_at = ?1 AND id < ?2)
                     ORDER BY added_at DESC, id DESC LIMIT ?3",
                )?;
                let collected = stmt
                    .query_map(params![after_at, after_id, (limit + 1) as i64], row_of)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                collected
            }
        };

        let mut items = rows;
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        let next_cursor = if has_more {
            items.last().map(|row| format!("{}:{}", row.added_at, row.id))
        } else {
            None
        };
        Ok(PageRows { items, next_cursor, total })
    }

    pub fn count_local_tracks(&self) -> Fallible<i64> {
        let conn = self.lock()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM local_tracks", [], |row| row.get(0))?)
    }
}

/// 检索 SQL：≥3 个字符走 FTS5（trigram），否则退回 LIKE（trigram 没有 1~2 字的词元）。
///
/// 返回 `(SQL, Some(MATCH 串) | None)`——`None` 表示第一个参数是 LIKE 模式。
fn search_sql(text: &str) -> (String, Option<String>) {
    let cursor_filter = "(?2 IS NULL) OR added_at < ?2 OR (added_at = ?2 AND id < ?3)";
    if text.chars().count() >= 3 {
        let fts = fts_query(text);
        return (
            format!(
                "SELECT l.* FROM local_tracks l
                 JOIN local_tracks_fts f ON f.rowid = l.rowid
                 WHERE local_tracks_fts MATCH ?1 AND ({cursor_filter})
                 ORDER BY l.added_at DESC, l.id DESC LIMIT ?4"
            ),
            Some(fts),
        );
    }
    (
        format!(
            "SELECT * FROM local_tracks
             WHERE (title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1) AND ({cursor_filter})
             ORDER BY added_at DESC, id DESC LIMIT ?4"
        ),
        None,
    )
}

/// FTS5 查询串：按空白切成「前缀短语」，引号翻倍转义（用户输入不能直接拼进 MATCH）。
fn fts_query(text: &str) -> String {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|term| term.replace('"', "\"\""))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\""))
        .collect();
    if terms.is_empty() {
        // 全是空白：给一个不可能命中的查询，而不是让 MATCH 语法报错
        return "\"\"".to_string();
    }
    terms.join(" ")
}

/// LIKE 模式里的通配符要转义（用户输入的 `%` 不该变成通配）。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn count_matching(conn: &rusqlite::Connection, text: &str) -> Fallible<i64> {
    let (_, fts) = search_sql(text);
    let count = match fts {
        Some(fts) => conn.query_row(
            "SELECT COUNT(*) FROM local_tracks_fts WHERE local_tracks_fts MATCH ?1",
            [fts],
            |row| row.get(0),
        )?,
        None => {
            let like = format!("%{}%", escape_like(text));
            conn.query_row(
                "SELECT COUNT(*) FROM local_tracks
                 WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1",
                [like],
                |row| row.get(0),
            )?
        }
    };
    Ok(count)
}

/// 游标 `时间戳:id`。**必须从左边第一个冒号切**：id 自己带电冒号（`local:<路径>`），
/// 从右边切会把时间戳切成 `"1696...:local"`，解析失败后静默退回第一页（分页就永远翻不动）。
fn split_cursor(cursor: Option<&str>) -> (Option<i64>, String) {
    let Some(cursor) = cursor else { return (None, String::new()) };
    match cursor.split_once(':') {
        Some((at, id)) => match at.parse::<i64>() {
            Ok(at) => (Some(at), id.to_string()),
            Err(_) => (None, String::new()),
        },
        None => (None, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().expect("内存库")
    }

    fn input(id: &str, title: &str, artist: &str, album: &str) -> LocalTrackInput {
        LocalTrackInput {
            id: format!("local:{id}"),
            path: format!("C:/music/{id}.flac"),
            file_name: format!("{id}.flac"),
            size: 1024,
            title: title.into(),
            artist: artist.into(),
            album: album.into(),
            duration_sec: 200,
        }
    }

    #[test]
    fn upsert_counts_and_keeps_added_at() {
        let store = store();
        let first = store.upsert_local_tracks(&[input("a", "夜曲", "周杰伦", "十一月的萧邦")]).unwrap();
        assert_eq!((first.added, first.updated), (1, 0));
        let added_at = store.get_local_track("local:a").unwrap().unwrap().added_at;

        // 再扫一次（大小变了→更新）：added_at 不变，updated 计数
        let mut again = input("a", "夜曲", "周杰伦", "十一月的萧邦");
        again.size = 2048;
        let second = store.upsert_local_tracks(&[again]).unwrap();
        assert_eq!((second.added, second.updated), (0, 1));
        let row = store.get_local_track("local:a").unwrap().unwrap();
        assert_eq!(row.size, 2048);
        assert_eq!(row.added_at, added_at, "added_at 是「加入曲库的时间」，更新不该改写");
    }

    #[test]
    fn search_covers_cjk_substrings_and_latin_words() {
        let store = store();
        store
            .upsert_local_tracks(&[
                input("a", "夜曲", "周杰伦", "十一月的萧邦"),
                input("b", "晴天", "周杰伦", "叶惠美"),
                input("c", "Bohemian Rhapsody", "Queen", "A Night at the Opera"),
            ])
            .unwrap();

        // 2 个汉字：trigram 没有词元，走 LIKE 兜底
        let page = store.list_local_tracks(10, None, Some("夜曲")).unwrap();
        assert_eq!(page.items.len(), 1, "中文子串要能搜到");
        assert_eq!(page.items[0].title, "夜曲");
        assert_eq!(page.total, 1);

        // 3 个字：走 FTS5 MATCH（同一套接口，调用方不需要知道走哪条路）
        let page = store.list_local_tracks(10, None, Some("周杰伦")).unwrap();
        assert_eq!(page.items.len(), 2, "按歌手检索要命中两首");

        // 拉丁词（不区分大小写 + 前缀子串）
        let page = store.list_local_tracks(10, None, Some("queen")).unwrap();
        assert_eq!(page.items.len(), 1);
        let page = store.list_local_tracks(10, None, Some("bohemian")).unwrap();
        assert_eq!(page.items.len(), 1);

        // 专辑字段也在检索范围内
        let page = store.list_local_tracks(10, None, Some("叶惠美")).unwrap();
        assert_eq!(page.items.len(), 1);

        // 搜不到就是空，不是报错；用户输入的 % 不该变成通配
        assert!(store.list_local_tracks(10, None, Some("不存在的歌")).unwrap().items.is_empty());
        assert!(store.list_local_tracks(10, None, Some("%")).unwrap().items.is_empty());
    }

    #[test]
    fn remove_and_index_track_state() {
        let store = store();
        store.upsert_local_tracks(&[input("a", "甲", "", ""), input("b", "乙", "", "")]).unwrap();
        let index = store.local_track_index().unwrap();
        assert_eq!(index.len(), 2);
        assert_eq!(index.get("local:a").map(|(path, _)| path.as_str()), Some("C:/music/a.flac"));

        assert_eq!(store.remove_local_tracks(&["local:a".to_string()]).unwrap(), 1);
        assert_eq!(store.count_local_tracks().unwrap(), 1);
        // 删掉的条目也必须从 FTS 索引里消失（触发器负责）
        assert!(store.list_local_tracks(10, None, Some("甲")).unwrap().items.is_empty());
        assert_eq!(store.remove_local_tracks(&[]).unwrap(), 0);
    }

    #[test]
    fn local_tracks_paginate_with_cursor() {
        let store = store();
        let batch: Vec<LocalTrackInput> =
            (0..5).map(|i| input(&format!("t{i}"), "歌", "歌手", "专辑")).collect();
        store.upsert_local_tracks(&batch).unwrap();

        let first = store.list_local_tracks(2, None, None).unwrap();
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.total, 5);
        assert!(first.next_cursor.is_some());
        let second = store.list_local_tracks(2, first.next_cursor.as_deref(), None).unwrap();
        assert_eq!(second.items.len(), 2);
        assert_ne!(first.items[0].id, second.items[0].id);
    }
}
