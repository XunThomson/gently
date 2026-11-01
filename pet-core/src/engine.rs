//! 引擎：把存储、状态机与跨会话资料缝在一起（**宿主唯一入口**）。
//!
//! 宿主（现在 = Tauri 适配层，将来可以是任何 UI）只需要：
//! `Engine::open(root)` → `install(spec_json)` → `set_active(id)` → 反复
//! `tick(id, input, now_ms)` 拿 `Frame` 去画，用户交互时 `feed/touch`。
//!
//! 刻意**不**做的事：
//! - 不认识音乐软件的 `Track`/`AppPaths`/事件通道（宿主转成 `Input`/`PlaybackHint` 再喂进来）；
//! - 不跑线程、不读系统时钟（时间由宿主以 `now_ms` 传入，测试因此完全可复现）；
//! - 不做 UI 决策（气泡文案只给键，动画只给下标）。
//!
//! **单宠物**：音乐软件里同时只展示一只（`active_pet_id`）。存储与 API 都按「多只」设计，
//! 这样将来宠物独立成仓库时不需要迁移数据模型。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{PetError, PetResult};
use crate::profile::{PetProfile, PetProfileLimits};
use crate::sim::{Frame, Input, Sim};
use crate::spec::PetSpec;
use crate::store::PetStore;

/// 每推进多少帧把资料写回磁盘（写后置：既不每帧写盘，也不会丢太多）。
const PERSIST_EVERY_TICKS: u32 = 200;
/// 状态机的确定性种子：同一个宠物每次启动走同一条轨迹（避免「每次打开都不太一样」）。
const SIM_SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// 一只宠物在内存里的运行时（规格 + 状态机 + 资料缓存）。
struct Runtime {
    spec: PetSpec,
    sim: Sim,
    profile: PetProfile,
    ticks_since_save: u32,
}

/// 图集体积上限（与整包上限一致：8 MiB）
pub const MAX_ATLAS_BYTES: usize = crate::spec::MAX_PACKAGE_BYTES as usize;

/// 宠物图集输入（M2）：文件名 + 字节。
#[derive(Debug, Clone)]
pub struct PetAtlasInput {
    pub file: String,
    pub data: Vec<u8>,
}

impl PetAtlasInput {
    /// 校验并归一化文件名：纯文件名 + png/webp + 体积上限。
    pub fn validate(&self) -> PetResult<String> {
        let file = self.file.trim().to_string();
        if !crate::spec::is_plain_file_name(&file) {
            return Err(PetError::invalid_package(
                "图集文件名只能是包内的纯文件名（不允许路径分隔符或 ..）",
            ));
        }
        let lower = file.to_ascii_lowercase();
        if !(lower.ends_with(".png") || lower.ends_with(".webp")) {
            return Err(PetError::invalid_package(
                "图集只支持 png / webp（视频类素材耗电且成本高，暂不支持）",
            ));
        }
        if self.data.is_empty() {
            return Err(PetError::invalid_package("图集文件是空的"));
        }
        if self.data.len() > MAX_ATLAS_BYTES {
            return Err(PetError::limit_exceeded(format!(
                "图集超过上限（{} > {MAX_ATLAS_BYTES} 字节）",
                self.data.len()
            )));
        }
        Ok(file)
    }
}

/// 宠物引擎。
pub struct Engine {
    store: PetStore,
    limits: PetProfileLimits,
    runtimes: HashMap<String, Runtime>,
    /// 谁在出战（单宠物 UI 用；None = 还没选）
    active: Option<String>,
}

impl Engine {
    /// 打开引擎（目录由宿主给，例如 `<data>/pet`）。
    pub fn open(root: impl AsRef<Path>) -> PetResult<Self> {
        let store = PetStore::open(root)?;
        Self::from_store(store, PetProfileLimits::default())
    }

    /// 内存引擎（测试 / 无痕试玩）
    pub fn open_in_memory() -> PetResult<Self> {
        let store = PetStore::open_in_memory()?;
        Self::from_store(store, PetProfileLimits::default())
    }

    fn from_store(store: PetStore, limits: PetProfileLimits) -> PetResult<Self> {
        let active = store.active_pet_id()?;
        Ok(Self { store, limits, runtimes: HashMap::new(), active })
    }

    /// 数据目录（宿主诊断用）
    pub fn data_dir(&self) -> PathBuf {
        self.store.root().to_path_buf()
    }

    /// 宠物库文件路径
    pub fn db_path(&self) -> PathBuf {
        self.store.db_path()
    }

    /// schema 版本（迁移用）
    pub fn schema_version(&self) -> PetResult<i64> {
        self.store.schema_version()
    }

    /// 玩法数值（M0 只读；将来由设置页/宠物包覆盖）
    pub fn limits(&self) -> PetProfileLimits {
        self.limits
    }

    /// 安装（或覆盖）一个宠物包：校验规格 → 落库 → 领养资料。
    ///
    /// 覆盖安装**保留**已有资料（好感度/饱食度/时间戳），只更新规格与名字：
    /// 用户升级宠物包不该把养了很久的好感清零。
    pub fn install(&mut self, spec_json: &str, now_ms: u64) -> PetResult<PetSpec> {
        self.install_with_atlas(spec_json, None, now_ms)
    }

    /// 安装宠物包（可带图集素材）。
    ///
    /// 图集是**用户提供的不可信数据**，因此在这里一次性把关（M2）：
    /// - 文件名必须是**纯文件名**（与皮肤背景同一条规则：不允许路径）；
    /// - 只接受 png / webp；
    /// - 体积上限 `MAX_ATLAS_BYTES`（8 MiB，与整包上限一致）；
    /// - 素材落在 `<数据目录>/packages/<id>/<文件名>`，库里只记文件名（不记绝对路径，
    ///   这样整个数据目录搬家后仍然有效）。
    ///
    /// **两种格式都收**（M5）：我们自己的 `pet.json`，以及 Codex Pet v1 的
    /// `{id, displayName, spritesheetPath}`——后者由 `codex::CodexManifest` 补成完整规格。
    /// 判定与翻译都在核心里，宿主只管把 JSON 原文交进来。
    pub fn install_with_atlas(
        &mut self,
        spec_json: &str,
        atlas: Option<PetAtlasInput>,
        now_ms: u64,
    ) -> PetResult<PetSpec> {
        /* 规格本身也是不可信数据：先卡体积，再谈解析（512 KiB 足够 32 个动画 + 128 条行为） */
        if spec_json.len() > crate::spec::MAX_SPEC_BYTES {
            return Err(PetError::limit_exceeded(format!(
                "pet.json 超过上限（{} > {} 字节）",
                spec_json.len(),
                crate::spec::MAX_SPEC_BYTES
            )));
        }
        let spec = if crate::codex::CodexManifest::looks_like_codex(spec_json) {
            crate::codex::CodexManifest::normalize(spec_json)?
        } else {
            PetSpec::from_json(spec_json)?
        };
        let existing = self.store.load_pet(&spec.id)?;
        let profile = match existing {
            Some((_, mut profile)) => {
                profile.name = spec.name.clone();
                profile.updated_at = now_ms;
                profile.clamped(&self.limits)
            }
            None => PetProfile::new(&spec.id, &spec.name, now_ms),
        };

        if let Some(input) = &atlas {
            let file = input.validate()?;
            let dir = self.store.package_dir(&spec.id);
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join(&file), &input.data)?;
            self.store.set_atlas(&spec.id, &file)?;
            /* 记下校验和：以后读到不一样的内容，说明文件被改坏/换掉了，
               与其把坏图当成素材画出来，不如明确报错让渲染层退回程序化渲染 */
            self.store.set_meta(
                &atlas_checksum_key(&spec.id),
                &crate::checksum::fingerprint(&input.data),
            )?;
        }

        self.store.save_pet(&spec, &profile)?;
        // 重新领养后状态机重建（规格可能变了）
        self.runtimes.remove(&spec.id);
        if self.active.is_none() {
            self.active = Some(spec.id.clone());
            self.store.set_active_pet(&spec.id)?;
        }
        Ok(spec)
    }

    /// 已安装的宠物（规格 + 资料；界面用 `active` 决定展示哪只）
    pub fn list(&self) -> PetResult<Vec<(PetSpec, PetProfile)>> {
        self.store.list_pets()
    }

    /// 当前出战宠物 id
    pub fn active_pet(&self) -> Option<&str> {
        self.active.as_deref()
    }

    /// 切换出战宠物（**单宠物**：换一只就换掉前一只）
    pub fn set_active(&mut self, id: &str) -> PetResult<()> {
        if self.store.load_pet(id)?.is_none() {
            return Err(PetError::not_found(format!("这个宠物没有安装：{id}")));
        }
        self.active = Some(id.to_string());
        self.store.set_active_pet(id)
    }

    /// 读一只宠物的资料（含时间衰减与夹取，读出来就是「现在」的值）
    pub fn profile(&mut self, id: &str, now_ms: u64) -> PetResult<PetProfile> {
        let runtime = self.runtime_mut(id, now_ms)?;
        Ok(runtime.profile.clone())
    }

    /// 气泡文案键（界面用 i18n 解析；核心只回键，不提供文案）。
    ///
    /// 必须在 `tick` 之后调用（那时运行时已装载、文案表已建好）。
    pub fn text_key(&self, id: &str, index: u16) -> Option<String> {
        self.runtimes
            .get(id)
            .and_then(|runtime| runtime.sim.text_key(index))
            .map(str::to_string)
    }

    /// 推进一帧（宿主按自己的节拍调用；M0 约定 20 Hz）。
    pub fn tick(&mut self, id: &str, input: &Input, now_ms: u64) -> PetResult<Frame> {
        self.runtime_mut(id, now_ms)?;
        let limits = self.limits;
        let mut persist: Option<(PetSpec, PetProfile)> = None;

        let frame = {
            let runtime = self
                .runtimes
                .get_mut(id)
                .ok_or_else(|| PetError::internal("运行时丢失"))?;
            let frame = runtime.sim.tick(input, &runtime.profile);
            runtime.ticks_since_save = runtime.ticks_since_save.saturating_add(1);
            if runtime.ticks_since_save >= PERSIST_EVERY_TICKS {
                runtime.profile.updated_at = now_ms;
                runtime.profile = runtime.profile.clone().clamped(&limits);
                runtime.ticks_since_save = 0;
                persist = Some((runtime.spec.clone(), runtime.profile.clone()));
            }
            frame
        };

        // 写回放在借用结束之后：SQLite 调用不应跨越状态机的可变借用
        if let Some((spec, profile)) = persist {
            self.store.save_pet(&spec, &profile)?;
        }
        Ok(frame)
    }

    /// 喂食（跨会话状态：好感度上升、饱食度下降；冷却内拒绝）。
    pub fn feed(&mut self, id: &str, now_ms: u64) -> PetResult<PetProfile> {
        self.runtime_mut(id, now_ms)?;
        let limits = self.limits;
        let (spec, profile) = {
            let runtime = self
                .runtimes
                .get_mut(id)
                .ok_or_else(|| PetError::internal("运行时丢失"))?;
            let next = runtime.profile.feed(now_ms, &limits)?;
            runtime.profile = next.clamped(&limits);
            runtime.ticks_since_save = 0;
            (runtime.spec.clone(), runtime.profile.clone())
        };
        self.store.save_pet(&spec, &profile)?;
        Ok(profile)
    }

    /// 摸一下（冷却内静默忽略；不报错——摸两下不该弹错误）。
    pub fn touch(&mut self, id: &str, now_ms: u64) -> PetResult<PetProfile> {
        self.runtime_mut(id, now_ms)?;
        let limits = self.limits;
        let (spec, profile) = {
            let runtime = self
                .runtimes
                .get_mut(id)
                .ok_or_else(|| PetError::internal("运行时丢失"))?;
            let next = runtime.profile.touch(now_ms, &limits);
            runtime.profile = next.clamped(&limits);
            runtime.ticks_since_save = 0;
            (runtime.spec.clone(), runtime.profile.clone())
        };
        self.store.save_pet(&spec, &profile)?;
        Ok(profile)
    }

    /// 卸载宠物（连带资料与包内素材）。删的正好是出战宠物时，出战位置清空。
    pub fn remove(&mut self, id: &str) -> PetResult<bool> {
        self.runtimes.remove(id);
        let removed = self.store.delete_pet(id)?;
        if removed && self.active.as_deref() == Some(id) {
            self.active = None;
        }
        if removed {
            // 素材目录一并清掉：留着只会在数据目录里堆孤儿文件
            let dir = self.store.package_dir(id);
            if dir.is_dir() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            let _ = self.store.delete_meta(&atlas_checksum_key(id));
        }
        Ok(removed)
    }

    /// 读某只宠物的图集（M2）：返回 `(文件名, 字节)`；没有图集返回 `None`。
    ///
    /// 装的时候记过校验和：读到的内容对不上就报 `pet.io_error`（而不是把坏图当素材画出来）。
    pub fn atlas_of(&self, id: &str) -> PetResult<Option<(String, Vec<u8>)>> {
        let Some(file) = self.store.atlas_of(id)? else {
            return Ok(None);
        };
        let path = self.store.package_dir(id).join(&file);
        match std::fs::read(&path) {
            Ok(bytes) => {
                if let Some(expected) = self.store.get_meta(&atlas_checksum_key(id))? {
                    let actual = crate::checksum::fingerprint(&bytes);
                    if actual != expected {
                        return Err(PetError::io(format!(
                            "宠物图集校验失败（文件被改动或损坏）：预期 {expected}，实际 {actual}"
                        )));
                    }
                }
                Ok(Some((file, bytes)))
            }
            // 记录在但文件丢了（用户手删 / 迁移时漏了）：如实当「没有图集」，不让渲染层崩
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(PetError::io(format!("读取宠物图集失败：{err}"))),
        }
    }

    /// 把在内存里推进过的资料立即写回（宿主在退出/切宠前调用）。
    pub fn flush(&mut self) -> PetResult<()> {
        let ids: Vec<String> = self.runtimes.keys().cloned().collect();
        for id in ids {
            if let Some(runtime) = self.runtimes.get_mut(&id) {
                if runtime.ticks_since_save == 0 {
                    continue;
                }
                runtime.ticks_since_save = 0;
                let profile = runtime.profile.clone();
                let spec = runtime.spec.clone();
                self.store.save_pet(&spec, &profile)?;
            }
        }
        Ok(())
    }

    /// 取（必要时从库里装载）运行时，并**结算时间流逝**。
    ///
    /// 每次进入都结算一次（而不是只在装载时）：宠物可能被宿主长期挂着，
    /// 时钟在「喂食之后」走过几小时，衰减也应该发生。
    /// `updated_at` 在这里当作「上一次结算时间」用——结算后推到 `now_ms`，
    /// 否则每帧都会把同一段流逝重复算一遍。
    fn runtime_mut(&mut self, id: &str, now_ms: u64) -> PetResult<&mut Runtime> {
        if !self.runtimes.contains_key(id) {
            let Some((spec, profile)) = self.store.load_pet(id)? else {
                return Err(PetError::not_found(format!("这个宠物没有安装：{id}")));
            };
            let sim = Sim::with_limits(spec.clone(), self.limits, SIM_SEED);
            self.runtimes.insert(
                id.to_string(),
                Runtime { spec, sim, profile, ticks_since_save: 0 },
            );
        }

        let limits = self.limits;
        let runtime = self
            .runtimes
            .get_mut(id)
            .ok_or_else(|| PetError::new(crate::error::PetErrorCode::Internal, "运行时装载失败"))?;

        if now_ms > runtime.profile.updated_at {
            let settled = runtime.profile.decay(now_ms, &limits).clamped(&limits);
            let changed = settled.affection != runtime.profile.affection
                || settled.hunger != runtime.profile.hunger;
            runtime.profile = settled;
            runtime.profile.updated_at = now_ms;
            if changed {
                runtime.ticks_since_save = 0;
            }
        }
        Ok(runtime)
    }
}
/// meta 表里存图集校验和的键（按宠物 id 分组）
fn atlas_checksum_key(id: &str) -> String {
    format!("atlas_checksum:{id}")
}

