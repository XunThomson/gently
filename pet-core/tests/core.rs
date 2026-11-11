//! pet-core 的地基测试：确定性、跨会话存储、规格校验、单/多宠物。
//!
//! 这些断言刻意都**不依赖时钟**（`now_ms` 由测试给），因此既不会偶发失败，
//! 也能锁住「同样输入 → 同样帧序列」这条承诺。

use pet_core::{
    Engine, Input, PetProfileLimits, PetSpec, PlaybackHint, SpecLimits, MAX_ANIMATIONS,
    MAX_FRAMES_PER_ANIMATION,
};

mod common;

/// 一份合法的宠物规格（两个动画 + 三条行为）
fn spec_json(id: &str) -> String {
    format!(
        r##"{{
            "id": "{id}",
            "name": "测试宠物",
            "version": "1.0.0",
            "author": "tester",
            "atlas": "atlas.png",
            "animations": [
                {{"name": "idle", "frames": 4, "frameMs": 200, "loop": true}},
                {{"name": "happy", "frames": 2, "frameMs": 120, "loop": false}}
            ],
            "behaviors": [
                {{"when": {{"kind": "clicked"}}, "then": {{"kind": "play", "animation": "happy", "interrupt": true}}, "cooldownMs": 300}},
                {{"when": {{"kind": "playing"}}, "then": {{"kind": "play", "animation": "happy"}}, "cooldownMs": 5000}},
                {{"when": {{"kind": "idle"}}, "then": {{"kind": "say", "textKey": "pet.idle"}}, "cooldownMs": 60000}}
            ]
        }}"##
    )
}

fn input(dt_ms: u32) -> Input {
    Input { dt_ms, playback: PlaybackHint::default(), pointer: None, clicked: false, look_dir: None, walk_dir: None }
}

#[test]
fn tick_is_deterministic_for_the_same_inputs() {
    let spec = PetSpec::from_json(&spec_json("pet-det")).unwrap();
    let profile_a = pet_core::PetProfile::new("pet-det", "测试宠物", 0);
    let profile_b = profile_a.clone();

    let mut left = pet_core::Sim::new(spec.clone(), 42);
    let mut right = pet_core::Sim::new(spec, 42);

    let mut left_frames = Vec::new();
    let mut right_frames = Vec::new();
    for step in 0..200u32 {
        let mut frame_input = input(50);
        // 中间穿插一次点击与一次「在播放」，验证条件分支也确定
        if step == 30 {
            frame_input.clicked = true;
            frame_input.playback = PlaybackHint { playing: true, elapsed_ms: 1_000, ..Default::default() };
        }
        if step == 120 {
            frame_input.pointer = Some((10, 10));
        }
        left_frames.push(left.tick(&frame_input, &profile_a));
        right_frames.push(right.tick(&frame_input, &profile_b));
    }

    assert_eq!(left_frames, right_frames, "同样的输入必须得到同样的帧序列");
    // 顺带确认动画真的推进过（不是一直停在第 0 帧）
    assert!(left_frames.iter().any(|frame| frame.frame > 0), "动画时间轴没有推进");
    assert!(left_frames.iter().any(|frame| frame.bubble.is_some()), "气泡行为没有触发");
}

#[test]
fn clicked_switches_to_the_happy_animation() {
    let engine_spec = spec_json("pet-click");
    let mut engine = Engine::open_in_memory().unwrap();
    let spec = engine.install(&engine_spec, 1_000).unwrap();
    let happy = spec.animation_index("happy").unwrap();

    // 先空转两帧（待机）
    let _ = engine.tick("pet-click", &input(50), 1_100).unwrap();
    let mut click = input(50);
    click.clicked = true;
    let frame = engine.tick("pet-click", &click, 1_150).unwrap();
    assert_eq!(frame.animation, happy, "点击应该切到 happy 动画");
    assert_eq!(frame.frame, 0, "切动画时帧游标要归零");
}

#[test]
fn cross_session_profile_survives_reopen_and_is_clamped() {
    let dir = common::temp_dir("pet-store");
    let spec = spec_json("pet-persist");

    {
        let mut engine = Engine::open(&dir).unwrap();
        engine.install(&spec, 1_000).unwrap();
        engine.set_active("pet-persist").unwrap();
        /* R139：不饿时喂食不再加好感（防刷）。先让时间过去 5 小时把饥饿抬到阈值以上。 */
        let later = 1_000 + 5 * 3_600_000;
        let profile = engine.feed("pet-persist", later).unwrap();
        let limits = PetProfileLimits::default();
        assert_eq!(profile.affection, limits.feed_affection_gain);
        assert!(
            profile.hunger < limits.hunger_hungry_at,
            "喂食后应该不再处于「饿」的状态"
        );
        // 连点第二下：冷却内被拒绝（不是静默）
        let error = engine.feed("pet-persist", later + 500).unwrap_err();
        assert_eq!(error.code.as_str(), "pet.invalid_argument");
        engine.flush().unwrap();
    }

    {
        // 重开：资料必须还在（跨会话）
        let mut engine = Engine::open(&dir).unwrap();
        let profile = engine.profile("pet-persist", 1_000 + 5 * 3_600_000 + 600).unwrap();
        assert!(profile.affection >= PetProfileLimits::default().feed_affection_gain);
        assert_eq!(engine.active_pet(), Some("pet-persist"));
        let listed = engine.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0.name, "测试宠物");
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn time_away_causes_decay_but_never_negative() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-decay"), 0).unwrap();
    engine.touch("pet-decay", 0).unwrap();

    // 关掉 10 小时再回来：好感按每小时 2 点衰减，饥饿每小时 +12（夹在上限内）
    let ten_hours = 10 * 3_600_000u64;
    let profile = engine.profile("pet-decay", ten_hours).unwrap();
    let limits = PetProfileLimits::default();
    assert_eq!(profile.affection, 0, "从 1 点开始衰减 20 点应该夹到 0");
    assert!(profile.hunger <= limits.max_hunger, "饥饿不能越界");
    assert!(profile.hunger > 0, "过了 10 小时应该饿了");
}

#[test]
fn touch_is_throttled_but_not_an_error() {
    let mut engine = Engine::open_in_memory().unwrap();
    let limits = PetProfileLimits::default();
    engine.install(&spec_json("pet-touch"), 0).unwrap();

    let first = engine.touch("pet-touch", 10_000).unwrap();
    let second = engine.touch("pet-touch", 10_100).unwrap();
    assert_eq!(first.affection, second.affection, "冷却内的触摸不该继续加好感");
    assert_eq!(second.affection, limits.touch_affection_gain);
}

#[test]
fn reinstall_keeps_affection_and_updates_spec() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-upgrade"), 0).unwrap();
    let fed = engine.feed("pet-upgrade", 100_000).unwrap();

    // 覆盖安装（比如宠物包升级）：好感不能被清零
    let upgraded = spec_json("pet-upgrade").replace("测试宠物", "测试宠物 v2");
    engine.install(&upgraded, 200_000).unwrap();
    let after = engine.profile("pet-upgrade", 200_000).unwrap();
    assert_eq!(after.affection, fed.affection, "升级宠物包不该清空养出来的好感");
    assert_eq!(after.name, "测试宠物 v2");
}

#[test]
fn invalid_specs_are_rejected_with_readable_reasons() {
    // 不存在的动画
    let bad = spec_json("pet-bad").replace("\"animation\": \"happy\"", "\"animation\": \"nope\"");
    let error = PetSpec::from_json(&bad).unwrap_err();
    assert_eq!(error.code.as_str(), "pet.invalid_package");
    assert!(error.message.contains("nope"), "原因要指出具体名字：{}", error.message);

    // 非法 id（含路径分隔符）
    let bad = spec_json("pet-bad").replace("\"id\": \"pet-bad\"", "\"id\": \"../bad\"");
    assert_eq!(PetSpec::from_json(&bad).unwrap_err().code.as_str(), "pet.invalid_package");

    // 空动画表
    let bad = spec_json("pet-bad").replace(
        r#""animations": [
                {"name": "idle", "frames": 4, "frameMs": 200, "loop": true},
                {"name": "happy", "frames": 2, "frameMs": 120, "loop": false}
            ]"#,
        r#""animations": []"#,
    );
    assert_eq!(PetSpec::from_json(&bad).unwrap_err().code.as_str(), "pet.invalid_package");

    // 帧数超限 → limit_exceeded（不是 invalid_package：数量问题与结构问题要分开）
    let mut spec = PetSpec::from_json(&spec_json("pet-bad")).unwrap();
    spec.animations[0].frames = MAX_FRAMES_PER_ANIMATION + 1;
    assert_eq!(spec.validate().unwrap_err().code.as_str(), "pet.limit_exceeded");

    // 动画数超限
    let mut spec = PetSpec::from_json(&spec_json("pet-bad")).unwrap();
    for index in 0..=MAX_ANIMATIONS {
        spec.animations.push(pet_core::Animation {
            name: format!("extra-{index}"),
            frames: 1,
            frame_ms: 100,
            r#loop: true,
            row: None,
            fit: None,
            motion: None,
        });
    }
    assert_eq!(spec.validate().unwrap_err().code.as_str(), "pet.limit_exceeded");

    // atlas 只能是纯文件名
    let mut spec = PetSpec::from_json(&spec_json("pet-bad")).unwrap();
    spec.atlas = "../atlas.png".to_string();
    assert_eq!(spec.validate().unwrap_err().code.as_str(), "pet.invalid_package");
}

#[test]
fn single_pet_display_but_multi_pet_storage_is_reserved() {
    let dir = common::temp_dir("pet-multi");
    let mut engine = Engine::open(&dir).unwrap();
    engine.install(&spec_json("pet-a"), 0).unwrap();
    engine.install(&spec_json("pet-b"), 0).unwrap();

    // 存得下多只（为将来独立仓库预留），但「出战」只有一只
    assert_eq!(engine.list().unwrap().len(), 2);
    assert_eq!(engine.active_pet(), Some("pet-a"), "第一只装上的自动出战");
    engine.set_active("pet-b").unwrap();
    assert_eq!(engine.active_pet(), Some("pet-b"));
    assert_eq!(engine.profile("pet-a", 1_000).unwrap().id, "pet-a", "非出战宠物的资料仍然可读");

    // 卸载出战宠物后出战位置清空
    assert!(engine.remove("pet-b").unwrap());
    assert_eq!(engine.active_pet(), None);
    assert_eq!(engine.list().unwrap().len(), 1);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn schema_is_owned_by_pet_core() {
    let dir = common::temp_dir("pet-schema");
    let engine = Engine::open(&dir).unwrap();
    assert_eq!(engine.schema_version().unwrap(), pet_core::store::SCHEMA_VERSION);
    // 数据库文件就在宿主给的目录里（独立于音乐库）
    assert!(engine.db_path().ends_with(pet_core::store::PET_DB_FILE));
    assert!(dir.join(pet_core::store::PET_DB_FILE).is_file());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn limits_are_single_sourced() {
    // 默认值只在一个地方定义；这里锁住边界语义，避免以后各处硬编码
    let limits = PetProfileLimits::default();
    assert!(limits.max_affection > 0 && limits.max_hunger > 0);
    assert!(limits.feed_cooldown_ms > 0 && limits.touch_cooldown_ms > 0);
    let spec_limits = SpecLimits::default();
    assert_eq!(spec_limits.max_animations, MAX_ANIMATIONS);
    assert_eq!(spec_limits.max_frames, MAX_FRAMES_PER_ANIMATION);
}




