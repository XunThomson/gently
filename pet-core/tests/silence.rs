//! 「静默超过 N 毫秒」必须**真的**按时间判断（R106）。
//!
//! 真实缺口：`Condition::SilentFor` 以前只实现成 `!playing`——也就是「静默多久」这个条件
//! 一停止播放就立刻成立，`ms` 是个摆设。宠物包按 3 秒写的「安静一会儿再打哈欠」，
//! 实际会在一停播的那一拍就打哈欠。
//!
//! 这里锁三件事：静默要**够久**才成立；恢复播放立刻归零；`ms = 0` 等价于「没在播就算」。

use pet_core::{Input, PetProfile, PetSpec, PlaybackHint, Sim};

const SPEC: &str = r##"{
    "id": "pet-silence",
    "name": "安静的宠物",
    "version": "1.0.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9},
    "animations": [
        {"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0},
        {"name": "yawn", "frames": 4, "frameMs": 220, "loop": true, "row": 3},
        {"name": "listen", "frames": 6, "frameMs": 200, "loop": true, "row": 7}
    ],
    "behaviors": [
        {"when": {"kind": "silentFor", "ms": 3000}, "then": {"kind": "play", "animation": "yawn", "interrupt": true}, "cooldownMs": 0},
        {"when": {"kind": "playing"}, "then": {"kind": "play", "animation": "listen"}, "cooldownMs": 0},
        {"when": {"kind": "idle"}, "then": {"kind": "play", "animation": "idle"}, "cooldownMs": 0}
    ]
}"##;

fn input(playing: bool) -> Input {
    Input {
        dt_ms: 500,
        playback: PlaybackHint { playing, ..PlaybackHint::default() },
        pointer: None,
        clicked: false,
        look_dir: None,
        walk_dir: None,
    }
}

fn harness() -> (PetSpec, PetProfile, Sim) {
    let spec = PetSpec::from_json(SPEC).expect("规格应当合法");
    let profile = PetProfile::new("pet-silence", "安静的宠物", 0);
    let sim = Sim::new(spec.clone(), 9);
    (spec, profile, sim)
}

fn name(spec: &PetSpec, index: u16) -> String {
    spec.animations
        .get(index as usize)
        .map(|animation| animation.name.clone())
        .unwrap_or_default()
}

#[test]
fn silence_has_to_last_long_enough() {
    let (spec, profile, mut sim) = harness();
    let mut tick = |playing: bool| name(&spec, sim.tick(&input(playing), &profile).animation);

    /* 每拍 500ms：前 5 拍（2.5 秒）都不该打哈欠 */
    for elapsed in 1..=5 {
        assert_eq!(tick(false), "idle", "静默 {elapsed} 拍还不够 3 秒");
    }

    /* 第 6 拍（3.0 秒）：`yawn` 带 interrupt，当拍就切 */
    assert_eq!(tick(false), "yawn", "满 3 秒应当开始打哈欠");
}

#[test]
fn resuming_playback_resets_the_silence_clock() {
    let (spec, profile, mut sim) = harness();
    let mut tick = |playing: bool| name(&spec, sim.tick(&input(playing), &profile).animation);

    assert_eq!(tick(false), "idle");
    assert_eq!(tick(false), "idle");
    assert_eq!(tick(true), "listen", "恢复播放：走 playing 分支");
    /* 又停下来：计时必须从 0 重新开始（而不是接着之前的 1 秒），先回到待机 */
    assert_eq!(tick(false), "idle", "停播后先回到待机，不是立刻打哈欠");
    for elapsed in 2..=5 {
        assert_eq!(tick(false), "idle", "重新计时第 {elapsed} 拍还不够 3 秒");
    }
    assert_eq!(tick(false), "yawn", "重新攒满 3 秒才打哈欠");
}

#[test]
fn zero_milliseconds_means_immediately_when_silent() {
    let spec = PetSpec::from_json(&SPEC.replace("\"ms\": 3000", "\"ms\": 0")).unwrap();
    let profile = PetProfile::new("pet-silence", "安静的宠物", 0);
    let mut sim = Sim::new(spec.clone(), 9);
    let frame = sim.tick(&input(false), &profile);
    assert_eq!(name(&spec, frame.animation), "yawn", "ms = 0 时一停播就算静默");
}

