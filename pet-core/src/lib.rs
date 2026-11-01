//! pet-core：**宠物系统的核心引擎**（不含 UI、不依赖音乐核心）。
//!
//! 边界（见 `docs/adr/0010-pet-core-crate.md`）：
//!
//! - **两个引擎**：`gently-core` 是音乐软件的数据处理引擎，`pet-core` 是宠物系统的核心引擎。
//!   两者都只被宿主拿来用（现在宿主是 Tauri + React），**互不依赖**——把宠物养成塞进音乐核心，
//!   等于把两个完全不同的领域强行耦合，后面既没法单独发布宠物，也没法换 UI。
//! - **UI 可替换**：这里没有任何渲染、窗口、事件的代码。宿主把 `Input` 喂进来、把 `Frame` 拿走画。
//!   因此将来换成别的 UI 框架（甚至独立成宠物应用）时，这个 crate 不用改。
//! - **数据独立**：自己的 SQLite 文件（宿主给目录），自己的 schema 与迁移；不碰音乐库。
//! - **确定性**：同样的 seed + 同样的 `Input` 序列 → 逐字节相同的 `Frame` 序列（可断言）。
//!
//! 当前阶段（M0，预开发）：状态机 + 规格校验 + 独立存储 + 跨会话资料（好感度/饱食度字段与 API 已就位，
//! 玩法数值与交互 UI 留到后续里程碑）。音乐软件仍是 1.x，宠物**不**出现在产品界面里。

pub mod base64;
pub mod checksum;
pub mod codex;
pub mod contract;
pub mod dispatch;
pub mod engine;
pub mod error;
pub mod profile;
pub mod sim;
pub mod spec;
pub mod version;
pub mod store;

pub use codex::{CodexManifest, CODEX_ANIMATIONS, CODEX_CELL_HEIGHT, CODEX_CELL_WIDTH, CODEX_COLUMNS, CODEX_ROWS};
pub use dispatch::dispatch;
pub use engine::{Engine, PetAtlasInput, MAX_ATLAS_BYTES};
pub use error::{PetError, PetErrorCode, PetResult};
pub use profile::{PetMood, PetProfile, PetProfileLimits};
pub use sim::{Frame, Input, Sim};
pub use error::PetErrorCode as PetCode;
pub use spec::{
    Action, Animation, AtlasLayout, Behavior, Condition, PetSpec, SpecLimits, MAX_ANIMATIONS,
    MAX_ATLAS_COLUMNS, MAX_ATLAS_ROWS, MAX_FRAMES_PER_ANIMATION, MAX_PACKAGE_BYTES,
    MAX_TEXT_KEY_LEN,
};
pub use store::PetStore;
pub use version::Version;

/// 宠物核心版本（与 Cargo.toml 一致）。
pub const PET_CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 宿主传给宠物的**只读**播放快照（与音乐软件的形状一致，但由宿主转换后传入；
/// 本 crate 不认识 `Track` 类型——那是音乐软件的领域模型）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlaybackHint {
    /// 是否正在播放
    pub playing: bool,
    /// 播放进度（毫秒）
    pub elapsed_ms: u32,
    /// 当前是否有歌词行（只给「有/没有」，不传歌词文本）
    pub lyric_active: bool,
    /// 当前曲目标识的哈希（用于「换歌反应」这类行为；不传歌名，避免宠物显示版权内容）
    pub track_hash: u64,
}




