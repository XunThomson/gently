//! **Codex Pet v1 包兼容层**：把「别人的宠物包」翻译成我们自己的 `PetSpec`。
//!
//! 为什么做这一层：Codex Pet 是社区已经在用的宠物格式（`pet.json` + `spritesheet.webp`，
//! 8 列 × 9 行、每格 192×208、未使用的格子必须全透明），社区里有几百只现成的宠物。
//! 我们的格式更啰嗦（作者要自己声明 `animations` / `behaviors`），但能力更强；
//! 两边的**图集几何其实完全一样**（都是 192×208 的格子），所以「导入」只是**补上没写的那部分**：
//! 9 个动作的名字、帧数、时长、默认行为表——这些在 Codex 那边是运行时约定，包里不写。
//!
//! 边界（故意不做的事）：
//! - **不内置、不推荐、不预置任何第三方宠物**（ADR 0005）：只在用户自己提供文件时解析；
//! - **不联网**：不下载、不校验远端清单（他们那边的 SHA-256 校验是它们安装器的事）；
//! - **不接受 v2（8×11，16 个 look 方向）**：我们的引擎还没有「看向哪里」这个输入，
//!   假装支持只会画错——宁可给一条可读的错误。

use serde::Deserialize;

use crate::error::{PetError, PetResult};
use crate::spec::{Animation, AtlasLayout, Behavior, Condition, Action, Motion, PetSpec};

/// Codex Pet v1 的图集几何：8 列 × 9 行，每格 192×208
pub const CODEX_CELL_WIDTH: u32 = 192;
pub const CODEX_CELL_HEIGHT: u32 = 208;
pub const CODEX_COLUMNS: u32 = 8;
/// v1 是 9 行（v2 是 11 行：多两行 look 方向）
pub const CODEX_ROWS: u32 = 9;
/// v2 是 11 行：第 9、10 行是 16 个 look 方向
pub const CODEX_V2_ROWS: u32 = 11;

/// v1 的 9 个动作，**行序就是约定**（第 0 行 = idle，第 1 行 = 向左跑 …）
/// 帧数来自社区图集的实际占用（见 `docs/pet-package.md` §兼容 Codex Pet）：
/// 未使用的格子是全透明的，所以「一行里用了多少格」就是该动作的帧数。
pub const CODEX_ANIMATIONS: [(&str, usize, u32); 9] = [
    ("idle", 6, 240),
    ("runLeft", 8, 140),
    ("runRight", 8, 140),
    ("wave", 4, 170),
    ("jump", 5, 150),
    ("fail", 8, 220),
    ("wait", 6, 240),
    ("run", 6, 130),
    ("inspect", 6, 200),
];

/// Codex 包的 `pet.json`（只取我们认识的字段；其余忽略）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexManifest {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    /// 图集文件名（纯文件名）
    #[serde(default)]
    pub spritesheet_path: String,
    /// 1 / 缺省 = 9 行；2 = 11 行（含 16 个 look 方向）
    #[serde(default)]
    pub sprite_version_number: u32,
    #[serde(default)]
    pub kind: String,
}

impl CodexManifest {
    /// JSON 是不是 Codex 包：靠 `spritesheetPath` 认（我们的格式没有这个字段）
    pub fn looks_like_codex(text: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .map(|value| value.get("spritesheetPath").is_some())
            .unwrap_or(false)
    }

    /// 解析并翻译成 `PetSpec`（会走一遍我们自己的校验）
    pub fn normalize(text: &str) -> PetResult<PetSpec> {
        let manifest: CodexManifest = serde_json::from_str(text)?;
        if manifest.spritesheet_path.trim().is_empty() {
            return Err(PetError::invalid_package("Codex 宠物包缺少 spritesheetPath"));
        }
        if !crate::spec::is_plain_file_name(&manifest.spritesheet_path) {
            return Err(PetError::invalid_package(
                "spritesheetPath 只能是包内的纯文件名（不允许路径分隔符或 ..）",
            ));
        }
        let version = if manifest.sprite_version_number == 0 {
            1
        } else {
            manifest.sprite_version_number
        };
        if version > 2 {
            return Err(PetError::invalid_package(format!(
                "Codex 宠物包格式版本 {version} 太新：本核心只认 v1（8×9）与 v2（8×11，含 16 个 look 方向）"
            )));
        }
        /* v2 在后两行放了 16 个 look 方向（0 = 正上、顺时针），我们按 lookRows 声明 */
        let (rows, look_rows) = if version >= 2 {
            (CODEX_V2_ROWS, Some([9, 10]))
        } else {
            (CODEX_ROWS, None)
        };

        let name = if manifest.display_name.trim().is_empty() {
            manifest.id.clone()
        } else {
            manifest.display_name.clone()
        };
        let animations: Vec<Animation> = CODEX_ANIMATIONS
            .iter()
            .enumerate()
            .map(|(row, (name, frames, frame_ms))| Animation {
                name: (*name).to_string(),
                frames: *frames,
                frame_ms: *frame_ms,
                r#loop: true,
                row: Some(row as u32),
                fit: None,
                /* Codex 的 9 个动作里只有向左/向右跑能位移；其余（待机/挥手/跳/失败/
                   等待/播放/查看）一律不许平移（R139）。 */
                motion: Some(if *name == "runLeft" || *name == "runRight" {
                    Motion::Walk
                } else {
                    Motion::None
                }),
            })
            .collect();

        let spec = PetSpec {
            id: manifest.id,
            name,
            /* 版本：Codex 包的 pet.json 没有语义化版本，用格式版本占位（内置宠物的自动升级只看 id） */
            version: format!("1.0.{version}"),
            author: String::new(),
            atlas: manifest.spritesheet_path,
            animations,
            behaviors: default_behaviors(),
            atlas_layout: Some(AtlasLayout {
                frame_width: CODEX_CELL_WIDTH,
                frame_height: CODEX_CELL_HEIGHT,
                columns: CODEX_COLUMNS,
                rows,
            }),
            look_rows,
            min_pet_core_version: String::new(),
        };
        spec.validate()?;
        Ok(spec)
    }
}

/// 默认行为表：与内置宠物同构（Codex 包不写行为，我们用一套通用规则驱动它）
fn default_behaviors() -> Vec<Behavior> {
    let behavior = |when: Condition, then: Action, cooldown_ms: u32| Behavior {
        when,
        then,
        cooldown_ms,
    };
    vec![
        behavior(Condition::Hungry, Action::Play { interrupt: false, animation: "fail".into() }, 1_200),
        behavior(
            Condition::Hungry,
            Action::Say { text_key: "pet.bubble.hungry".into() },
            60_000,
        ),
        behavior(Condition::Clicked, Action::Play { interrupt: true, animation: "jump".into() }, 400),
        behavior(
            Condition::Clicked,
            Action::Say { text_key: "pet.bubble.petted".into() },
            400,
        ),
        /* 走动：宿主在动窗口，包只声明「往左走演什么、往右走演什么」
           （Codex v1/v2 都带 runLeft / runRight 两行，所以默认表里直接用） */
        behavior(Condition::Walking { dir: -1 }, Action::Play { interrupt: false, animation: "runLeft".into() }, 200),
        behavior(Condition::Walking { dir: 1 }, Action::Play { interrupt: false, animation: "runRight".into() }, 200),
        behavior(Condition::TrackChanged, Action::Play { interrupt: true, animation: "inspect".into() }, 3_000),
        behavior(Condition::Playing, Action::Play { interrupt: false, animation: "run".into() }, 6_000),
        behavior(Condition::PointerNear, Action::Play { interrupt: false, animation: "wave".into() }, 2_500),
        behavior(Condition::Idle, Action::Play { interrupt: false, animation: "idle".into() }, 1_200),
        behavior(
            Condition::Idle,
            Action::Say { text_key: "pet.bubble.idle".into() },
            60_000,
        ),
    ]
}




