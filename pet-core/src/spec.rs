//! 宠物包规格（`pet.json`）：**数据，不是代码**。
//!
//! 与插件（QuickJS 沙箱）刻意区分开：
//! - 宠物只会「画」和「做几个固定动作」，因此规格里只有动画表与行为表；
//! - 行为是 `Condition → Action` 的**有限枚举**，没有表达式求值、没有脚本；
//! - 校验在上限内进行（动画数 / 帧数 / 名字长度 / 包体大小），坏包给出可读原因。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::error::{PetError, PetResult};
use crate::version::Version;

/// 一个宠物包最多多少个动画
pub const MAX_ANIMATIONS: usize = 32;
/// 单个动画最多多少帧
pub const MAX_FRAMES_PER_ANIMATION: usize = 512;
/// 宠物包（素材 + json）的总体积上限：8 MiB
pub const MAX_PACKAGE_BYTES: u64 = 8 * 1024 * 1024;
/// 气泡文案键的长度上限
pub const MAX_TEXT_KEY_LEN: usize = 64;
/// 网格图集最多多少列 / 行（防呆上限，不是能力上限）
pub const MAX_ATLAS_COLUMNS: u32 = 64;
/// 网格图集最多多少行
pub const MAX_ATLAS_ROWS: u32 = 64;
/// `pet.json` 原文的大小上限（512 KiB）：规格是数据不是代码，写得再多也不该超过这个量级
pub const MAX_SPEC_BYTES: usize = 512 * 1024;
/// 动画显示适配的缩放范围（1.0 = 原样）
pub const MIN_FIT_SCALE: f32 = 0.25;
/// 动画显示适配的缩放范围
pub const MAX_FIT_SCALE: f32 = 2.0;
/// 没有网格布局时，fit 偏移的兜底上限（原图像素）
pub const MAX_FIT_OFFSET: i32 = 1024;

/// 规格上限（随包一起存，便于将来按包校验；M0 只用默认值）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecLimits {
    pub max_animations: usize,
    pub max_frames: usize,
    pub max_package_bytes: u64,
}

impl Default for SpecLimits {
    fn default() -> Self {
        Self {
            max_animations: MAX_ANIMATIONS,
            max_frames: MAX_FRAMES_PER_ANIMATION,
            max_package_bytes: MAX_PACKAGE_BYTES,
        }
    }
}

/// 一个动画的**显示适配**：解决「同一张图集里，不同行的角色画得大小不一」。
///
/// 为什么需要它：素材常常是分几批画的（或 AI 生成的），各行角色的实际比例能差 20%，
/// 于是「待机 → 跑」时宠物会突然变大。渲染层按这里的 `scale` 把整行等比缩放、按
/// `offsetX/offsetY` 微调，切动画时角色视觉尺寸就一致了。
///
/// `scale` 是**相对整格**的倍数（1.0 = 不缩放），偏移单位是**原图像素**。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationFit {
    #[serde(default = "AnimationFit::one")]
    pub scale: f32,
    #[serde(default)]
    pub offset_x: i32,
    #[serde(default)]
    pub offset_y: i32,
}

impl AnimationFit {
    fn one() -> f32 {
        1.0
    }
}

impl Default for AnimationFit {
    fn default() -> Self {
        Self { scale: 1.0, offset_x: 0, offset_y: 0 }
    }
}

/// 动画允许的**位移能力**（R139）。
///
/// 用户反馈：宠物在「坐下 / 饿 / 点击反应」这类非走路动画播放时，窗口仍会被宿主平移，
/// 看起来像在地面上滑行。能力必须由动画自己声明——**不能靠动画名字判断**
/// （动画名是自由字符串，第三方包可以叫任何名字）。
///
/// 兼容规则（写在契约里）：
/// - 一个动画都没声明 `motion` → 整包按 legacy 处理，全部视为 `Walk`（旧包行为不变）；
/// - 只要有任一动画声明了 → 严格模式：未声明 = `None`（作者不必逐个补）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Motion {
    /// 不许位移（坐下 / 跳 / 失败 / 看向……）
    None,
    /// 可以水平走动
    Walk,
    /// 可以贴边爬行（预留；宿主尚未实现）
    Crawl,
}

impl Default for Motion {
    fn default() -> Self {
        Self::None
    }
}

/// 一个动画：名字 + 帧数 + 每帧时长 + 是否循环
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    pub name: String,
    pub frames: usize,
    pub frame_ms: u32,
    #[serde(default)]
    pub r#loop: bool,
    /// 网格图集里的行号（0 起）。**只在有 `atlasLayout` 时有效**；不写则按声明顺序取行。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<u32>,
    /// 这一行的显示适配（可选）：不写就是原样画
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<AnimationFit>,
    /// 这一行动画允许的位移能力（R139；不写见 `Motion` 的兼容规则）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion: Option<Motion>,
}

/// 网格图集（多行 sprite sheet）：每格 `frameWidth × frameHeight`，一行一个动画。
///
/// 与「单行帧条」的区别：帧条靠**总帧数**等分整图，网格靠**固定格子**定位，
/// 因此作者可以把整张 9 行的 sprite sheet 直接交进来，不用先拼成一条长图。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasLayout {
    /// 单格宽（原图像素）
    pub frame_width: u32,
    /// 单格高（原图像素）
    pub frame_height: u32,
    /// 一行最多多少格（＝一帧动画最多多少帧）
    pub columns: u32,
    /// 图里一共多少行
    pub rows: u32,
}

/// 行为触发条件（有限枚举，无表达式）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Condition {
    /// 什么都没发生（默认待机）
    Idle,
    /// 音乐正在播放
    Playing,
    /// 静默超过 N 毫秒
    SilentFor { ms: u32 },
    /// 有歌词行
    LyricActive,
    /// 指针靠近（宿主给的判定结果）
    PointerNear,
    /// 被点了一下
    Clicked,
    /// 换歌（track hash 变了）
    TrackChanged,
    /// 饿了（阈值在 `PetProfileLimits::hunger_hungry_at`）
    Hungry,
    /// 好感达到某一档（M3）：`tier` = shy / friendly / close / devoted
    BondAtLeast { tier: crate::profile::PetMood },
    /// 正在往某边走动（M8）：`dir` = -1 左 / 1 右。
    /// 「走」是**宿主**在动窗口（宠物自己不会算屏幕坐标），核心只据此挑动画。
    Walking { dir: i8 },
}

/// 行为动作（有限枚举，副作用只发生在宿主侧）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Action {
    /// 播放某个动画（必须是 animations 里存在的名字）
    ///
    /// `interrupt`：允许**立刻**打断当前动画（默认 false = 要连续请求一小会儿才切，
    /// 免得「走动方向闪一下」就让动画跳来跳去）。
    Play {
        animation: String,
        #[serde(default)]
        interrupt: bool,
    },
    /// 说一句话（只带 i18n 键，不提供文案）
    Say { text_key: String },
    /// 朝某个方向（-1 左 / 1 右）
    Face { dir: i8 },
    /// 回到锚点
    Anchor,
}

/// 一条行为：条件满足时执行动作
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Behavior {
    pub when: Condition,
    pub then: Action,
    /// 冷却（毫秒）：避免同一条行为每帧都触发
    #[serde(default)]
    pub cooldown_ms: u32,
}

/// 宠物包规格（`pet.json`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSpec {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    /// 宿主渲染用的素材文件名（**纯文件名**，不带路径）
    #[serde(default)]
    pub atlas: String,
    pub animations: Vec<Animation>,
    #[serde(default)]
    pub behaviors: Vec<Behavior>,
    /// 图集的网格布局（M4）：有它时按「格子」取帧，没有时按「单行帧条」等分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atlas_layout: Option<AtlasLayout>,
    /// 「看向哪边」的两行（M6 / Codex Pet v2）：`[第一行, 第二行]`。
    /// 每行从左到右放 8 个方向，两行一共 16 个（0 = 正上，顺时针）。
    /// 没有它就不支持 look：渲染层只画动画帧。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look_rows: Option<[u32; 2]>,
    /// 宠物核心的最低版本要求（语义化版本字符串，M0 只做非空校验）
    #[serde(default)]
    pub min_pet_core_version: String,
}

impl PetSpec {
    /// 校验并归一化（M0 只做结构校验；不做版本比较）。
    pub fn validate(&self) -> PetResult<()> {
        if !is_valid_id(&self.id) {
            return Err(PetError::invalid_package(
                "宠物 id 不合法（小写字母/数字/`.`/`-`/`_`，2~64 位，不能含路径分隔符）",
            ));
        }
        if self.name.trim().is_empty() {
            return Err(PetError::invalid_package("宠物缺少 name"));
        }
        if self.animations.is_empty() {
            return Err(PetError::invalid_package("宠物至少要有一个动画"));
        }
        self.validate_versions()?;
        if self.animations.len() > MAX_ANIMATIONS {
            return Err(PetError::limit_exceeded(format!(
                "动画数量超过上限（{} > {MAX_ANIMATIONS}）",
                self.animations.len()
            )));
        }
        let mut names = BTreeSet::new();
        for animation in &self.animations {
            if animation.name.trim().is_empty() {
                return Err(PetError::invalid_package("动画缺少 name"));
            }
            if !names.insert(animation.name.as_str()) {
                return Err(PetError::invalid_package(format!(
                    "动画名字重复：{}",
                    animation.name
                )));
            }
            if animation.frames == 0 || animation.frames > MAX_FRAMES_PER_ANIMATION {
                return Err(PetError::limit_exceeded(format!(
                    "动画 {} 的帧数非法（0 < frames ≤ {MAX_FRAMES_PER_ANIMATION}）",
                    animation.name
                )));
            }
            if animation.frame_ms == 0 {
                return Err(PetError::invalid_package(format!(
                    "动画 {} 的 frameMs 必须大于 0",
                    animation.name
                )));
            }
            if let Some(fit) = &animation.fit {
                /* 缩放范围：太小看不清、太大撑破窗口；偏移给一点余量即可 */
                if !(MIN_FIT_SCALE..=MAX_FIT_SCALE).contains(&fit.scale) {
                    return Err(PetError::invalid_package(format!(
                        "动画 {} 的 fit.scale 超出范围（{MIN_FIT_SCALE}~{MAX_FIT_SCALE}）",
                        animation.name
                    )));
                }
                let limit = self
                    .atlas_layout
                    .map(|layout| layout.frame_width.max(layout.frame_height) as i32)
                    .unwrap_or(MAX_FIT_OFFSET);
                if fit.offset_x.abs() > limit || fit.offset_y.abs() > limit {
                    return Err(PetError::invalid_package(format!(
                        "动画 {} 的 fit 偏移过大（不超过一格 {limit} 像素）",
                        animation.name
                    )));
                }
            }
        }
        if self.behaviors.len() > MAX_ANIMATIONS * 4 {
            return Err(PetError::limit_exceeded("行为数量过多"));
        }
        for behavior in &self.behaviors {
            match &behavior.then {
                Action::Play { animation, .. } => {
                    if !names.contains(animation.as_str()) {
                        return Err(PetError::invalid_package(format!(
                            "行为引用了不存在的动画：{animation}"
                        )));
                    }
                }
                Action::Say { text_key } => {
                    if text_key.trim().is_empty() || text_key.len() > MAX_TEXT_KEY_LEN {
                        return Err(PetError::invalid_argument(format!(
                            "气泡文案键非法（长度 1~{MAX_TEXT_KEY_LEN}）"
                        )));
                    }
                }
                Action::Face { dir } => {
                    if *dir != -1 && *dir != 1 {
                        return Err(PetError::invalid_argument("Face 的 dir 只能是 -1 或 1"));
                    }
                }
                Action::Anchor => {}
            }
        }
        if !self.atlas.is_empty() && !is_plain_file_name(&self.atlas) {
            return Err(PetError::invalid_package(
                "atlas 只能是包内的纯文件名（不允许路径分隔符或 ..）",
            ));
        }
        self.validate_atlas_layout()?;
        self.validate_motion()?;
        Ok(())
    }

    /// 位移能力：`index` 对应的动画**当前**允许怎么动。
    ///
    /// 兼容规则见 `Motion`：没声明任何 motion 的旧包全部按 `Walk`（零回归）；
    /// 只要声明了一个，整包进入严格模式（未声明 = `None`）。
    pub fn effective_motion(&self, index: u16) -> Motion {
        let strict = self.animations.iter().any(|animation| animation.motion.is_some());
        if !strict {
            return Motion::Walk;
        }
        self.animations
            .get(index as usize)
            .and_then(|animation| animation.motion)
            .unwrap_or(Motion::None)
    }

    /// 位移声明的自洽性（R139）。
    ///
    /// 两条必须在**安装时报**，而不是等真机上「坐着滑行」：
    /// 1. 声明了 motion 却没有任何 walk/crawl 动画 —— 自相矛盾；
    /// 2. `walking` 行为指向 `motion: none` 的动画 —— 作者写错，走动时永远动不了。
    fn validate_motion(&self) -> PetResult<()> {
        let strict = self.animations.iter().any(|animation| animation.motion.is_some());
        if !strict {
            return Ok(());
        }
        let has_movable = self
            .animations
            .iter()
            .any(|animation| matches!(animation.motion, Some(Motion::Walk | Motion::Crawl)));
        if !has_movable {
            return Err(PetError::invalid_package(
                "声明了动画 motion，但没有任何 walk / crawl 动画（宠物将永远无法移动）",
            ));
        }
        for behavior in &self.behaviors {
            if !matches!(behavior.when, Condition::Walking { .. }) {
                continue;
            }
            let Action::Play { animation, .. } = &behavior.then else {
                continue;
            };
            let Some(index) = self.animation_index(animation) else {
                continue;
            };
            if self.effective_motion(index) == Motion::None {
                return Err(PetError::invalid_package(format!(
                    "walking 行为指向了 motion: none 的动画：{animation}（走动时必须播可位移动画）"
                )));
            }
        }
        Ok(())
    }

    /// 版本相关：`version` 必须是语义化版本，`minPetCoreVersion` 必须**真的**被比较。
    ///
    /// 为什么要比：这个字段一直只是「非空校验」，也就是写什么都不影响安装——
    /// 那它对用户就是一句空话。宠物包用到新核心才有的能力（比如 `fit` / `lookRows`）时，
    /// 装在旧核心上只会「看着能装、画出来不对」，不如安装时就明确拒绝。
    fn validate_versions(&self) -> PetResult<()> {
        if Version::parse(&self.version).is_none() {
            return Err(PetError::invalid_package(format!(
                "version 必须是语义化版本（x.y.z）：{}",
                self.version
            )));
        }
        let minimum_text = self.min_pet_core_version.trim();
        if minimum_text.is_empty() {
            return Ok(());
        }
        let Some(minimum) = Version::parse(minimum_text) else {
            return Err(PetError::invalid_package(format!(
                "minPetCoreVersion 必须是语义化版本（x.y.z）：{minimum_text}"
            )));
        };
        let Some(current) = Version::current() else {
            /* 自己的版本号都解析不了：那是我们的 bug，不该让用户的包背锅 */
            return Ok(());
        };
        if !current.satisfies(minimum) {
            return Err(PetError::incompatible(format!(
                "这个宠物包要求宠物核心 ≥ {minimum}，当前是 {current}（先升级宿主应用再装）"
            )));
        }
        Ok(())
    }

    /// 网格图集的自洽性：格子尺寸、行列上限、每个动画落在自己的行里。
    fn validate_atlas_layout(&self) -> PetResult<()> {
        let Some(layout) = &self.atlas_layout else {
            // 没有网格布局时写 `row` 没有任何意义，宁可报错也不静默忽略
            if self.animations.iter().any(|animation| animation.row.is_some()) {
                return Err(PetError::invalid_package(
                    "动画写了 row，但包里没有 atlasLayout（grid 图集才需要行号）",
                ));
            }
            return Ok(());
        };
        if layout.frame_width == 0 || layout.frame_height == 0 {
            return Err(PetError::invalid_package("atlasLayout 的格子尺寸必须大于 0"));
        }
        if layout.columns == 0 || layout.rows == 0 {
            return Err(PetError::invalid_package("atlasLayout 的 rows / columns 必须大于 0"));
        }
        if layout.columns > MAX_ATLAS_COLUMNS || layout.rows > MAX_ATLAS_ROWS {
            return Err(PetError::limit_exceeded(format!(
                "atlasLayout 超过上限（columns ≤ {MAX_ATLAS_COLUMNS}、rows ≤ {MAX_ATLAS_ROWS}）"
            )));
        }
        if self.atlas.is_empty() {
            return Err(PetError::invalid_package(
                "有 atlasLayout 却没有 atlas：网格图集也要指向一张图",
            ));
        }
        for (index, animation) in self.animations.iter().enumerate() {
            if animation.frames > layout.columns as usize {
                return Err(PetError::invalid_package(format!(
                    "动画 {} 有 {} 帧，但一行只有 {} 格",
                    animation.name, animation.frames, layout.columns
                )));
            }
            let row = animation.row.unwrap_or(index as u32);
            if row >= layout.rows {
                return Err(PetError::invalid_package(format!(
                    "动画 {} 的行号 {} 超出图集（只有 {} 行）",
                    animation.name, row, layout.rows
                )));
            }
        }
        /* look 两行：16 个方向要 2×8 格，行号必须落在图里、且不能和动画行重叠 */
        if let Some([top, bottom]) = self.look_rows {
            if layout.columns < 8 {
                return Err(PetError::invalid_package(format!(
                    "look 需要一行 8 格（16 个方向分两行），现在一行只有 {} 格",
                    layout.columns
                )));
            }
            if top == bottom {
                return Err(PetError::invalid_package("lookRows 的两行不能是同一行"));
            }
            for row in [top, bottom] {
                if row >= layout.rows {
                    return Err(PetError::invalid_package(format!(
                        "lookRows 里的第 {row} 行超出图集（只有 {} 行）",
                        layout.rows
                    )));
                }
                if self
                    .animations
                    .iter()
                    .enumerate()
                    .any(|(index, animation)| animation.row.unwrap_or(index as u32) == row)
                {
                    return Err(PetError::invalid_package(format!(
                        "lookRows 的第 {row} 行和某个动画的行号撞了：一行不能既放动画又放 look"
                    )));
                }
            }
        }
        Ok(())
    }

    /// 从 JSON 文本解析并校验（宿主导入宠物包时调用）。
    pub fn from_json(text: &str) -> PetResult<Self> {
        let spec: Self = serde_json::from_str(text)?;
        spec.validate()?;
        Ok(spec)
    }

    /// 某个动画在表里的下标（渲染层只需要下标，不需要字符串查找）
    pub fn animation_index(&self, name: &str) -> Option<u16> {
        self.animations
            .iter()
            .position(|animation| animation.name == name)
            .map(|index| index as u16)
    }
}

/// 只允许「小写字母/数字/. - _」，2~64 位，且不能含路径分隔符
pub fn is_valid_id(id: &str) -> bool {
    let len = id.chars().count();
    (2..=64).contains(&len)
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '-' | '_'))
}

/// 包内文件名：不能带路径、不能是 `..`
pub fn is_plain_file_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}



