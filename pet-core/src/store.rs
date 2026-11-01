//! 宠物自己的存储：**独立的 SQLite 文件**（不与音乐库共表、共迁移）。
//!
//! 为什么独立：宠物是另一个领域（ADR 0010）。共用音乐库会带来三个具体问题——
//! 1. 迁移版本互相牵制：音乐库加一列要连带宠物一起发版；
//! 2. 拆不出去：宠物将来独立成仓库/独立应用时，得先把数据从音乐库里搬出来；
//! 3. 耦合权限：宠物只需要读写自己的资料，没必要拿到音乐库的句柄。
//!
//! 目录由**宿主**给（`Engine::open(root)`）：本 crate 不认识音乐软件的数据目录规则，
//! 因此既能在音乐软件里用，也能独立运行。当前宿主传的是 `<data>/pet/`。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{PetError, PetResult};
use crate::profile::PetProfile;
use crate::spec::PetSpec;

/// 宠物库文件名（放在宿主给的目录里）
pub const PET_DB_FILE: &str = "pet.db";
/// 当前 schema 版本（加字段/加表时 +1 并补一条迁移）
pub const SCHEMA_VERSION: i64 = 1;

/// 宠物存储：一个连接 + 一套自己的迁移。
pub struct PetStore {
    conn: Connection,
    root: PathBuf,
}

impl PetStore {
    /// 打开（不存在则创建）宿主给定目录下的宠物库。
    pub fn open(root: impl AsRef<Path>) -> PetResult<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(&root)?;
        let db = root.join(PET_DB_FILE);
        let conn = Connection::open(&db)?;
        // WAL：写入不阻塞读取；宠物是「高频小写 + 偶尔读」的形态
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let store = Self { conn, root };
        store.migrate()?;
        Ok(store)
    }

    /// 内存库（测试与「无痕试玩」用）
    pub fn open_in_memory() -> PetResult<Self> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn, root: PathBuf::from(":memory:") };
        store.migrate()?;
        Ok(store)
    }

    /// 数据目录（宿主诊断页展示用）
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 数据库文件路径
    pub fn db_path(&self) -> PathBuf {
        if self.root.as_os_str() == ":memory:" {
            self.root.clone()
        } else {
            self.root.join(PET_DB_FILE)
        }
    }

    /// 建表 + 记录版本；重复调用是幂等的。
    fn migrate(&self) -> PetResult<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pets (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                spec_json       TEXT NOT NULL,
                affection       INTEGER NOT NULL,
                hunger          INTEGER NOT NULL,
                last_fed_at     INTEGER NOT NULL,
                last_touched_at INTEGER NOT NULL,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                state_json      TEXT NOT NULL DEFAULT '{}'
            );
            -- 宠物包自带的图集（M2）：只记**包内纯文件名**，素材放在 packages/<id>/ 下
            CREATE TABLE IF NOT EXISTS atlas (
                pet_id TEXT PRIMARY KEY,
                file   TEXT NOT NULL
            );
            "#,
        )?;
        let current: Option<String> = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| row.get(0))
            .optional()?;
        if current.is_none() {
            self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        }
        Ok(())
    }

    /// 库里的 schema 版本
    pub fn schema_version(&self) -> PetResult<i64> {
        let value = self.get_meta("schema_version")?.unwrap_or_else(|| "0".to_string());
        Ok(value.parse::<i64>().unwrap_or(0))
    }

    pub fn get_meta(&self, key: &str) -> PetResult<Option<String>> {
        let value = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| row.get(0))
            .optional()?;
        Ok(value)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> PetResult<()> {
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 删一条 meta（卸载宠物时清掉它的图集校验和）
    pub fn delete_meta(&self, key: &str) -> PetResult<()> {
        self.conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// 当前「出战」的宠物 id（**单宠物**的 UI 用它；库里可以有多只，为将来独立仓库预留）
    pub fn active_pet_id(&self) -> PetResult<Option<String>> {
        self.get_meta("active_pet_id")
    }

    pub fn set_active_pet(&self, id: &str) -> PetResult<()> {
        self.set_meta("active_pet_id", id)
    }

    /// 写入（或覆盖）一只宠物：规格 + 资料一起存。
    pub fn save_pet(&self, spec: &PetSpec, profile: &PetProfile) -> PetResult<()> {
        let spec_json = serde_json::to_string(spec).map_err(|err| {
            PetError::invalid_package(format!("宠物规格序列化失败：{err}"))
        })?;
        self.conn.execute(
            "INSERT INTO pets(
                id, name, spec_json, affection, hunger, last_fed_at, last_touched_at,
                created_at, updated_at, state_json
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                spec_json = excluded.spec_json,
                affection = excluded.affection,
                hunger = excluded.hunger,
                last_fed_at = excluded.last_fed_at,
                last_touched_at = excluded.last_touched_at,
                updated_at = excluded.updated_at,
                state_json = excluded.state_json",
            params![
                spec.id,
                spec.name,
                spec_json,
                profile.affection,
                profile.hunger,
                profile.last_fed_at as i64,
                profile.last_touched_at as i64,
                profile.created_at as i64,
                profile.updated_at as i64,
                profile.state_json,
            ],
        )?;
        Ok(())
    }

    /// 读取一只宠物（规格 + 资料）
    pub fn load_pet(&self, id: &str) -> PetResult<Option<(PetSpec, PetProfile)>> {
        let row = self
            .conn
            .query_row(
                "SELECT spec_json, name, affection, hunger, last_fed_at, last_touched_at,
                        created_at, updated_at, state_json
                 FROM pets WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i32>(2)?,
                        row.get::<_, i32>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()?;
        let Some((spec_json, name, affection, hunger, fed, touched, created, updated, state)) = row
        else {
            return Ok(None);
        };
        let spec: PetSpec = serde_json::from_str(&spec_json)?;
        let profile = PetProfile {
            id: id.to_string(),
            name,
            affection,
            hunger,
            last_fed_at: fed.max(0) as u64,
            last_touched_at: touched.max(0) as u64,
            created_at: created.max(0) as u64,
            updated_at: updated.max(0) as u64,
            state_json: state,
        };
        Ok(Some((spec, profile)))
    }

    /// 列出全部宠物（按领养时间，稳定顺序）
    pub fn list_pets(&self) -> PetResult<Vec<(PetSpec, PetProfile)>> {
        let mut statement = self.conn.prepare("SELECT id FROM pets ORDER BY created_at ASC, id ASC")?;
        let ids: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(pet) = self.load_pet(&id)? {
                out.push(pet);
            }
        }
        Ok(out)
    }

    /// 删除一只宠物（连带它的资料与图集记录）
    pub fn delete_pet(&self, id: &str) -> PetResult<bool> {
        let removed = self.conn.execute("DELETE FROM pets WHERE id = ?1", params![id])?;
        self.conn.execute("DELETE FROM atlas WHERE pet_id = ?1", params![id])?;
        if self.active_pet_id()?.as_deref() == Some(id) {
            self.conn.execute("DELETE FROM meta WHERE key = 'active_pet_id'", [])?;
        }
        Ok(removed > 0)
    }

    /// 记录某只宠物的图集文件名（**包内纯文件名**，素材在 `packages/<id>/` 下）
    pub fn set_atlas(&self, id: &str, file: &str) -> PetResult<()> {
        self.conn.execute(
            "INSERT INTO atlas(pet_id, file) VALUES(?1, ?2)
             ON CONFLICT(pet_id) DO UPDATE SET file = excluded.file",
            params![id, file],
        )?;
        Ok(())
    }

    /// 读某只宠物的图集文件名（没有图集返回 `None`）
    pub fn atlas_of(&self, id: &str) -> PetResult<Option<String>> {
        let file = self
            .conn
            .query_row("SELECT file FROM atlas WHERE pet_id = ?1", params![id], |row| row.get(0))
            .optional()?;
        Ok(file)
    }

    /// 宠物包的素材目录：`<root>/packages/<id>/`（打包导出/备份时整目录带走）
    pub fn package_dir(&self, id: &str) -> PathBuf {
        self.root.join("packages").join(id)
    }
}

