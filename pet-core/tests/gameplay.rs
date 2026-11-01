//! 玩法地基测试（M3）：好感分档、饿的表现、喂食的效果。
//!
//! 这些断言全部**不依赖时钟**（`now_ms` 由测试给），锁住的是「数值怎么变」「行为怎么选」，
//! 而不是具体台词或动画美术。

mod common;

use pet_core::{
    dispatch, Engine, Input, PetMood, PetProfile, PetProfileLimits, PetSpec, PlaybackHint, Sim,
};

fn spec_json(id: &str) -> String {
    format!(
        r##"{{
            "id": "{id}",
            "name": "玩法宠物",
            "version": "1.0.0",
            "animations": [
                {{"name": "idle", "frames": 2, "frameMs": 200, "loop": true}},
                {{"name": "hungry", "frames": 2, "frameMs": 200, "loop": true}},
                {{"name": "close", "frames": 2, "frameMs": 200, "loop": true}}
            ],
            "behaviors": [
                {{"when": {{"kind": "hungry"}}, "then": {{"kind": "play", "animation": "hungry"}}, "cooldownMs": 100}},
                {{"when": {{"kind": "bondAtLeast", "tier": "close"}}, "then": {{"kind": "play", "animation": "close"}}, "cooldownMs": 100}},
                {{"when": {{"kind": "idle"}}, "then": {{"kind": "play", "animation": "idle"}}, "cooldownMs": 50}}
            ]
        }}"##
    )
}

fn input(dt_ms: u32) -> Input {
    Input { dt_ms, playback: PlaybackHint::default(), pointer: None, clicked: false, look_dir: None, walk_dir: None }
}

const HOUR_MS: u64 = 3_600_000;

#[test]
fn mood_is_derived_from_affection() {
    let limits = PetProfileLimits::default();
    let profile = |affection: i32| PetProfile {
        id: "m".into(),
        name: "m".into(),
        affection,
        hunger: 0,
        last_fed_at: 0,
        last_touched_at: 0,
        created_at: 0,
        updated_at: 0,
        state_json: "{}".into(),
    };

    assert_eq!(profile(0).mood(&limits), PetMood::Shy);
    assert_eq!(profile(limits.affection_friendly_at).mood(&limits), PetMood::Friendly);
    assert_eq!(profile(limits.affection_close_at).mood(&limits), PetMood::Close);
    assert_eq!(profile(limits.affection_devoted_at).mood(&limits), PetMood::Devoted);
    assert_eq!(profile(limits.max_affection).mood(&limits), PetMood::Devoted);

    // 分档是单调的：`bond_at_least` 不应出现「高档位反而 false」
    let maxed = profile(limits.max_affection);
    assert!(maxed.bond_at_least(&limits, PetMood::Shy));
    assert!(maxed.bond_at_least(&limits, PetMood::Devoted));
    assert!(!profile(0).bond_at_least(&limits, PetMood::Friendly));
}

#[test]
fn hunger_makes_the_pet_play_the_hungry_animation_and_feeding_fixes_it() {
    let dir = common::temp_dir("pet-gameplay-hungry");
    let mut engine = Engine::open(&dir).unwrap();
    let spec = engine.install(&spec_json("pet-hungry"), 0).unwrap();
    let hungry = spec.animation_index("hungry").unwrap() as u16;

    // 刚领养：不饿 → 不该走 hungry 分支（两条行为都不满足，动画停在 idle）
    let before = engine.tick("pet-hungry", &input(50), 1_000).unwrap();
    assert_ne!(before.animation, hungry, "刚领养不该表现为饿");

    // 过了 6 小时：每小时 +12 饿 → 72（阈值 60）→ 饿
    // 动画切换有 160ms 的确认期（防抖动），所以要多推几拍才会真的切过去
    let mut clock = 6 * HOUR_MS;
    let mut after_six_hours = engine.tick("pet-hungry", &input(50), clock).unwrap();
    for _ in 0..4 {
        clock += 50;
        after_six_hours = engine.tick("pet-hungry", &input(50), clock).unwrap();
    }
    assert_eq!(after_six_hours.animation, hungry, "饿了应该切到 hungry 动画");

    // 喂食：饥饿归零、好感 +5；再 tick 不该再是饿
    let fed = dispatch(
        &mut engine,
        "pet.interact",
        serde_json::json!({ "id": "pet-hungry", "kind": "feed" }),
        6 * HOUR_MS + 1_000,
    )
    .unwrap();
    assert_eq!(fed["hungry"], serde_json::json!(false), "{fed}");
    // 喂食抵消 40 点饿：6 小时后的 72 → 32（不会一口气归零，这也是「喂一次管一天」的语义）
    assert_eq!(fed["profile"]["hunger"], serde_json::json!(32), "{fed}");
    assert_eq!(fed["mood"], serde_json::json!("shy"), "{fed}");

    let mut clock = 6 * HOUR_MS + 2_000;
    let mut after_feed = engine.tick("pet-hungry", &input(50), clock).unwrap();
    for _ in 0..4 {
        clock += 50;
        after_feed = engine.tick("pet-hungry", &input(50), clock).unwrap();
    }
    assert_ne!(after_feed.animation, hungry, "喂过之后不该还表现为饿");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn high_affection_unlocks_the_close_behavior() {
    // 直接用状态机：把一个「好感已经到 close」的资料喂进去，看行为是否切到 close 动画
    let spec = PetSpec::from_json(&spec_json("pet-close")).unwrap();
    let close_index = spec.animation_index("close").unwrap() as u16;
    let limits = PetProfileLimits::default();
    let profile = PetProfile {
        id: "pet-close".into(),
        name: "玩法宠物".into(),
        affection: limits.affection_close_at,
        hunger: 0,
        last_fed_at: 0,
        last_touched_at: 0,
        created_at: 0,
        updated_at: 0,
        state_json: "{}".into(),
    };

    let mut sim = Sim::with_limits(spec, limits, 7);
    // 确认期 160ms：连推 4 拍（200ms）后才切
    let mut frame = sim.tick(&input(50), &profile);
    for _ in 0..3 {
        frame = sim.tick(&input(50), &profile);
    }
    assert_eq!(frame.animation, close_index, "好感到位后应该走 close 分支");

    // 好感不足时同样的规格不会触发 close（否则「分档」等于没有）
    let mut shy_sim = Sim::with_limits(
        PetSpec::from_json(&spec_json("pet-close")).unwrap(),
        limits,
        7,
    );
    let mut low = profile.clone();
    low.affection = 0;
    let frame = shy_sim.tick(&input(50), &low);
    assert_ne!(frame.animation, close_index);
}

#[test]
fn feed_cooldown_and_touch_do_not_cross_wire() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-cooldown"), 0).unwrap();
    let limits = PetProfileLimits::default();

    let first = dispatch(
        &mut engine,
        "pet.interact",
        serde_json::json!({ "id": "pet-cooldown", "kind": "feed" }),
        1_000,
    )
    .unwrap();
    // 分发成功时返回的是数据本身（不是信封；信封由宿主包）
    assert!(first["profile"].is_object(), "{first}");

    // 冷却内再喂：错误里要带剩余毫秒（界面据此显示「还要等多久」）
    let second = dispatch(
        &mut engine,
        "pet.interact",
        serde_json::json!({ "id": "pet-cooldown", "kind": "feed" }),
        2_000,
    )
    .unwrap_err();
    assert_eq!(second.code.as_str(), "pet.invalid_argument");
    assert!(second.message.contains("毫秒"), "{}", second.message);
    assert!(limits.feed_cooldown_ms > 1_000);
}

#[test]
fn flush_persists_the_latest_ticks_so_quitting_does_not_lose_them() {
    let dir = common::temp_dir("pet-flush");
    let mut engine = Engine::open(&dir).unwrap();
    engine.install(&spec_json("pet-flush"), 0).unwrap();

    // 连续推进（每 200 帧才写回一次）：此时库里可能还是旧值
    for step in 0..150u32 {
        engine
            .tick("pet-flush", &input(50), 1_000 + step as u64 * 50)
            .unwrap();
    }
    // 退出前 flush：把内存里的最新资料写回
    engine.flush().unwrap();
    drop(engine);

    let mut reopened = Engine::open(&dir).unwrap();
    let profile = reopened.profile("pet-flush", 1_000 + 150 * 50).unwrap();
    // 150 帧 = 7.5 秒；游走状态不落库，但「时间戳/资料」必须是最后一次推进的
    assert_eq!(profile.id, "pet-flush");
    assert!(profile.updated_at >= 1_000, "flush 之后 updated_at 应该被推进：{profile:?}");
    assert_eq!(reopened.active_pet(), Some("pet-flush"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn state_reports_mood_and_hunger_for_the_panel() {
    let dir = common::temp_dir("pet-gameplay-state");
    let mut engine = Engine::open(&dir).unwrap();
    engine.install(&spec_json("pet-panel"), 0).unwrap();

    let value = dispatch(&mut engine, "pet.state", serde_json::json!({}), 6 * HOUR_MS).unwrap();
    assert_eq!(value["pets"][0]["mood"], serde_json::json!("shy"), "{value}");
    // 6 小时后已经饿了（每小时 +12，阈值 60）
    assert_eq!(value["pets"][0]["hungry"], serde_json::json!(true), "{value}");

    std::fs::remove_dir_all(&dir).ok();
}



