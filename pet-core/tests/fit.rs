//! 显示适配（`animations[].fit`）：让「同一张图集里不同行画得大小不一」能被纠正。
//!
//! 真实故障（R105）：素材各行角色的实际比例差 ~20%，于是「待机 → 跑」时宠物会突然变大。
//! 核心只负责**校验**这份数据（渲染层按它缩放 + 对齐），因此这里锁两件事：
//! 1. 合法值能原样读出来（渲染层拿到的就是作者写的数）；
//! 2. 离谱值明确报错，而不是静默画错。

use pet_core::PetSpec;

const BASE: &str = r##"{
    "id": "pet-fit",
    "name": "适配宠物",
    "version": "1.0.0",
    "atlas": "atlas.png",
    "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9},
    "animations": [
        {"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0},
        {"name": "runRight", "frames": 8, "frameMs": 140, "loop": true, "row": 2, "fit": {"scale": 0.84}},
        {"name": "jump", "frames": 5, "frameMs": 150, "loop": true, "row": 4, "fit": {"scale": 0.93, "offsetX": 0, "offsetY": -4}}
    ],
    "behaviors": []
}"##;

#[test]
fn fit_values_round_trip_untouched() {
    let spec = PetSpec::from_json(BASE).expect("规格应当合法");
    let idle = &spec.animations[0];
    assert!(idle.fit.is_none(), "没写 fit 的动画不该被塞一个默认值");

    let run = spec.animations[1].fit.expect("runRight 写了 fit");
    assert!((run.scale - 0.84).abs() < f32::EPSILON, "scale 应原样保留：{}", run.scale);
    assert_eq!((run.offset_x, run.offset_y), (0, 0));

    let jump = spec.animations[2].fit.expect("jump 写了 fit");
    assert!((jump.scale - 0.93).abs() < f32::EPSILON);
    assert_eq!(jump.offset_y, -4);
}

#[test]
fn fit_scale_has_a_sane_range() {
    for (label, scale) in [("太小", 0.1_f32), ("太大", 9.0_f32)] {
        let spec = BASE.replace("\"scale\": 0.84", &format!("\"scale\": {scale}"));
        let error = PetSpec::from_json(&spec).expect_err(&format!("{label}的缩放应当被拒绝"));
        assert_eq!(error.code.as_str(), "pet.invalid_package", "{label}");
    }
}

#[test]
fn fit_offsets_cannot_push_the_sprite_out_of_the_grid() {
    /* 偏移上限是「一格」——超过一格就不只是微调了，一定是写错了 */
    let spec = BASE.replace("\"offsetY\": -4", "\"offsetY\": 4000");
    let error = PetSpec::from_json(&spec).expect_err("偏移过大应当被拒绝");
    assert_eq!(error.code.as_str(), "pet.invalid_package");
}

#[test]
fn fit_defaults_are_neutral() {
    /* 只写 scale 时偏移必须是 0（否则「缩一点」会顺手把角色挪走） */
    let spec = BASE.replace(
        "\"fit\": {\"scale\": 0.93, \"offsetX\": 0, \"offsetY\": -4}",
        "\"fit\": {\"scale\": 0.93}",
    );
    let spec = PetSpec::from_json(&spec).expect("规格应当合法");
    let jump = spec.animations[2].fit.expect("jump 写了 fit");
    assert_eq!((jump.offset_x, jump.offset_y), (0, 0));
}
