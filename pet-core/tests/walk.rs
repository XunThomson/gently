//! 走动：`Input.walk_dir` → `Condition::Walking` → 挑 `runLeft` / `runRight`。
//!
//! 核心不管「窗口挪到哪」——那是宿主的事。这里只锁两件事：
//! 1. 方向按 `signum` 归一（宿主给 ±1 或 ±5 都一样）；
//! 2. 行为表里 `walking{dir}` 与动画的对应关系真的生效。

use pet_core::{Input, PetProfile, PetSpec, PlaybackHint, Sim};

const SPEC: &str = r##"{
    "id": "pet-walk",
    "name": "会走的宠物",
    "version": "1.0.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9},
    "animations": [
        {"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0},
        {"name": "runLeft", "frames": 8, "frameMs": 140, "loop": true, "row": 1},
        {"name": "runRight", "frames": 8, "frameMs": 140, "loop": true, "row": 2}
    ],
    "behaviors": [
        {"when": {"kind": "walking", "dir": -1}, "then": {"kind": "play", "animation": "runLeft"}, "cooldownMs": 200},
        {"when": {"kind": "walking", "dir": 1}, "then": {"kind": "play", "animation": "runRight"}, "cooldownMs": 200},
        {"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "idle"}, "cooldownMs": 1000}
    ]
}"##;

fn input(walk: Option<i8>) -> Input {
    Input {
        dt_ms: 50,
        playback: PlaybackHint::default(),
        pointer: None,
        clicked: false,
        look_dir: None,
        walk_dir: walk,
    }
}

fn animation_name(spec: &PetSpec, index: u16) -> String {
    spec.animations
        .get(index as usize)
        .map(|animation| animation.name.clone())
        .unwrap_or_default()
}

/// 连推几拍让动画真有时间切过去（切换有 160ms 的确认期，见 `transition.rs`）
fn settle(sim: &mut Sim, profile: &PetProfile, walk: Option<i8>) -> u16 {
    let mut animation = 0;
    for _ in 0..4 {
        animation = sim.tick(&input(walk), profile).animation;
    }
    animation
}

#[test]
fn walking_picks_the_side_animation() {
    let spec = PetSpec::from_json(SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-walk", "会走的宠物", 0);
    let mut sim = Sim::new(spec.clone(), 11);

    let animation = settle(&mut sim, &profile, Some(-1));
    assert_eq!(animation_name(&spec, animation), "runLeft", "往左走要演 runLeft");

    let animation = settle(&mut sim, &profile, Some(1));
    assert_eq!(animation_name(&spec, animation), "runRight", "往右走要演 runRight");

    /* 停下：walking 条件不再成立，行为表回到 idle */
    let animation = settle(&mut sim, &profile, None);
    assert_eq!(animation_name(&spec, animation), "idle", "停下要回到待机");
}

#[test]
fn walking_direction_is_normalized_by_signum() {
    let spec = PetSpec::from_json(SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-walk", "会走的宠物", 0);
    let mut sim = Sim::new(spec.clone(), 12);

    /* 宿主可能给 -5 / 5 这种「速度」，核心按方向归一 */
    let animation = settle(&mut sim, &profile, Some(-5));
    assert_eq!(animation_name(&spec, animation), "runLeft");

    let animation = settle(&mut sim, &profile, Some(7));
    assert_eq!(animation_name(&spec, animation), "runRight");
}


