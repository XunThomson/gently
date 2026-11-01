//! 动画衔接：**不能一拍就跳**。
//!
//! 真实故障（R105）：走动时动画会「跑 → 待机 → 跑」闪一下。根因是宿主每 60ms 报一次走动方向，
//! 光标擦过宠物、窗口被挪动都会让某一拍报回 0；核心拿到 0 就立刻切 `idle`，下一拍照旧又切回 `run`。
//!
//! 现在的规则：
//! 1. 状态类动画要**连续请求满** `SWITCH_DELAY_MS`（160ms）才切；
//! 2. 带 `interrupt` 的动作（点击 / 换歌）不等，当拍就切——用户主动行为要有即时反馈；
//! 3. 单拍的抖动既不会切走、也不会把确认期清零重来（否则「一直在抖」就永远切不过去）。

use pet_core::{Input, PetProfile, PetSpec, PlaybackHint, Sim};

const SPEC: &str = r##"{
    "id": "pet-transition",
    "name": "衔接宠物",
    "version": "1.0.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9},
    "animations": [
        {"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0},
        {"name": "runRight", "frames": 8, "frameMs": 140, "loop": true, "row": 2},
        {"name": "jump", "frames": 5, "frameMs": 150, "loop": true, "row": 4}
    ],
    "behaviors": [
        {"when": {"kind": "clicked"}, "then": {"kind": "play", "animation": "jump", "interrupt": true}, "cooldownMs": 400},
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

struct Harness {
    spec: PetSpec,
    profile: PetProfile,
    sim: Sim,
}

impl Harness {
    fn new(seed: u64) -> Self {
        let spec = PetSpec::from_json(SPEC).expect("规格应当合法");
        let profile = PetProfile::new("pet-transition", "衔接宠物", 0);
        let sim = Sim::new(spec.clone(), seed);
        Self { spec, profile, sim }
    }

    fn name(&self, index: u16) -> String {
        self.spec
            .animations
            .get(index as usize)
            .map(|animation| animation.name.clone())
            .unwrap_or_default()
    }

    fn tick(&mut self, walk: Option<i8>) -> String {
        let frame = self.sim.tick(&input(walk), &self.profile);
        self.name(frame.animation)
    }

    fn ticks(&mut self, count: u32, walk: Option<i8>) -> String {
        let mut name = String::new();
        for _ in 0..count {
            name = self.tick(walk);
        }
        name
    }

    fn click(&mut self) -> String {
        let mut input = input(None);
        input.clicked = true;
        let frame = self.sim.tick(&input, &self.profile);
        self.name(frame.animation)
    }
}

#[test]
fn a_single_tick_of_silence_does_not_drop_the_walk_animation() {
    let mut harness = Harness::new(3);
    assert_eq!(harness.ticks(4, Some(1)), "runRight", "持续走 200ms 应该已经在跑");

    /* 一拍报回「没在走」（光标擦过宠物的典型情况）：不能切走 */
    assert_eq!(harness.tick(None), "runRight", "单拍抖动不该切回待机");

    /* 接着又报「在走」：仍然是跑，中间没有出现过 idle */
    assert_eq!(harness.ticks(2, Some(1)), "runRight");
}

#[test]
fn a_persistent_stop_switches_after_the_confirm_window() {
    let mut harness = Harness::new(3);
    assert_eq!(harness.ticks(4, Some(1)), "runRight");

    /* 150ms（3 拍）还不够确认 */
    assert_eq!(harness.ticks(3, None), "runRight", "确认期没到不该切");
    /* 第 4 拍（200ms）才切 */
    assert_eq!(harness.tick(None), "idle", "确认期满应该切到待机");
}

#[test]
fn a_blip_of_motion_cancels_the_pending_switch() {
    let mut harness = Harness::new(3);
    assert_eq!(harness.ticks(4, Some(1)), "runRight");

    /* 停了 100ms 又走起来：那一刻真的还在走，待定的切换该取消 */
    harness.tick(None);
    harness.tick(None);
    assert_eq!(harness.tick(Some(1)), "runRight", "又走起来了就该继续跑");

    /* 取消之后要重新攒满确认期，而不是立刻切 */
    assert_eq!(harness.ticks(3, None), "runRight");
    assert_eq!(harness.tick(None), "idle", "重新攒满确认期后才切");
}

#[test]
fn interrupt_actions_switch_on_the_same_tick() {
    let mut harness = Harness::new(3);
    assert_eq!(harness.ticks(4, Some(1)), "runRight");

    /* 点击带 interrupt：当拍就切，不等确认期 */
    assert_eq!(harness.click(), "jump", "点击要立刻有反馈");
}

#[test]
fn switching_restarts_the_frame_cursor() {
    let spec = PetSpec::from_json(SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-transition", "衔接宠物", 0);
    let mut sim = Sim::new(spec, 5);

    /* 先跑起来（帧游标会前进） */
    let mut frame = sim.tick(&input(Some(1)), &profile);
    for _ in 0..6 {
        frame = sim.tick(&input(Some(1)), &profile);
    }
    assert!(frame.frame > 0, "跑了一会儿帧游标应该前进过");

    /* 点一下 → 立刻切，帧游标归零（新动画从头播） */
    let mut click = input(Some(1));
    click.clicked = true;
    let frame = sim.tick(&click, &profile);
    assert_eq!(frame.frame, 0, "切动画时帧游标要归零");
}

