-- 0003：订阅源（社区仓库索引）。
--
-- 只存「订阅元信息」；索引原文缓存写在 <data>/subscriptions/<id>.json，
-- 好处是断网时仍能列出可安装条目（缓存文件可直接查看/删除）。

CREATE TABLE IF NOT EXISTS subscriptions (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    url          TEXT NOT NULL,
    -- 最近一次成功刷新的时间与条目数；失败时保留旧值并记录 error
    updated_at   INTEGER,
    count        INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_url ON subscriptions (url);
