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
/// 一天的毫秒数（本地日由前端给；核心没有时区，退回 UTC 日）
pub const DAY_MS: u64 = 86_400_000;
/// `state_json`（养成账本）允许的最大长度：坏数据/手改库不能把宠物读死
pub const MAX_STATE_JSON: usize = 4 * 1024;
/// 最多记多少条解锁（防止无限增长）
pub const MAX_UNLOCKS: usize = 16;

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
    /* ---------- 养成（R139）：等级 / 每日上限 / 经验 ---------- */
    /// 每级需要多少经验
    pub level_step_xp: u64,
    /// 等级上限
    pub max_level: u32,
    /// 每天最多几次「有收益」的喂食（喂饱后继续喂只演动画，不给好感）
    pub feed_daily_cap: u32,
    /// 每天最多几次「有收益」的触摸（防 30 分钟刷满好感）
    pub touch_daily_cap: u32,
    /// 一次**有效**喂食的经验
    pub feed_xp: u64,
    /// 一次**有效**触摸的经验
    pub touch_xp: u64,
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
            level_step_xp: 120,
            max_level: 30,
            feed_daily_cap: 6,
            touch_daily_cap: 20,
            feed_xp: 12,
            touch_xp: 2,
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

/// 养成账本（R139）：存在 `PetProfile.state_json` 里，**不改表结构**。
///
/// 只放「只增不减」的成长数据与每日计数；等级是**派生值**（`xp / level_step_xp`），
/// 不能用会衰减的 affection 算等级，否则用户放几天不管就会掉级。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PetGrowth {
    /// 累计经验（只增）
    pub xp: u64,
    /// 累计喂食次数（含没有收益的）
    pub feeds: u32,
    /// 累计触摸次数（含没有收益的）
    pub touches: u32,
    /// 历史最高好感（好感会自然衰减，这个不会）
    pub best_affection: i32,
    /// 连续到访天数
    pub streak_days: u32,
    /// 累计到访天数
    pub days_visited: u32,
    /// 上一次到访的本地日序号（-1 = 从未来过）
    pub last_day: i64,
    /// 今日计数对应的日序号
    pub today_day: i64,
    pub today_fed: u32,
    pub today_touched: u32,
    /// 一次性解锁（如 `first-feed` / `bond-friendly` / `streak-7` / `feeds-50`）
    pub unlocked: Vec<String>,
}

impl Default for PetGrowth {
    fn default() -> Self {
        Self {
            xp: 0,
            feeds: 0,
            touches: 0,
            best_affection: 0,
            streak_days: 0,
            days_visited: 0,
            last_day: -1,
            today_day: -1,
            today_fed: 0,
            today_touched: 0,
            unlocked: Vec::new(),
        }
    }
}

impl PetGrowth {
    /// 追加一个解锁（幂等）；返回是否真的新增。
    fn unlock(&mut self, key: &str) -> bool {
        if self.unlocked.iter().any(|item| item == key) {
            return false;
        }
        if self.unlocked.len() >= MAX_UNLOCKS {
            return false;
        }
        self.unlocked.push(key.to_string());
        /* 解锁给一点经验，让「发现新东西」也能推动等级 */
        self.xp = self.xp.saturating_add(20);
        true
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
        /* 养成账本：坏 JSON / 超长 / 手改库一律退回空账本，不能让整只宠物读不出来 */
        self.state_json = if self.state_json.trim().is_empty()
            || self.state_json.len() > MAX_STATE_JSON
            || serde_json::from_str::<PetGrowth>(&self.state_json).is_err()
        {
            "{}".to_string()
        } else {
            self.state_json
        };
        self
    }

    /// 读取养成账本（坏数据回默认值，不报错）。
    pub fn growth(&self) -> PetGrowth {
        let mut growth: PetGrowth =
            serde_json::from_str(&self.state_json).unwrap_or_default();
        growth.unlocked.truncate(MAX_UNLOCKS);
        growth
    }

    /// 写回养成账本（超长就丢弃这次写入，保持上一份可用账本）。
    fn store_growth(&mut self, growth: &PetGrowth) {
        if let Ok(json) = serde_json::to_string(growth) {
            if json.len() <= MAX_STATE_JSON {
                self.state_json = json;
            }
        }
    }

    /// 当前等级（派生；xp 只增 → 等级永不下降）。
    pub fn level(&self, limits: &PetProfileLimits) -> u32 {
        let step = limits.level_step_xp.max(1);
        ((1 + self.growth().xp / step) as u32).min(limits.max_level.max(1))
    }

    /// 下一级所需经验（满级返回当前累计值，UI 据此显示「满级」）。
    pub fn next_level_xp(&self, limits: &PetProfileLimits) -> u64 {
        let level = self.level(limits);
        if level >= limits.max_level.max(1) {
            return self.growth().xp;
        }
        level as u64 * limits.level_step_xp.max(1)
    }

    /// 记录「今天来过」（R139）：跨天时重置今日计数、更新连续天数。
    ///
    /// `day` 是**本地日序号**（前端用本地时区算；核心拿不到时区）。同一天重复调用是幂等的。
    /// 返回是否发生了跨天。
    pub fn visit_day(&mut self, day: i64, _limits: &PetProfileLimits) -> bool {
        if day <= 0 {
            return false;
        }
        let mut growth = self.growth();
        if growth.last_day == day {
            return false;
        }
        growth.streak_days = if growth.last_day >= 0 && day == growth.last_day + 1 {
            growth.streak_days.saturating_add(1)
        } else {
            1
        };
        growth.last_day = day;
        growth.days_visited = growth.days_visited.saturating_add(1);
        growth.today_day = day;
        growth.today_fed = 0;
        growth.today_touched = 0;
        if growth.streak_days >= 7 {
            growth.unlock("streak-7");
        }
        self.store_growth(&growth);
        true
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
    ///
    /// 养成修正（R139）：**不饿时喂食只演动画、不加好感**；每天有收益次数上限。
    /// 以前不看饥饿、也不设上限，喂食等于无限刷好感。
    pub fn feed(&self, now_ms: u64, limits: &PetProfileLimits) -> PetResult<Self> {
        if self.last_fed_at > 0 && now_ms.saturating_sub(self.last_fed_at) < limits.feed_cooldown_ms {
            let wait = limits.feed_cooldown_ms - now_ms.saturating_sub(self.last_fed_at);
            return Err(PetError::invalid_argument(format!("刚喂过，等 {wait} 毫秒再喂")));
        }
        let mut next = self.clone();
        let day = (now_ms / DAY_MS) as i64;
        next.visit_day(day, limits);
        let mut growth = next.growth();
        let hungry = next.is_hungry(limits);
        let rewarded = hungry && growth.today_fed < limits.feed_daily_cap;
        if rewarded {
            next.affection = (next.affection + limits.feed_affection_gain).min(limits.max_affection);
            growth.xp = growth.xp.saturating_add(limits.feed_xp);
            growth.unlock("first-feed");
        }
        next.hunger = (next.hunger - limits.feed_hunger_relief).max(0);
        next.last_fed_at = now_ms;
        next.updated_at = now_ms;
        growth.feeds = growth.feeds.saturating_add(1);
        growth.today_fed = growth.today_fed.saturating_add(1);
        growth.best_affection = growth.best_affection.max(next.affection);
        if growth.feeds >= 50 {
            growth.unlock("feeds-50");
        }
        /* 好感分档是派生值：喂完立刻检查一次，到档就记一条解锁（只发一次） */
        if next.bond_at_least(limits, PetMood::Friendly) {
            growth.unlock("bond-friendly");
        }
        if next.bond_at_least(limits, PetMood::Close) {
            growth.unlock("bond-close");
        }
        if next.bond_at_least(limits, PetMood::Devoted) {
            growth.unlock("bond-devoted");
        }
        next.store_growth(&growth);
        Ok(next)
    }

    /// 摸一下：冷却内静默忽略（不报错——摸两下不该弹错误）。
    ///
    /// 养成修正（R139）：每天**有收益**的触摸有上限，超出后仍可摸（动画照旧），只是不加好感。
    pub fn touch(&self, now_ms: u64, limits: &PetProfileLimits) -> Self {
        let mut next = self.clone();
        if self.last_touched_at > 0
            && now_ms.saturating_sub(self.last_touched_at) < limits.touch_cooldown_ms
        {
            return next;
        }
        let day = (now_ms / DAY_MS) as i64;
        next.visit_day(day, limits);
        let mut growth = next.growth();
        let rewarded = growth.today_touched < limits.touch_daily_cap;
        if rewarded {
            next.affection = (next.affection + limits.touch_affection_gain).min(limits.max_affection);
            growth.xp = growth.xp.saturating_add(limits.touch_xp);
        }
        next.last_touched_at = now_ms;
        next.updated_at = now_ms;
        growth.touches = growth.touches.saturating_add(1);
        growth.today_touched = growth.today_touched.saturating_add(1);
        growth.best_affection = growth.best_affection.max(next.affection);
        if next.bond_at_least(limits, PetMood::Friendly) {
            growth.unlock("bond-friendly");
        }
        if next.bond_at_least(limits, PetMood::Close) {
            growth.unlock("bond-close");
        }
        if next.bond_at_least(limits, PetMood::Devoted) {
            growth.unlock("bond-devoted");
        }
        next.store_growth(&growth);
        next
    }
}
