//! Codex Pet 兼容层：翻译（manifest → PetSpec）、边界（v2 拒绝）、以及真包能装上。

use pet_core::{CodexManifest, PetSpec};

mod common;

/// 社区里真实的 v1 manifest（`pets/aemeath-mini--cunuo/pet.json` 的结构）
const REAL_V1: &str = r##"{
  "id": "aemeath-mini--cunuo",
  "displayName": "Aemeath Mini",
  "description": "A Q-style pixel Aemeath companion with soft expressions and small animated desktop-pet motions.",
  "spritesheetPath": "spritesheet.webp",
  "kind": "character"
}"##;

#[test]
fn codex_v1_manifest_is_recognized_and_normalized() {
    assert!(CodexManifest::looks_like_codex(REAL_V1));
    let spec = CodexManifest::normalize(REAL_V1).expect("真实 Codex 包应当能翻译");

    assert_eq!(spec.id, "aemeath-mini--cunuo");
    assert_eq!(spec.name, "Aemeath Mini");
    assert_eq!(spec.atlas, "spritesheet.webp");
    let layout = spec.atlas_layout.expect("Codex 包用网格图集");
    assert_eq!((layout.frame_width, layout.frame_height), (192, 208));
    assert_eq!((layout.columns, layout.rows), (8, 9));

    /* 9 个动作按约定的行序补齐，作者不需要在包里写 */
    let names: Vec<&str> = spec.animations.iter().map(|animation| animation.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["idle", "runLeft", "runRight", "wave", "jump", "fail", "wait", "run", "inspect"]
    );
    for (index, animation) in spec.animations.iter().enumerate() {
        assert_eq!(animation.row, Some(index as u32), "第 {} 行就是第 {index} 个动作", animation.name);
        assert!(animation.frames <= layout.columns as usize, "帧数不能超过一行 8 格");
        assert!(animation.frame_ms > 0);
    }
    /* 行为表是通用默认（Codex 包本身不写行为） */
    assert!(spec.behaviors.len() >= 6);
    assert!(spec.behaviors.iter().any(|behavior| {
        matches!(&behavior.then, pet_core::Action::Play { animation, .. } if animation == "jump")
    }));
    /* 版本占位：Codex 包没有语义化版本，我们按格式版本给一个 */
    assert_eq!(spec.version, "1.0.1");
}

#[test]
fn codex_detection_does_not_hijack_our_own_format() {
    let ours = r##"{"id":"pet-own","name":"自己人","version":"1.0.0","atlas":"atlas.png",
        "animations":[{"name":"idle","frames":4,"frameMs":200}]}"##;
    assert!(!CodexManifest::looks_like_codex(ours), "没有 spritesheetPath 就不是 Codex 包");
    assert!(PetSpec::from_json(ours).is_ok(), "我们的格式仍然走原来的严格校验");
}

#[test]
fn codex_v2_gets_eleven_rows_and_a_look_table() {
    let v2 = REAL_V1.replace(r#""kind": "character""#, r#""kind": "character", "spriteVersionNumber": 2"#);
    let spec = CodexManifest::normalize(&v2).expect("v2 应当能翻译");
    let layout = spec.atlas_layout.unwrap();
    assert_eq!(layout.rows, 11, "v2 是 11 行");
    assert_eq!(spec.look_rows, Some([9, 10]), "后两行是 16 个 look 方向");
    assert_eq!(spec.animations.len(), 9, "动画仍是前 9 行");
    assert_eq!(spec.version, "1.0.2");
}

#[test]
fn codex_v3_is_rejected_with_a_readable_reason() {
    let v3 = REAL_V1.replace(r#""kind": "character""#, r#""kind": "character", "spriteVersionNumber": 3"#);
    let err = CodexManifest::normalize(&v3).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
    assert!(err.message.contains("v1") && err.message.contains("v2"), "错误要说明支持哪些版本：{}", err.message);
}

#[test]
fn codex_manifest_requires_a_plain_sheet_file_name() {
    let no_sheet = REAL_V1.replace(r#""spritesheetPath": "spritesheet.webp","#, "");
    assert_eq!(
        CodexManifest::normalize(&no_sheet).unwrap_err().code.as_str(),
        "pet.invalid_package"
    );

    let pathy = REAL_V1.replace("spritesheet.webp", "../spritesheet.webp");
    let err = CodexManifest::normalize(&pathy).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
    assert!(err.message.contains("纯文件名"), "{}", err.message);
}

/// 仓库里那份内置图集当作「用户提供的 Codex 包素材」，走一遍真实安装路径。
#[test]
fn a_codex_package_installs_through_the_same_engine() {
    let atlas = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../pets/gently-mascot/atlas.png"),
    )
    .expect("仓库里应有 atlas.png");

    let dir = common::temp_dir("pet-codex");
    let mut engine = pet_core::Engine::open(&dir).unwrap();
    let spec = engine
        .install_with_atlas(
            REAL_V1,
            Some(pet_core::PetAtlasInput {
                file: "spritesheet.webp".to_string(),
                data: atlas.clone(),
            }),
            0,
        )
        .expect("Codex 包应当能装进同一个引擎");

    assert_eq!(spec.id, "aemeath-mini--cunuo");
    let (file, bytes) = engine.atlas_of("aemeath-mini--cunuo").unwrap().expect("图集要能取回");
    assert_eq!(file, "spritesheet.webp");
    assert_eq!(bytes.len(), atlas.len());
    assert_eq!(engine.active_pet(), Some("aemeath-mini--cunuo"), "第一只装上的自动出战");
    std::fs::remove_dir_all(&dir).ok();
}



