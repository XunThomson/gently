-- 0001：M0 的库结构。
--
-- 只建立「元信息」表，用来验证迁移链路、事务与 PRAGMA 是否按 ADR-0004 生效。
-- 业务表（favorites / playlists / play_history / local_tracks(FTS5) / plugin_state /
-- plugin_config / download_tasks / skins / subscriptions）随 M3 以 0002+ 追加，
-- 不在 M0 假装存在。

CREATE TABLE IF NOT EXISTS meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
