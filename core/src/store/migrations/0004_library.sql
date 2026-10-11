-- 0004：本机库（收藏 / 歌单 / 播放历史）。
--
-- 设计取舍：
--  * **曲目快照存 JSON**（`track` 列）：插件可能被卸载、被禁用或接口变化，
--    本机库必须能独立列出条目——列一个歌单不该依赖任何插件在线；
--  * **引用 `source:trackId` 是去重键**：收藏与历史按 ref 归并，快照随最新一次写入更新；
--  * **歌单曲目单独一表并保留 `position`**：顺序是用户数据，不能用时间戳代替；
--  * **游标分页**用 `(时间戳, 主键)` 复合游标：时间戳会撞车，单列游标会漏行。

CREATE TABLE IF NOT EXISTS favorites (
    ref        TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    track      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS favorites_recent ON favorites (created_at DESC, ref DESC);

CREATE TABLE IF NOT EXISTS playlists (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    position    INTEGER NOT NULL,
    ref         TEXT NOT NULL,
    source      TEXT NOT NULL,
    track       TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position),
    FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS play_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ref        TEXT NOT NULL,
    source     TEXT NOT NULL,
    track      TEXT NOT NULL,
    played_sec INTEGER NOT NULL DEFAULT 0,
    completed  INTEGER NOT NULL DEFAULT 0,
    played_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS play_history_recent ON play_history (played_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS play_history_ref ON play_history (ref, played_at DESC);
