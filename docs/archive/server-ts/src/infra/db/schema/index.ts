/**
 * 数据库表结构（Drizzle schema）。
 *
 * 当前为**空**：本阶段只搭基础设施，业务表（用户 / 收藏 / 歌单 / 播放记录 /
 * 插件配置 / 皮肤）随业务实现一起加进来，每张表一个文件：
 *
 * ```
 * schema/
 * ├── users.ts        users, user_credentials
 * ├── library.ts      favorites, playlists, playlist_tracks, play_history
 * ├── plugins.ts      plugin_installs, plugin_configs
 * ├── downloads.ts    download_tasks
 * ├── skins.ts        skins, user_skins
 * └── index.ts        ← 在这里 re-export，供 drizzle-kit 收集
 * ```
 *
 * 约定：
 *  - 主键统一 `uuid`（默认 `gen_random_uuid()`），避免自增 id 在多源合并时冲突；
 *  - 统一带 `created_at` / `updated_at`（`timestamptz`，默认 `now()`）；
 *  - 需要按时间游标分页的列必须建索引，与 `http/pagination.ts` 的游标键对应。
 */

export const schemaPlaceholder = {} as const;
