//! 行为 ↔ 动画 ↔ 位移能力（R139）。
//!
//! 用户反馈：「坐下的动画还在平移」。修法不是靠动画名字猜，而是让动画自己声明
//! `motion`，宿主读 `Frame.motion` 门控窗口位移。这里锁住四件事：
//! 1. 声明 walk 的动画（跑）→ `Frame.motion = walk`；
//! 2. 声明 none 的动画（坐）→ `Frame.motion = none`，即使宿主一直给 `walk_dir`；
//! 3. 一个都没声明的旧包 → 全部 `walk`（零回归）；
//! 4. 严格模式下的自相矛盾（walking 指向 none / 没有任何可位移动画）→ 安装时拒绝。

use pet_core::{Input, Motion, PetProfile, PetSpec, PlaybackHint, Sim};

const SPEC: &str = r##"{
    "id": "pet-motion",
    "name": "会坐也会走",
    "version": "1.1.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 3},
    "animations": [
        {"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0, "motion": "none"},
        {"name": "runLeft", "frames": 8, "frameMs": 140, "loop": true, "row": 1, "motion": "walk"},
        {"name": "runRight", "frames": 8, "frameMs": 140, "loop": true, "row": 2, "motion": "walk"}
    ],
    "behaviors": [
        {"when": {"kind": "walking", "dir": -1}, "then": {"kind": "play", "animation": "runLeft"}},
        {"when": {"kind": "walking", "dir": 1}, "then": {"kind": "play", "animation": "runRight"}},
        {"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "idle"}}
    ]
}"##;

const SIT_SPEC: &str = r##"{
    "id": "pet-sit",
    "name": "只会坐",
    "version": "1.0.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 2},
    "animations": [
        {"name": "sit", "frames": 4, "frameMs": 200, "loop": true, "row": 0, "motion": "none"},
        {"name": "runLeft", "frames": 8, "frameMs": 140, "loop": true, "row": 1, "motion": "walk"}
    ],
    "behaviors": [
        {"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "sit"}},
        {"when": {"kind": "walking", "dir": -1}, "then": {"kind": "play", "animation": "runLeft"}}
    ]
}"##;

const LEGACY_SPEC: &str = r##"{
    "id": "pet-legacy",
    "name": "旧包",
    "version": "1.0.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 1},
    "animations": [
        {"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0}
    ],
    "behaviors": [
        {"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "idle"}}
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

fn settle(sim: &mut Sim, profile: &PetProfile, walk: Option<i8>) -> (u16, Motion) {
    let mut last = sim.tick(&input(walk), profile);
    for _ in 0..5 {
        last = sim.tick(&input(walk), profile);
    }
    (last.animation, last.motion)
}

#[test]
fn walking_animation_declares_walk_motion() {
    let spec = PetSpec::from_json(SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-motion", "会坐也会走", 0);
    let mut sim = Sim::new(spec.clone(), 21);

    let (animation, motion) = settle(&mut sim, &profile, Some(1));
    assert_eq!(spec.animations[animation as usize].name, "runRight");
    assert_eq!(motion, Motion::Walk, "跑动动画必须允许位移");
}

#[test]
fn sitting_animation_never_allows_motion_even_when_host_keeps_walking() {
    let spec = PetSpec::from_json(SIT_SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-sit", "只会坐", 0);
    let mut sim = Sim::new(spec.clone(), 22);

    /* 先坐稳：步行条件不成立，行为表回到 sit */
    let (animation, motion) = settle(&mut sim, &profile, None);
    assert_eq!(spec.animations[animation as usize].name, "sit");
    assert_eq!(motion, Motion::None, "坐下的动画不允许平移");

    /* 宿主仍然给 walk_dir：如果 walking 行为优先级更高，该切跑；否则坐姿保持不变 */
    let (animation, motion) = settle(&mut sim, &profile, Some(1));
    let name = &spec.animations[animation as usize].name;
    if name == "sit" {
        assert_eq!(motion, Motion::None, "坐姿播放期间不允许平移");
    } else {
        assert_eq!(name, "runLeft");
        assert_eq!(motion, Motion::Walk);
    }
}

#[test]
fn legacy_packages_without_motion_stay_walkable() {
    let spec = PetSpec::from_json(LEGACY_SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-legacy", "旧包", 0);
    let mut sim = Sim::new(spec, 23);

    let (_, motion) = settle(&mut sim, &profile, None);
    assert_eq!(motion, Motion::Walk, "没声明 motion 的旧包必须保持原来的可走动行为");
}

#[test]
fn walking_behavior_pointing_at_static_animation_is_rejected() {
    let broken = SPEC.replace(
        r#"{"when": {"kind": "walking", "dir": 1}, "then": {"kind": "play", "animation": "runRight"}}"#,
        r#"{"when": {"kind": "walking", "dir": 1}, "then": {"kind": "play", "animation": "idle"}}"#,
    );
    let error = PetSpec::from_json(&broken).expect_err("walking 指向 none 动画必须报错");
    assert_eq!(error.code.as_str(), "pet.invalid_package");
}

#[test]
fn declaring_motion_without_any_movable_animation_is_rejected() {
    let broken = SPEC.replace(r#", "motion": "walk""#, r#", "motion": "none""#);
    let broken = broken.replace(
        r#"{"when": {"kind": "walking", "dir": 1}, "then": {"kind": "play", "animation": "runRight"}}"#,
        r#"{"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "runRight"}}"#,
    );
    let broken = broken.replace(
        r#"{"when": {"kind": "walking", "dir": -1}, "then": {"kind": "play", "animation": "runLeft"}}"#,
        r#"{"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "runLeft"}}"#,
    );
    let error = PetSpec::from_json(&broken).expect_err("声明了 motion 但没有任何可位移动画必须报错");
    assert_eq!(error.code.as_str(), "pet.invalid_package");
}
