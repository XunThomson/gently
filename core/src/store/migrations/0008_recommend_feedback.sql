-- 0008：推荐反馈。
--
-- 设计取舍：
--  * 反馈是**弱信号**：它不改变曲库，只影响下一次打分，因此单独一张表（append-only），
--    不像收藏那样需要唯一约束；
--  * `action` 用字符串（play / skip / like / unlike / complete），与契约一致，
--    诊断页与日志里直接可读；
--  * `progress` 是 0~1 的播放进度：区分「刚点开就跳过」与「听完了」——
--    两者对画像的意义完全不同，缺了它 skip 只能当噪音。

CREATE TABLE IF NOT EXISTS recommend_feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ref        TEXT NOT NULL,
    source     TEXT NOT NULL,
    action     TEXT NOT NULL,
    progress   REAL,
    -- 曲目快照：插件被卸载后反馈仍然可解释（标签/歌手是打分的依据）
    track      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS recommend_feedback_recent ON recommend_feedback (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS recommend_feedback_ref ON recommend_feedback (ref, created_at DESC);
