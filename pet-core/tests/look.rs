//! look（看向哪边）：方向透传 + 两行 look 的校验。
//!
//! 语义：`Input.look_dir` 是 16 方向（0 = 正上、顺时针），核心只做**规范化与透传**
//! （`Frame.look`）；挑哪一格由渲染层按 `lookRows` 决定——核心不认识「格子」。

use pet_core::{Input, PetProfile, PetSpec, PlaybackHint, Sim};

mod common;

fn spec_json(extra: &str) -> String {
    format!(
        r##"{{
            "id": "pet-look",
            "name": "会看的宠物",
            "version": "1.0.0",
            "atlas": "atlas.png",
            "atlasLayout": {{"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 11}},
            "lookRows": [9, 10],
            "animations": [
                {{"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0}},
                {{"name": "run", "frames": 6, "frameMs": 130, "loop": true, "row": 7}}
            ],
            "behaviors": [
                {{"when": {{"kind": "playing"}}, "then": {{"kind": "play", "animation": "run"}}, "cooldownMs": 6000}},
                {{"when": {{"kind": "idle"}}, "then": {{"kind": "play", "animation": "idle"}}, "cooldownMs": 1000}}
            ]
            {extra}
        }}"##
    )
}

fn input(look: Option<u8>) -> Input {
    Input {
        dt_ms: 50,
        playback: PlaybackHint::default(),
        pointer: None,
        clicked: false,
        look_dir: look,
        walk_dir: None,
    }
}

#[test]
fn v2_spec_with_look_rows_is_accepted() {
    let spec = PetSpec::from_json(&spec_json("")).expect("11 行 + lookRows 应当合法");
    assert_eq!(spec.look_rows, Some([9, 10]));
    assert_eq!(spec.atlas_layout.unwrap().rows, 11);
}

#[test]
fn two_look_rows_are_validated_against_the_sheet() {
    // 行号越界
    let bad = spec_json("").replace(r#""lookRows": [9, 10]"#, r#""lookRows": [9, 12]"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
    assert!(err.message.contains("超出图集"), "{}", err.message);

    // 两行写成同一行
    let bad = spec_json("").replace(r#""lookRows": [9, 10]"#, r#""lookRows": [9, 9]"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert!(err.message.contains("不能是同一行"), "{}", err.message);

    // 和动画的行号撞了（第 7 行是 run）
    let bad = spec_json("").replace(r#""lookRows": [9, 10]"#, r#""lookRows": [9, 7]"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert!(err.message.contains("撞"), "{}", err.message);

    // 一行不足 8 格：16 个方向放不下
    let bad = spec_json("").replace(r#""columns": 8"#, r#""columns": 6"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert!(err.message.contains("8 格"), "{}", err.message);
}

#[test]
fn look_direction_is_normalized_and_echoed() {
    let spec = PetSpec::from_json(&spec_json("")).unwrap();
    let profile = PetProfile::new("pet-look", "会看的宠物", 0);
    let mut sim = Sim::new(spec, 7);

    // 0..15 原样透传
    let frame = sim.tick(&input(Some(5)), &profile);
    assert_eq!(frame.look, Some(5));

    // 越界的值按 16 取模（宿主算方向时可能偷懒直接给角度）
    let frame = sim.tick(&input(Some(18)), &profile);
    assert_eq!(frame.look, Some(2), "18 % 16 = 2");

    // 没在看任何东西
    let frame = sim.tick(&input(None), &profile);
    assert_eq!(frame.look, None);
}

