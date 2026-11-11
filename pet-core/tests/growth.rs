//! 养成账本（R139）：等级 / 每日上限 / 连续天数 / 解锁 / 持久化。
//!
//! 这些数值决定「养久了会怎样」，所以不能只靠 UI 断言。测试都走 `Engine`，
//! 时间由调用方给（核心不读时钟），因此完全可复现。

use pet_core::{Engine, PetProfile, PetProfileLimits};

const DAY: u64 = 86_400_000;

fn spec(id: &str) -> String {
    format!(
        r##"{{
            "id": "{id}",
            "name": "测试宠物",
            "version": "1.0.0",
            "animations": [
                {{"name": "idle", "frames": 2, "frameMs": 100, "loop": true}}
            ],
            "behaviors": [
                {{"when": {{"kind": "idle"}}, "then": {{"kind": "play", "animation": "idle"}}}}
            ]
        }}"##
    )
}

#[test]
fn feeding_when_not_hungry_grants_no_affection_or_xp() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec("pet-growth-feed"), 0).unwrap();
    let profile = engine.feed("pet-growth-feed", 10_000).unwrap();
    let growth = profile.growth();

    assert_eq!(profile.affection, 0, "不饿时喂食不该刷好感");
    assert_eq!(growth.xp, 0, "不饿时喂食不该给经验");
    assert_eq!(growth.feeds, 1, "次数仍要记（用于里程碑）");
}

#[test]
fn feeding_when_hungry_grants_affection_and_xp() {
    let mut engine = Engine::open_in_memory().unwrap();
    let limits = PetProfileLimits::default();
    engine.install(&spec("pet-growth-hungry"), 0).unwrap();
    /* 5 小时后饥饿 60：正好到「饿」的阈值 */
    let profile = engine.feed("pet-growth-hungry", 5 * 3_600_000).unwrap();
    let growth = profile.growth();

    assert_eq!(profile.affection, limits.feed_affection_gain);
    assert!(growth.xp >= limits.feed_xp, "有效喂食应该给经验");
    assert!(growth.unlocked.iter().any(|key| key == "first-feed"));
}

#[test]
fn touch_has_a_daily_reward_cap() {
    let mut engine = Engine::open_in_memory().unwrap();
    let limits = PetProfileLimits::default();
    engine.install(&spec("pet-growth-touch"), 0).unwrap();

    /* 同一天内狂摸：每 2 秒一次，共 25 次（超过每日 20 次上限） */
    let base = 10 * DAY + 12 * 3_600_000;
    let mut last = PetProfile::new("pet-growth-touch", "测试宠物", 0);
    for index in 0..25u64 {
        last = engine.touch("pet-growth-touch", base + index * 2_000).unwrap();
    }
    let growth = last.growth();

    assert_eq!(growth.touches, 25, "动作次数照记");
    assert_eq!(growth.today_touched, 25);
    assert_eq!(
        last.affection,
        limits.touch_daily_cap as i32 * limits.touch_affection_gain,
        "超过每日上限后只演动画、不再加好感"
    );
}

#[test]
fn level_is_monotonic_even_when_affection_decays() {
    let mut engine = Engine::open_in_memory().unwrap();
    let limits = PetProfileLimits::default();
    engine.install(&spec("pet-growth-level"), 0).unwrap();
    let base = 10 * DAY;
    let mut profile = PetProfile::new("pet-growth-level", "测试宠物", 0);
    for index in 0..20u64 {
        profile = engine.touch("pet-growth-level", base + index * 2_000).unwrap();
    }
    let level_before = profile.level(&limits);
    assert!(level_before >= 1);

    /* 放 10 天不管：好感会衰减，但等级由只增的 xp 算，不许掉 */
    let later = base + 10 * DAY;
    let profile = engine.profile("pet-growth-level", later).unwrap();
    assert_eq!(
        profile.level(&limits),
        level_before,
        "等级不能因为好感衰减而下降"
    );
}

#[test]
fn consecutive_days_are_tracked_and_broken_correctly() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec("pet-growth-streak"), 0).unwrap();

    let profile = engine.profile("pet-growth-streak", 10 * DAY + 1_000).unwrap();
    assert_eq!(profile.growth().streak_days, 1);
    let profile = engine.profile("pet-growth-streak", 11 * DAY + 1_000).unwrap();
    assert_eq!(profile.growth().streak_days, 2);
    /* 隔了一天没来：连续天数归 1，但累计到访仍增加 */
    let profile = engine.profile("pet-growth-streak", 13 * DAY + 1_000).unwrap();
    assert_eq!(profile.growth().streak_days, 1);
    assert_eq!(profile.growth().days_visited, 3);
}

#[test]
fn growth_survives_reopen() {
    let dir = std::env::temp_dir().join(format!(
        "pet-growth-persist-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let xp;
    {
        let mut engine = Engine::open(&dir).unwrap();
        engine.install(&spec("pet-growth-persist"), 0).unwrap();
        let base = 10 * DAY + 12 * 3_600_000;
        let mut last = PetProfile::new("pet-growth-persist", "测试宠物", 0);
        for index in 0..3u64 {
            last = engine.touch("pet-growth-persist", base + index * 2_000).unwrap();
        }
        xp = last.growth().xp;
        assert!(xp > 0);
        engine.flush().unwrap();
    }
    {
        let mut engine = Engine::open(&dir).unwrap();
        let profile = engine.profile("pet-growth-persist", 10 * DAY + 13 * 3_600_000).unwrap();
        assert_eq!(profile.growth().xp, xp, "养成账本必须跨会话保留");
        assert_eq!(profile.growth().touches, 3);
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn corrupt_state_json_falls_back_to_an_empty_ledger() {
    let limits = PetProfileLimits::default();
    let mut profile = PetProfile::new("pet-growth-bad", "测试宠物", 0);
    profile.state_json = "{not-json".to_string();
    let profile = profile.clamped(&limits);
    assert_eq!(profile.state_json, "{}");
    assert_eq!(profile.growth(), pet_core::profile::PetGrowth::default());

    /* 超长（手改库 / 恶意值）同样退回空账本，而不是让宠物读不出来 */
    let mut profile = PetProfile::new("pet-growth-big", "测试宠物", 0);
    profile.state_json = "x".repeat(10_000);
    let profile = profile.clamped(&limits);
    assert_eq!(profile.state_json, "{}");
}
