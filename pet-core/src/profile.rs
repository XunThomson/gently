//! 跨会话的宠物资料（**地基**）：好感度 / 饱食度 / 交互时间戳。
//!
//! 本里程碑只建立数据与 API，不调玩法数值：`PetProfileLimits` 的默认值刻意保守，
//! 后续做「喂食 / 好感度成长」时只改这里的常量与 UI，不动存储与状态机。
//! 归零语义：`hunger` 0 = 不饿、100 = 很饿（喂食把它降回去）；`affection` 0~1000。
//!
//! 这些字段**必须**存在跨会话存储里（宠物重启后要记得你），因此 `PetProfile` 是持久化类型，
//! 临时状态（动画进度、指针位置）只在 `Sim` 里，不落库。

use serde::{Deserialize, Serialize};

use crate::error::{PetError, PetResult};

/// 好感度上限（0 也是合法值：长期不理会掉到 0）。
pub const MAX_AFFECTION: i32 = 1000;
/// 饱食度上限（100 = 很饿）。
pub const MAX_HUNGER: i32 = 100;

/// 玩法数值：全部集中在这里（做玩法时只改这里，不动存储与状态机）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PetProfileLimits {
    pub max_affection: i32,
    pub max_hunger: i32,
    /// 两次喂食之间的最小间隔（毫秒）：防止连点刷好感
    pub feed_cooldown_ms: u64,
    /// 一次喂食的好感度增量
    pub feed_affection_gain: i32,
    /// 一次喂食消除多少「饿」
    pub feed_hunger_relief: i32,
    /// 摸一下的好感度增量
    pub touch_affection_gain: i32,
    /// 两次触摸之间的最小间隔（毫秒）
    pub touch_cooldown_ms: u64,
    /// 每小时自然衰减多少好感（长期不理会的代价）
    pub affection_decay_per_hour: i32,
    /// 每小时增加多少「饿」
    pub hunger_per_hour: i32,
    /// 饿到什么程度开始「饿」的表现（M3）
    pub hunger_hungry_at: i32,
    /// 好感分档阈值（M3）：到这一档就升级
    pub affection_friendly_at: i32,
    pub affection_close_at: i32,
    pub affection_devoted_at: i32,
}

impl Default for PetProfileLimits {
    fn default() -> Self {
        Self {
            max_affection: MAX_AFFECTION,
            max_hunger: MAX_HUNGER,
            feed_cooldown_ms: 30_000,
            feed_affection_gain: 5,
            feed_hunger_relief: 40,
            touch_affection_gain: 1,
            touch_cooldown_ms: 2_000,
            affection_decay_per_hour: 2,
            hunger_per_hour: 12,
            hunger_hungry_at: 60,
            affection_friendly_at: 100,
            affection_close_at: 400,
            affection_devoted_at: 750,
        }
    }
}

/// 好感度分档（M3）：只从「好感 + 饿」算出来，不落库（避免两个真相）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PetMood {
    /// 刚认识：拘谨
    Shy,
    /// 熟悉：愿意搭理你
    Friendly,
    /// 亲近：主动表现
    Close,
    /// 依赖：一直黏着
    Devoted,
}

impl PetMood {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Shy => "shy",
            Self::Friendly => "friendly",
            Self::Close => "close",
            Self::Devoted => "devoted",
        }
    }
}

/// 一只宠物的**持久化**资料（跨会话）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetProfile {
    /// 宠物包 id（与 `PetSpec.id` 一致）
    pub id: String,
    pub name: String,
    /// 0 ~ max_affection
    pub affection: i32,
    /// 0（不饿）~ max_hunger（很饿）
    pub hunger: i32,
    /// 上次喂食时间（毫秒时间戳；0 = 从没喂过）
    pub last_fed_at: u64,
    /// 上次交互（触摸/点击）时间
    pub last_touched_at: u64,
    pub created_at: u64,
    pub updated_at: u64,
    /// 预留给后续「行为状态」的持久化（M0 恒为 `{}`，不改表结构就能加字段）
    #[serde(default)]
    pub state_json: String,
}

impl PetProfile {
    /// 新领养的宠物：初始好感度 0、不饿
    pub fn new(spec_id: &str, name: &str, now_ms: u64) -> Self {
        Self {
            id: spec_id.to_string(),
            name: name.to_string(),
            affection: 0,
            hunger: 0,
            last_fed_at: 0,
            last_touched_at: 0,
            created_at: now_ms,
            updated_at: now_ms,
            state_json: "{}".to_string(),
        }
    }

    /// 把字段夹回合法区间（从库里读出来的旧数据/坏数据都要过它）。
    pub fn clamped(mut self, limits: &PetProfileLimits) -> Self {
        self.affection = self.affection.clamp(0, limits.max_affection);
        self.hunger = self.hunger.clamp(0, limits.max_hunger);
        self.state_json = if self.state_json.trim().is_empty() {
            "{}".to_string()
        } else {
            self.state_json
        };
        self
    }

    /// 好感分档（M3）：**派生值**，不落库——库里只存好感与饿，避免「两套心情互相矛盾」。
    pub fn mood(&self, limits: &PetProfileLimits) -> PetMood {
        if self.affection >= limits.affection_devoted_at {
            PetMood::Devoted
        } else if self.affection >= limits.affection_close_at {
            PetMood::Close
        } else if self.affection >= limits.affection_friendly_at {
            PetMood::Friendly
        } else {
            PetMood::Shy
        }
    }

    /// 是不是饿到该有反应了（M3 的行为条件 `hungry` 用它）
    pub fn is_hungry(&self, limits: &PetProfileLimits) -> bool {
        self.hunger >= limits.hunger_hungry_at
    }

    /// 是否达到（或超过）某一档好感
    pub fn bond_at_least(&self, limits: &PetProfileLimits, tier: PetMood) -> bool {
        let rank = |mood: PetMood| match mood {
            PetMood::Shy => 0,
            PetMood::Friendly => 1,
            PetMood::Close => 2,
            PetMood::Devoted => 3,
        };
        rank(self.mood(limits)) >= rank(tier)
    }

    /// 时间流逝带来的自然衰减（纯函数；调用方给出 `now_ms`，测试因此可复现）。
    pub fn decay(&self, now_ms: u64, limits: &PetProfileLimits) -> Self {
        let mut next = self.clone();
        if now_ms <= self.updated_at {
            return next;
        }
        let hours = (now_ms - self.updated_at) as f64 / 3_600_000.0;
        if hours <= 0.0 {
            return next;
        }
        let affection_loss = (limits.affection_decay_per_hour as f64 * hours).round() as i32;
        let hunger_gain = (limits.hunger_per_hour as f64 * hours).round() as i32;
        next.affection = (next.affection - affection_loss).clamp(0, limits.max_affection);
        next.hunger = (next.hunger + hunger_gain).clamp(0, limits.max_hunger);
        next
    }

    /// 喂食：冷却内被拒绝（返回剩余毫秒数）。
    pub fn feed(&self, now_ms: u64, limits: &PetProfileLimits) -> PetResult<Self> {
        if self.last_fed_at > 0 && now_ms.saturating_sub(self.last_fed_at) < limits.feed_cooldown_ms {
            let wait = limits.feed_cooldown_ms - now_ms.saturating_sub(self.last_fed_at);
            return Err(PetError::invalid_argument(format!("刚喂过，等 {wait} 毫秒再喂")));
        }
        let mut next = self.clone();
        next.affection = (next.affection + limits.feed_affection_gain).min(limits.max_affection);
        next.hunger = (next.hunger - limits.feed_hunger_relief).max(0);
        next.last_fed_at = now_ms;
        next.updated_at = now_ms;
        Ok(next)
    }

    /// 摸一下：冷却内静默忽略（不报错——摸两下不该弹错误）。
    pub fn touch(&self, now_ms: u64, limits: &PetProfileLimits) -> Self {
        let mut next = self.clone();
        if self.last_touched_at > 0
            && now_ms.saturating_sub(self.last_touched_at) < limits.touch_cooldown_ms
        {
            return next;
        }
        next.affection = (next.affection + limits.touch_affection_gain).min(limits.max_affection);
        next.last_touched_at = now_ms;
        next.updated_at = now_ms;
        next
    }
}
