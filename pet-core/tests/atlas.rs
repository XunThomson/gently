//! 图集布局的校验：单行帧条（老格式）与网格 sprite sheet（M4 新增）。
//!
//! 为什么值得单测：网格里「行 / 列 / 帧数」三者是**同一张图的三种坐标**，
//! 写错任何一个只会表现成「画出来是半个头」，在界面上极难定位。

use pet_core::{AtlasLayout, PetSpec, MAX_ATLAS_COLUMNS};

mod common;

/// 一份 9 行 × 8 格的网格规格（结构照抄示例包，数值缩小到好读）
fn grid_json(extra: &str) -> String {
    format!(
        r##"{{
            "id": "pet-grid",
            "name": "网格宠物",
            "version": "1.0.0",
            "atlas": "atlas.png",
            "atlasLayout": {{"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 3}},
            "animations": [
                {{"name": "idle", "frames": 6, "frameMs": 240, "loop": true, "row": 0}},
                {{"name": "sleepy", "frames": 4, "frameMs": 420, "loop": true, "row": 1}},
                {{"name": "listen", "frames": 6, "frameMs": 200, "loop": true}}
            ],
            "behaviors": [
                {{"when": {{"kind": "playing"}}, "then": {{"kind": "play", "animation": "listen"}}, "cooldownMs": 5000}},
                {{"when": {{"kind": "idle"}}, "then": {{"kind": "play", "animation": "idle"}}, "cooldownMs": 1200}}
            ]
            {extra}
        }}"##
    )
}

#[test]
fn grid_layout_is_accepted_and_rows_are_explicit_or_implicit() {
    let spec = PetSpec::from_json(&grid_json("")).unwrap();
    let layout = spec.atlas_layout.expect("有 atlasLayout");
    assert_eq!((layout.frame_width, layout.frame_height), (192, 208));
    assert_eq!((layout.columns, layout.rows), (8, 3));
    // 写了 row 的按写的来；没写的按声明顺序（第三个动画 = 第 2 行）
    assert_eq!(spec.animations[0].row, Some(0));
    assert_eq!(spec.animations[1].row, Some(1));
    assert_eq!(spec.animations[2].row, None, "第 3 个动画没写 row：按声明顺序取第 2 行");
}

#[test]
fn grid_rejects_a_frame_count_wider_than_one_row() {
    // 9 帧但一行只有 8 格：帧会溢出到下一行，画出来是「两个半身的拼贴」
    let bad = grid_json("").replace(r#""frames": 6, "frameMs": 200"#, r#""frames": 9, "frameMs": 200"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
    assert!(err.message.contains("一行只有 8 格"), "错误要说清是哪条动画：{err}");
}

#[test]
fn grid_rejects_a_row_outside_the_sheet() {
    let bad = grid_json("").replace(r#""row": 1"#, r#""row": 7"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
    assert!(err.message.contains("只有 3 行"), "错误要给出行数：{err}");

    // 隐含行号同样要落在图里：三个动画 → 第 3 个隐含第 2 行；把 rows 改成 2 就超了
    let bad = grid_json("").replace(r#""rows": 3"#, r#""rows": 2"#);
    let err = PetSpec::from_json(&bad).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
}

#[test]
fn grid_requires_an_image_and_a_row_requires_a_grid() {
    // 有网格却没有图：无从画起
    let no_atlas = grid_json("").replace(r#""atlas": "atlas.png","#, "");
    assert_eq!(
        PetSpec::from_json(&no_atlas).unwrap_err().code.as_str(),
        "pet.invalid_package"
    );

    // 写了 row 却是单行帧条：宁可报错，也不静默忽略（作者会以为行号生效了）
    let no_layout = grid_json("")
        .replace(r#""atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 3},"#, "");
    let err = PetSpec::from_json(&no_layout).unwrap_err();
    assert_eq!(err.code.as_str(), "pet.invalid_package");
    assert!(err.message.contains("atlasLayout"), "错误要指名缺什么：{err}");
}

#[test]
fn grid_rejects_nonsense_cell_geometry() {
    let zero_cell = grid_json("").replace(r#""frameWidth": 192"#, r#""frameWidth": 0"#);
    assert_eq!(
        PetSpec::from_json(&zero_cell).unwrap_err().code.as_str(),
        "pet.invalid_package"
    );

    let zero_rows = grid_json("").replace(r#""rows": 3"#, r#""rows": 0"#);
    assert_eq!(
        PetSpec::from_json(&zero_rows).unwrap_err().code.as_str(),
        "pet.invalid_package"
    );

    // 防呆上限：数量问题报 limit_exceeded，与结构问题区分
    let huge = grid_json("").replace(
        r#""columns": 8"#,
        &format!(r#""columns": {}"#, MAX_ATLAS_COLUMNS + 1),
    );
    assert_eq!(
        PetSpec::from_json(&huge).unwrap_err().code.as_str(),
        "pet.limit_exceeded"
    );
}

#[test]
fn layout_struct_round_trips_through_json() {
    // 序列化字段名是跨语言契约的一部分：前端按 camelCase 读
    let layout = AtlasLayout { frame_width: 192, frame_height: 208, columns: 8, rows: 9 };
    let text = serde_json::to_string(&layout).unwrap();
    assert_eq!(
        text,
        r#"{"frameWidth":192,"frameHeight":208,"columns":8,"rows":9}"#
    );
    let back: AtlasLayout = serde_json::from_str(&text).unwrap();
    assert_eq!(back, layout);
}

/// 仓库里那份**真正的**宠物包（也就是内置宠物）：规格要能过校验、图集要能装进去。
///
/// 这是防止「示例/内置包悄悄写坏了」的唯一自动化关口——界面上的症状只是「宠物不出现」，
/// 而根因在包里的一个字段名。
#[test]
fn shipped_pet_package_validates_and_installs() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../pets/gently-mascot");
    let spec_json = std::fs::read_to_string(root.join("pet.json")).expect("仓库里应有 pet.json");
    let atlas_bytes = std::fs::read(root.join("atlas.png")).expect("仓库里应有 atlas.png");

    let spec = PetSpec::from_json(&spec_json).expect("内置宠物包必须通过校验");
    assert_eq!(spec.id, "gently-mascot");
    let layout = spec.atlas_layout.expect("内置宠物用网格图集");
    assert_eq!((layout.frame_width, layout.frame_height), (192, 208));
    assert_eq!(spec.animations.len(), 9, "9 行各一个动画");
    /* **行号是素材事实，不是声明顺序**：内置图集里「往右跑」贴在第 1 行、「往左跑」贴在第 2 行，
       而包里按语义（先左后右）声明，两者本来就不必同序。这里守的是「9 个动作各占一行、
       不重不漏」，而不是「第 N 个动画必须落在第 N 行」——后者只是巧合，写成断言会让
       换素材的人误以为包里写错了（R109 发现：这条断言与仓库里的包长期不一致）。 */
    let mut rows: Vec<u32> = spec.animations.iter().map(|a| a.row.expect("网格图集必须给行号")).collect();
    rows.sort_unstable();
    assert_eq!(rows, (0..9).collect::<Vec<u32>>(), "9 个动作应当不重不漏地占满 9 行");
    let row_of = |name: &str| {
        spec.animations.iter().find(|a| a.name == name).and_then(|a| a.row)
    };
    assert_eq!(row_of("idle"), Some(0), "待机固定在第 0 行（素材第一格）");
    assert_eq!(row_of("runRight"), Some(1), "往右跑在第 1 行");
    assert_eq!(row_of("runLeft"), Some(2), "往左跑在第 2 行");
    let names: Vec<&str> = spec.animations.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["idle", "runLeft", "runRight", "wave", "jump", "fail", "wait", "run", "inspect"],
        "动作名按素材给的 9 个顺序（改名必须同步文档与行为表）"
    );
    assert_eq!(spec.version, "1.0.4", "内置宠物随宠物核心进到 1.0（行为表/显示适配变了要升版本，渲染器才会重装）");
    /* 内置包用了 `fit` 与 `interrupt`（都是 R105/R106 的能力）：所以它必须声明要求核心版本，
       而且本机核心必须满足它——否则内置包自己就装不上（这条断言就是那个保险丝） */
    let minimum = pet_core::Version::parse(&spec.min_pet_core_version).expect("minPetCoreVersion 要能解析");
    let current = pet_core::Version::current().expect("核心版本要能解析");
    assert!(current.satisfies(minimum), "内置包要求的核心版本（{minimum}）比当前核心（{current}）还新");

    /* 内置素材各行角色画得大小不一（实测差 ~20%）：默认包里必须带 fit，否则「待机 → 跑」会突然变大 */
    assert!(
        spec.animations.iter().filter(|animation| animation.fit.is_some()).count() >= 6,
        "内置包应当给大小不一的行写 fit"
    );
    let idle = spec.animations.iter().find(|animation| animation.name == "idle").unwrap();
    let run_left = spec.animations.iter().find(|animation| animation.name == "runLeft").unwrap();
    assert!(idle.fit.is_none(), "待机是基准，不该被缩放");
    assert!(
        run_left.fit.map(|fit| fit.scale) .is_some_and(|scale| scale < 1.0),
        "跑动素材偏大，应当被缩小"
    );

    let dir = common::temp_dir("pet-shipped");
    let mut engine = pet_core::Engine::open(&dir).unwrap();
    let spec = engine
        .install_with_atlas(
            &spec_json,
            Some(pet_core::PetAtlasInput { file: "atlas.png".to_string(), data: atlas_bytes.clone() }),
            0,
        )
        .unwrap();
    assert!(!spec.version.is_empty());
    let (file, bytes) = engine
        .atlas_of("gently-mascot")
        .unwrap()
        .expect("装完之后图集应当取得到");
    assert_eq!(file, "atlas.png");
    assert_eq!(bytes.len(), atlas_bytes.len(), "图集要原样落盘（不做有损处理）");

    /* 校验和：装的时候记过，读的时候比对——文件被改坏时不能把坏图当素材画出去 */
    let path = dir.join("packages").join("gently-mascot").join("atlas.png");
    std::fs::write(&path, b"not-an-image").unwrap();
    let err = engine.atlas_of("gently-mascot").unwrap_err();
    assert_eq!(err.code.as_str(), "pet.io_error");
    assert!(err.message.contains("校验"), "错误要说清是校验失败：{}", err.message);

    /* 文件整个丢了：当成「没有图集」，让渲染层退回程序化渲染而不是崩 */
    std::fs::remove_file(&path).unwrap();
    assert!(engine.atlas_of("gently-mascot").unwrap().is_none());

    std::fs::remove_dir_all(&dir).ok();
}





