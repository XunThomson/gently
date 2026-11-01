//! 命令分发：契约名 → `Engine` 调用（**宿主只有一层薄壳**）。
//!
//! 为什么分发逻辑放在 pet-core 而不是 `src-tauri`：
//! - 与音乐核心**同构**（它也有一个「按契约名路由」的分发函数），宿主两边都只是「转成信封」；
//! - 可以被 `cargo test` 直接测（不需要起 Tauri）；
//! - 命令参数与返回形状是**契约**，必须和 `docs/contracts/pet-core-api.md` 一起演进。
//!
//! 约定：
//! - 参数一律 camelCase（前端直接传对象）；
//! - 时间由**调用方**给（`now_ms`）：宿主用系统时钟，测试用固定值，因此可复现；
//! - 未知命令回 `pet.invalid_argument`（宠物域没有「已登记未实现」的灰度阶段，
//!   清单里有的都实现了；不在清单里的说明调用方拼错了）。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::contract::is_known_command;
use crate::engine::Engine;
use crate::error::{PetError, PetResult};
use crate::sim::Input;
use crate::PlaybackHint;

/// 分发一条宠物命令。
pub fn dispatch(engine: &mut Engine, command: &str, params: Value, now_ms: u64) -> PetResult<Value> {
    if !is_known_command(command) {
        return Err(PetError::invalid_argument(format!(
            "宠物命令未登记：{command}（契约见 docs/contracts/pet-core-api.md）"
        )));
    }

    match command {
        "pet.state" => state(engine, now_ms),
        "pet.tick" => tick(engine, params, now_ms),
        "pet.install" => install(engine, params, now_ms),
        "pet.atlas" => atlas(engine, params),
        "pet.setActive" => set_active(engine, params),
        "pet.interact" => interact(engine, params, now_ms),
        "pet.remove" => remove(engine, params),
        other => Err(PetError::invalid_argument(format!("宠物命令未实现：{other}"))),
    }
}

/// `pet.state`：出战宠物 + 全部已安装宠物（规格 + 资料 + 派生心情）。
///
/// 读之前先**结算一次时间流逝**（`Engine::profile` 会做）：否则「关掉应用一夜没开」的宠物
/// 在面板上仍然显示不饿——那正是饿的表现该出现的时候。动物理上这是「读时结算」，
/// 每行一次小更新，宠物的数量级（个位数）完全可以接受。
fn state(engine: &mut Engine, now_ms: u64) -> PetResult<Value> {
    let active = engine.active_pet().map(str::to_string);
    let limits = engine.limits();
    let installed = engine.list()?;
    let mut pets = Vec::with_capacity(installed.len());
    for (spec, _) in installed {
        let profile = engine.profile(&spec.id, now_ms)?;
        let pet = json!({
            "id": spec.id,
            "name": spec.name,
            "version": spec.version,
            "active": Some(&spec.id) == active.as_ref(),
            "spec": spec,
            // 心情与「饿」都是**派生值**：库里只存好感与饿，避免两套状态互相矛盾
            "mood": profile.mood(&limits).as_str(),
            "hungry": profile.is_hungry(&limits),
            "profile": profile,
        });
        pets.push(pet);
    }
    Ok(json!({
        "active": active,
        "pets": pets,
        // 数据目录与 schema 版本：诊断页/设置页展示用，也方便排查「宠物数据到底在哪」
        "dataDir": engine.data_dir().to_string_lossy().replace('\\', "/"),
        "dbPath": engine.db_path().to_string_lossy().replace('\\', "/"),
        "schemaVersion": engine.schema_version()?,
        // 核心版本：界面上要能回答「这个包要求的核心版本装得上吗」
        "coreVersion": crate::PET_CORE_VERSION,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TickParams {
    pet_id: String,
    dt_ms: u32,
    #[serde(default)]
    playing: bool,
    #[serde(default)]
    elapsed_ms: u32,
    #[serde(default)]
    lyric_active: bool,
    #[serde(default)]
    track_hash: u64,
    #[serde(default)]
    pointer_x: Option<i32>,
    #[serde(default)]
    pointer_y: Option<i32>,
    #[serde(default)]
    clicked: bool,
    /// 指针相对宠物的方向（0..16，0 = 正上、顺时针；None = 没在看）
    #[serde(default)]
    look_dir: Option<u8>,
    /// 正在往哪边走（-1 左 / 0 没走 / 1 右；None = 没在走）
    #[serde(default)]
    walk_dir: Option<i8>,
}

/// `pet.tick`：推进一步，回一帧（`Frame` 直接序列化）。
fn tick(engine: &mut Engine, params: Value, now_ms: u64) -> PetResult<Value> {
    let params: TickParams = parse(params)?;
    let pointer = match (params.pointer_x, params.pointer_y) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    };
    let input = Input {
        dt_ms: params.dt_ms,
        playback: PlaybackHint {
            playing: params.playing,
            elapsed_ms: params.elapsed_ms,
            lyric_active: params.lyric_active,
            track_hash: params.track_hash,
        },
        pointer,
        clicked: params.clicked,
        look_dir: params.look_dir.map(|dir| dir % 16),
        walk_dir: params.walk_dir.map(|dir| dir.signum()),
    };
    let frame = engine.tick(&params.pet_id, &input, now_ms)?;
    // 气泡给的是**文案表下标**：宿主既要拿到 key 也要拿到号，才能做 i18n
    let bubble = frame.bubble.and_then(|index| {
        engine
            .text_key(&params.pet_id, index)
            .map(|key| json!({ "index": index, "key": key }))
    });
    Ok(json!({ "frame": frame, "bubble": bubble }))
}

#[derive(Debug, Deserialize)]
struct InstallParams {
    /// `pet.json` 原文（字符串：解析与校验都在核心，前端不预解析）
    spec: String,
    /// 可选的图集素材（M2）：文件名 + base64 字节
    #[serde(default)]
    atlas: Option<AtlasParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AtlasParams {
    file: String,
    /// base64（不压缩）：Tauri 命令参数是 JSON，直接传字节不现实
    #[serde(default)]
    data_base64: String,
}

/// `pet.install`：校验并安装（覆盖安装保留资料；带图集时落盘到 `packages/<id>/`）。
fn install(engine: &mut Engine, params: Value, now_ms: u64) -> PetResult<Value> {
    let params: InstallParams = parse(params)?;
    let atlas = match params.atlas {
        Some(atlas) => {
            let data = crate::base64::decode(&atlas.data_base64)?;
            Some(crate::PetAtlasInput { file: atlas.file, data })
        }
        None => None,
    };
    let spec = engine.install_with_atlas(&params.spec, atlas, now_ms)?;
    let has_atlas = engine.atlas_of(&spec.id)?.is_some();
    Ok(json!({ "spec": spec, "active": engine.active_pet(), "hasAtlas": has_atlas }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AtlasIdParams {
    id: String,
}

/// `pet.atlas{id}`：取某只宠物的图集（文件名 + base64 字节）；没有图集回 `null`。
///
/// 为什么走 base64 而不是回环 URL：宠物引擎**不依赖**音乐核心的媒体代理（ADR 0010），
/// 图片又只有一张、上限 8 MiB，直传比再开一条代理链路简单得多。
fn atlas(engine: &Engine, params: Value) -> PetResult<Value> {
    let params: AtlasIdParams = parse(params)?;
    match engine.atlas_of(&params.id)? {
        Some((file, bytes)) => Ok(json!({ "file": file, "dataBase64": encode_base64(&bytes) })),
        None => Ok(Value::Null),
    }
}

/** 标准 base64 编码（只用于把图集送回前端；实现放这里，避免和 dispatch 的语义混在一起） */
fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdParams {
    id: String,
}

fn set_active(engine: &mut Engine, params: Value) -> PetResult<Value> {
    let params: IdParams = parse(params)?;
    engine.set_active(&params.id)?;
    Ok(json!({ "active": engine.active_pet() }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InteractParams {
    id: String,
    /// `feed` / `touch`
    kind: String,
}

/// `pet.interact`：喂食（有冷却，冷却内报错）或摸一下（冷却内静默）。
fn interact(engine: &mut Engine, params: Value, now_ms: u64) -> PetResult<Value> {
    let params: InteractParams = parse(params)?;
    let limits = engine.limits();
    let profile = match params.kind.as_str() {
        "feed" => engine.feed(&params.id, now_ms)?,
        "touch" => engine.touch(&params.id, now_ms)?,
        other => {
            return Err(PetError::invalid_argument(format!(
                "未知的互动类型：{other}（只支持 feed / touch）"
            )))
        }
    };
    Ok(json!({
        "profile": profile,
        // 互动后立刻带回派生心情，界面不必再问一次
        "mood": profile.mood(&limits).as_str(),
        "hungry": profile.is_hungry(&limits),
    }))
}

fn remove(engine: &mut Engine, params: Value) -> PetResult<Value> {
    let params: IdParams = parse(params)?;
    let removed = engine.remove(&params.id)?;
    if !removed {
        return Err(PetError::not_found(format!("这个宠物没有安装：{}", params.id)));
    }
    Ok(json!({ "removed": true, "active": engine.active_pet() }))
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> PetResult<T> {
    serde_json::from_value(params)
        .map_err(|err| PetError::invalid_argument(format!("参数不合法：{err}")))
}



