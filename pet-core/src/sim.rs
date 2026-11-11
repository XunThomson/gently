//! 确定性的状态机：`tick(Input) -> Frame`。
//!
//! 三条硬性要求：
//! 1. **确定性**：同样的初始条件 + 同样的 `Input` 序列 → 相同的 `Frame` 序列；
//!    随机数用自带的 xorshift64*，种子由宿主给（测试可复现）；
//! 2. **无副作用**：这里不读时钟、不写文件、不碰播放器；时间与播放快照都由 `Input` 带进来；
//! 3. **零分配**：`Frame` 全是定长数据（气泡是文案表下标，不是字符串），
//!    每帧不留 `String`/`Vec`，20 Hz 推进时才不抖。

use serde::Serialize;

use crate::spec::{Action, Animation, Condition, Motion};
use crate::{PetProfile, PetSpec, PlaybackHint};

/// 宿主每帧喂进来的输入（只读）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Input {
    /// 距上一帧的毫秒数（宿主决定节拍；M0 约定 50ms = 20 Hz）
    pub dt_ms: u32,
    /// 只读播放快照
    pub playback: PlaybackHint,
    /// 指针位置（相对宠物容器左上角；None = 指针不在宠物上）
    pub pointer: Option<(i32, i32)>,
    /// 这一帧是否发生了点击
    pub clicked: bool,
    /// 指针相对宠物的方向（0..16，0 = 正上、顺时针；None = 没在看任何东西）。
    /// v2 图集用它在两行「look 方向」里挑一格；v1 没有这两行，核心只把值透传出去。
    pub look_dir: Option<u8>,
    /// 正在往哪边走：-1 左 / 0 没走 / 1 右（宿主驱动窗口位移，核心只据此挑动画）
    pub walk_dir: Option<i8>,
}

/// 宠物可交互的区域（宿主据此决定指针事件走不走进宠物）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 一帧的输出（宿主只负责画）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// 当前动画下标（对应 `PetSpec.animations`）
    pub animation: u16,
    /// 当前动画内的帧下标
    pub frame: u16,
    /// 位置（相对容器左上角）
    pub x: i32,
    pub y: i32,
    /// 是否水平翻转（朝向）
    pub flip: bool,
    /// 气泡文案下标（对应 `Sim::text_key`；None = 不显示气泡）
    pub bubble: Option<u16>,
    /// 可交互区域（None = 本帧没有交互区）
    pub hit_area: Option<Rect>,
    /// 看向哪边（原样回传 Input.look_dir；渲染层据此决定要不要画 look 格）
    pub look: Option<u8>,
    /// 当前动画允许的位移能力（R139）：宿主据此决定「能不能挪窗口」。
    /// `none` = 不许平移（坐下 / 跳 / 失败 / 点击反应……）。
    pub motion: Motion,
}

/// 宠物默认锚点（M0：宠物总在容器左上角，以后由行为里的 `moveTo` 扩展）
const HOME: (i32, i32) = (0, 0);
/// 交互区尺寸（与素材无关，先按 96×96 的常见精灵图算）
const HIT_SIZE: i32 = 96;
/// 气泡显示时长
const BUBBLE_MS: u32 = 2_000;
/// 换动画前的「确认时长」：同一个目标要连续被请求这么久才切。
///
/// 为什么需要：走动方向是宿主每 60ms 报一次的值，光标擦过宠物、窗口被挪动都会让
/// 某几拍报回 0；没有这个确认期，动画就会「跑 → 待机 → 跑」闪一下。
/// 带 `interrupt` 的动作（点击 / 换歌这类用户主动行为）不受它限制。
const SWITCH_DELAY_MS: u32 = 160;

/// 宠物状态机。
pub struct Sim {
    spec: PetSpec,
    /// 玩法阈值（饿 / 好感分档）：由宿主传入，宠物包只写「触发什么」，不写数值
    limits: crate::profile::PetProfileLimits,
    animation: u16,
    frame: u16,
    elapsed_in_frame: u32,
    /// 行为冷却：与 `spec.behaviors` 一一对应
    cooldowns: Vec<u64>,
    /// 自增时钟（毫秒）：由 `dt_ms` 累计（绝对时间不进状态机，保证可复现）
    clock_ms: u64,
    pointer_near: bool,
    last_track_hash: u64,
    /// 气泡文案表（从 behaviors 收集，下标稳定）
    text_keys: Vec<String>,
    bubble: Option<(u16, u32)>,
    flip: bool,
    /// 随机数状态（xorshift64*）
    rng: u64,
    x: i32,
    y: i32,
    /// 还没确认的「想切到哪个动画」：(目标下标, 已经持续了多久)
    pending: Option<(u16, u32)>,
    /// 已经静默了多久（毫秒）：`Condition::SilentFor` 靠它，播放一恢复就归零
    silent_ms: u32,
    /// 打断型动画（点击 / 换歌这类带 `interrupt` 的）演到什么时候才允许状态机接管：
    /// 反应动作至少要完整演一遍，不能被「当前状态是待机」在 160ms 后掐掉
    reaction_hold_until: u64,
    /// 本拍的步长（毫秒）：行为判定里要用，避免把 dt 一路传下去
    dt_ms: u32,
}

impl Sim {
    /// 用规格与种子建一个状态机（同一规格 + 同一种子 = 同一条轨迹）。
    pub fn new(spec: PetSpec, seed: u64) -> Self {
        Self::with_limits(spec, crate::profile::PetProfileLimits::default(), seed)
    }

    /// 带上玩法阈值（引擎用它把自己的 `limits` 传进来，避免这里偷偷用默认值）。
    pub fn with_limits(spec: PetSpec, limits: crate::profile::PetProfileLimits, seed: u64) -> Self {
        let text_keys: Vec<String> = spec
            .behaviors
            .iter()
            .filter_map(|behavior| match &behavior.then {
                Action::Say { text_key } => Some(text_key.clone()),
                _ => None,
            })
            .collect();
        let cooldowns = vec![0u64; spec.behaviors.len()];
        let (x, y) = HOME;
        Self {
            spec,
            limits,
            animation: 0,
            frame: 0,
            elapsed_in_frame: 0,
            cooldowns,
            clock_ms: 0,
            pointer_near: false,
            last_track_hash: 0,
            text_keys,
            bubble: None,
            flip: false,
            // 非零种子：xorshift 的 0 是吸收态
            rng: seed | 1,
            x,
            y,
            pending: None,
            silent_ms: 0,
            reaction_hold_until: 0,
            dt_ms: 0,
        }
    }

    /// 规格引用（渲染层取动画表用）
    pub fn spec(&self) -> &PetSpec {
        &self.spec
    }

    /// 气泡文案键（`Frame.bubble` 是它的下标）
    pub fn text_key(&self, index: u16) -> Option<&str> {
        self.text_keys.get(index as usize).map(String::as_str)
    }

    /// 内部时钟（毫秒，自增）
    pub fn clock_ms(&self) -> u64 {
        self.clock_ms
    }

    /// 推进一帧。
    ///
    /// `profile` 参与行为判定（M3 起）：饿了会走「饿」的分支、好感到了某一档才有亲近的表现。
    /// 判定只读，不修改资料——宠物不能自己给自己喂食。
    pub fn tick(&mut self, input: &Input, profile: &PetProfile) -> Frame {
        self.dt_ms = input.dt_ms.max(1);
        self.clock_ms = self.clock_ms.saturating_add(self.dt_ms as u64);

        /* 静默计时：**只有**「没在播」的时间才累计，一恢复播放就归零。
           以前 `SilentFor` 只是 `!playing`，等于「静默多久」这个条件永远立刻成立。 */
        self.silent_ms = if input.playback.playing {
            0
        } else {
            self.silent_ms.saturating_add(self.dt_ms)
        };

        self.pointer_near = input.pointer.is_some_and(|(px, py)| {
            px >= self.x - 8
                && px <= self.x + HIT_SIZE + 8
                && py >= self.y - 8
                && py <= self.y + HIT_SIZE + 8
        });

        if let Some(index) = self.pick_behavior(input, profile) {
            self.apply_behavior(index);
        }
        // 换歌只算一次「变化」：处理完就更新基准
        if input.playback.track_hash != 0 {
            self.last_track_hash = input.playback.track_hash;
        }

        self.confirm_state_animation(input, profile);
        self.advance_animation(input.dt_ms);
        self.tick_bubble(input.dt_ms);

        Frame {
            animation: self.animation,
            frame: self.frame,
            x: self.x,
            y: self.y,
            flip: self.flip,
            bubble: self.bubble.map(|(key, _)| key),
            hit_area: Some(Rect { x: self.x, y: self.y, w: HIT_SIZE, h: HIT_SIZE }),
            /* 方向按 16 取模：宿主给角度/越界值也能落回 0..15 */
            look: input.look_dir.map(|dir| dir % 16),
            motion: self.spec.effective_motion(self.animation),
        }
    }

    /// 当前动画允许的位移能力（供宿主门控窗口平移；不新增命令/事件）
    pub fn motion(&self) -> Motion {
        self.spec.effective_motion(self.animation)
    }

    /// 找到第一条「条件成立且冷却已过」的行为
    fn pick_behavior(&self, input: &Input, profile: &PetProfile) -> Option<usize> {
        self.spec
            .behaviors
            .iter()
            .enumerate()
            .find(|(index, behavior)| {
                self.condition_matches(&behavior.when, input, profile)
                    && self.clock_ms >= self.cooldowns.get(*index).copied().unwrap_or(0)
            })
            .map(|(index, _)| index)
    }

    /// 条件判定：只认有限枚举，且**只看输入与自己 + 只读资料**
    ///
    /// M3 起「饿」与「好感档位」参与判定；资料本身不被修改（宠物不能自己喂自己）。
    /// 阈值全部在 `PetProfileLimits` 里，宠物包只写「饿的时候做什么」，不写数值。
    fn condition_matches(&self, condition: &Condition, input: &Input, profile: &PetProfile) -> bool {
        let limits = &self.limits;
        match condition {
            Condition::Idle => !input.playback.playing && input.pointer.is_none(),
            Condition::Playing => input.playback.playing,
            /* 真的按「已经静默了多久」判断：`ms = 0` 等价于「没在播就算」 */
            Condition::SilentFor { ms } => !input.playback.playing && self.silent_ms >= *ms,
            Condition::LyricActive => input.playback.lyric_active,
            Condition::PointerNear => self.pointer_near,
            Condition::Clicked => input.clicked,
            Condition::TrackChanged => {
                input.playback.track_hash != 0 && input.playback.track_hash != self.last_track_hash
            }
            Condition::Hungry => profile.is_hungry(limits),
            Condition::BondAtLeast { tier } => profile.bond_at_least(limits, *tier),
            Condition::Walking { dir } => input.walk_dir.map(i8::signum) == Some(*dir),
        }
    }

    /// 执行行为（只改自己的状态：动画 / 朝向 / 气泡 / 位置）
    fn apply_behavior(&mut self, index: usize) {
        let Some(behavior) = self.spec.behaviors.get(index) else {
            return;
        };
        let cooldown = behavior.cooldown_ms as u64;
        if let Some(slot) = self.cooldowns.get_mut(index) {
            *slot = self.clock_ms.saturating_add(cooldown);
        }
        match &behavior.then {
            Action::Play { animation, interrupt } => {
                if let Some(next) = self.spec.animation_index(animation) {
                    self.request_animation(next, *interrupt);
                }
            }
            Action::Say { text_key } => {
                if let Some(position) = self.text_keys.iter().position(|key| key == text_key) {
                    self.bubble = Some((position as u16, BUBBLE_MS));
                }
            }
            Action::Face { dir } => {
                self.flip = *dir < 0;
            }
            Action::Anchor => {
                let (x, y) = HOME;
                self.x = x;
                self.y = y;
            }
        }
    }

    /// 请求切到某个动画。
    ///
    /// - 已经是它：清掉待定，什么都不做；
    /// - `interrupt`：立刻切（用户的主动动作要有即时反馈）；
    /// - 否则要「连续请求」满 `SWITCH_DELAY_MS` 才切——宿主每拍都会请求同一个目标，
    ///   所以正常状态切换只会晚几十到一百多毫秒，而单拍的抖动会被吃掉。
    fn request_animation(&mut self, next: u16, interrupt: bool) {
        if interrupt {
            if next != self.animation {
                self.switch_to(next);
                /* 反应动作要演完一遍：否则下一拍「当前状态是待机」就把它掐了 */
                self.reaction_hold_until = self.clock_ms.saturating_add(self.cycle_ms(next));
            } else {
                self.pending = None;
            }
            return;
        }
        /* 非打断的请求不在行为派发里切：交给 `confirm_state_animation` 每拍累积确认期
           （行为有自己的冷却，靠「重复触发」来计时是不可靠的） */
    }

    /// 每拍确认「状态类动画」：连续请求满 `SWITCH_DELAY_MS` 才真的切。
    ///
    /// 状态类动画 = 由持续条件（饿 / 在走 / 在播 / 指针靠近 / 待机 / 好感档）驱动的 `play`；
    /// 带 `interrupt` 的（点击、换歌）在上面就立刻切了，不走这里。
    fn confirm_state_animation(&mut self, input: &Input, profile: &PetProfile) {
        /* 反应动作还在演：状态机先别抢画面 */
        if self.clock_ms < self.reaction_hold_until {
            return;
        }
        let Some(desired) = self.desired_state_animation(input, profile) else {
            self.pending = None;
            return;
        };
        if desired == self.animation {
            self.pending = None;
            return;
        }
        let waited = match self.pending {
            Some((target, waited)) if target == desired => waited.saturating_add(self.step_ms()),
            _ => self.step_ms(),
        };
        if waited >= SWITCH_DELAY_MS {
            self.switch_to(desired);
        } else {
            self.pending = Some((desired, waited));
        }
    }

    /// 当前条件下「应该处于」的动画（按行为表顺序取第一条，忽略冷却）
    fn desired_state_animation(&self, input: &Input, profile: &PetProfile) -> Option<u16> {
        self.spec.behaviors.iter().find_map(|behavior| {
            let Action::Play { animation, interrupt } = &behavior.then else {
                return None;
            };
            if *interrupt || !self.condition_matches(&behavior.when, input, profile) {
                return None;
            }
            self.spec.animation_index(animation)
        })
    }

    /// 某个动画演完一遍要多久（毫秒；夹在 200–2000 之间，避免超长动画霸屏）
    fn cycle_ms(&self, index: u16) -> u64 {
        let Some(animation) = self.spec.animations.get(index as usize) else {
            return 0;
        };
        let cycle = (animation.frames.max(1) as u64)
            .saturating_mul(animation.frame_ms.max(1) as u64);
        cycle.clamp(200, 2_000)
    }

    fn switch_to(&mut self, next: u16) {
        self.animation = next;
        self.frame = 0;
        self.elapsed_in_frame = 0;
        self.pending = None;
    }

    /// 本拍的步长（`tick` 里存下来，供行为判定用）
    fn step_ms(&self) -> u32 {
        self.dt_ms.max(1)
    }

    /// 推进动画时间轴（循环动画回到第一帧，单次动画停在最后一帧）
    fn advance_animation(&mut self, dt_ms: u32) {
        let fallback = Animation {
            name: "idle".to_string(),
            frames: 1,
            frame_ms: 1_000,
            r#loop: true,
            row: None,
            fit: None,
            motion: None,
        };
        let animation = self
            .spec
            .animations
            .get(self.animation as usize)
            .cloned()
            .unwrap_or(fallback);
        let frame_ms = animation.frame_ms.max(1);

        self.elapsed_in_frame = self.elapsed_in_frame.saturating_add(dt_ms);
        while self.elapsed_in_frame >= frame_ms {
            self.elapsed_in_frame -= frame_ms;
            self.frame = self.frame.saturating_add(1);
            if self.frame as usize >= animation.frames.max(1) {
                self.frame = if animation.r#loop {
                    0
                } else {
                    animation.frames.saturating_sub(1) as u16
                };
            }
        }
    }

    fn tick_bubble(&mut self, dt_ms: u32) {
        if let Some((key, remaining)) = self.bubble {
            self.bubble = if remaining <= dt_ms {
                None
            } else {
                Some((key, remaining - dt_ms))
            };
        }
    }

    /// 记录当前曲目哈希（宿主在拿到新曲目时调用；`TrackChanged` 依赖它）
    pub fn note_track(&mut self, track_hash: u64) {
        self.last_track_hash = track_hash;
    }

    /// 取一个 `[0, bound)` 的确定性随机数（供将来的行为扩展用；M0 只保证可复现）
    pub fn next_bounded(&mut self, bound: u32) -> u32 {
        if bound == 0 {
            return 0;
        }
        let mut state = self.rng;
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        self.rng = state;
        ((state >> 32) as u32) % bound
    }
}









