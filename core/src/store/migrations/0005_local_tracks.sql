-- 0005：本地曲库（扫描结果 + FTS5 检索）。
--
-- 设计取舍：
--  * **id 由路径派生**（`local:<规范化路径>`）：同一文件重复扫描必须命中同一行，
--    而路径是这台机器上唯一的稳定标识（大小/时间都会变）；
--  * **size 存下来用于「快速重扫」**：大小没变就跳过读标签，1 万文件的重复扫描才够快；
--  * **FTS5 用 trigram 词元化**：`unicode61` 对中文没有词边界（整段是一个词元），
--    子串检索会失效；trigram 支持中英文子串，1~2 字查询在 store 层退回 LIKE。

CREATE TABLE IF NOT EXISTS local_tracks (
    id           TEXT PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    file_name    TEXT NOT NULL,
    size         INTEGER NOT NULL,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL DEFAULT '',
    album        TEXT NOT NULL DEFAULT '',
    duration_sec INTEGER NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS local_tracks_recent ON local_tracks (added_at DESC, id DESC);

-- 外部内容表：索引不重复存正文，靠触发器与主表同步
CREATE VIRTUAL TABLE IF NOT EXISTS local_tracks_fts USING fts5(
    title,
    artist,
    album,
    content = 'local_tracks',
    content_rowid = 'rowid',
    tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS local_tracks_ai AFTER INSERT ON local_tracks BEGIN
    INSERT INTO local_tracks_fts (rowid, title, artist, album)
    VALUES (new.rowid, new.title, new.artist, new.album);
END;

CREATE TRIGGER IF NOT EXISTS local_tracks_ad AFTER DELETE ON local_tracks BEGIN
    INSERT INTO local_tracks_fts (local_tracks_fts, rowid, title, artist, album)
    VALUES ('delete', old.rowid, old.title, old.artist, old.album);
END;

CREATE TRIGGER IF NOT EXISTS local_tracks_au AFTER UPDATE ON local_tracks BEGIN
    INSERT INTO local_tracks_fts (local_tracks_fts, rowid, title, artist, album)
    VALUES ('delete', old.rowid, old.title, old.artist, old.album);
    INSERT INTO local_tracks_fts (rowid, title, artist, album)
    VALUES (new.rowid, new.title, new.artist, new.album);
END;
