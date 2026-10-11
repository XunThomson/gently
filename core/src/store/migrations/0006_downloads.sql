-- 0006：下载任务。
--
-- 设计取舍：
--  * **任务与文件分离**：库记录状态与进度，文件落在 `downloads/`（可用 `dir` 指定）；
--    「移除任务」缺省只删记录（已完成的任务文件是用户的资产），只有 `deleteFile` 才动文件；
--  * **未完成的任务可续传**：`received` 落库，重启后 `paused` 的任务能接着下；
--  * `status` 用字符串而不是整数：诊断页与日志里直接可读，代价可以忽略。

CREATE TABLE IF NOT EXISTS download_tasks (
    id         TEXT PRIMARY KEY,
    ref        TEXT NOT NULL,
    source     TEXT NOT NULL,
    quality    TEXT NOT NULL,
    -- 曲目快照：插件被卸载后下载列表仍能显示歌名
    track      TEXT NOT NULL,
    status     TEXT NOT NULL,
    received   INTEGER NOT NULL DEFAULT 0,
    total      INTEGER,
    path       TEXT,
    error      TEXT,
    -- 最近一次测得的下载速度（字节/秒），用于 sizeText 之外的「1.2 MB/s」
    speed      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS download_tasks_recent ON download_tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS download_tasks_status ON download_tasks (status);
