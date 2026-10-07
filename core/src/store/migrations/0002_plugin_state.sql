-- 0002：插件状态与配置。
--
-- 设计取舍：
--  * **清单整体存 JSON**（`manifest` 列）+ 少量可查询/排序的列。清单格式会演进
--    （M1b 会加运行时探测结果），把字段逐个建列会逼着每次演进都写迁移；
--  * **插件文件不存库**：`plugins/<id>/` 是文件的事实来源，库只记录状态与来源；
--  * `sha256` 用于「更新前后是否变化」的比对与用户提示，**不是**安全验签。

CREATE TABLE IF NOT EXISTS plugin_state (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    -- 数值越小越优先，决定 playback.resolve 的候选回退顺序
    priority     INTEGER NOT NULL DEFAULT 100,
    origin_kind  TEXT NOT NULL,
    origin_value TEXT NOT NULL,
    sha256       TEXT,
    manifest     TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plugin_state_order ON plugin_state (priority, name);

CREATE TABLE IF NOT EXISTS plugin_config (
    plugin_id  TEXT PRIMARY KEY,
    values_json TEXT NOT NULL,
    revision   INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (plugin_id) REFERENCES plugin_state (id) ON DELETE CASCADE
);
