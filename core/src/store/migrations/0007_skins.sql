-- 0007：用户导入的皮肤。
--
-- 设计取舍：
--  * **整份 ThemeSkin JSON 存库**：皮肤就是一份小文档（几 KB），单独建列既啰嗦又逼着
--    每次令牌组演进都写迁移；`document` 列保持原样，导出即分享；
--  * 可查询的只有 `id` / `name` / `author` / `version`（列表与去重需要）；
--  * **激活状态放 `meta` 表**（`skin.active`）：它是「当前选择」而不是皮肤自身的属性，
--    放在这里就不需要「只允许一行为真」的约束。

CREATE TABLE IF NOT EXISTS skins (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    author       TEXT NOT NULL,
    version      TEXT,
    document     TEXT NOT NULL,
    origin_kind  TEXT NOT NULL,
    origin_value TEXT NOT NULL,
    sha256       TEXT,
    installed_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS skins_recent ON skins (updated_at DESC, id ASC);
