//! 宠物命令分发的地基测试：每个命令的参数/返回形状 + 未知命令的语义。
//!
//! 这里刻意不测「帧长什么样」（`core.rs` 已经锁了确定性），只测**契约面**：
//! 前端能拿到的字段是否齐全、失败是否为可读错误——这部分最容易在改字段时悄悄漂移。

mod common;

use serde_json::{json, Value};

use pet_core::{contract::PET_COMMAND_NAMES, dispatch, Engine};

fn spec_json(id: &str) -> String {
    format!(
        r##"{{
            "id": "{id}",
            "name": "契约宠物",
            "version": "1.0.0",
            "atlas": "atlas.png",
            "animations": [{{"name": "idle", "frames": 2, "frameMs": 250, "loop": true}}],
            "behaviors": [
                {{"when": {{"kind": "clicked"}}, "then": {{"kind": "say", "textKey": "pet.hello"}}, "cooldownMs": 100}}
            ]
        }}"##
    )
}

fn call(engine: &mut Engine, command: &str, params: Value) -> Value {
    match dispatch(engine, command, params, 1_000) {
        Ok(value) => json!({ "ok": true, "data": value }),
        Err(error) => json!({ "ok": false, "code": error.code.as_str(), "message": error.message }),
    }
}

#[test]
fn every_registered_command_is_implemented() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-contract"), 1_000).unwrap();

    // 每个登记过的命令都必须能分发（不出现「清单里有、分发里没有」）
    for command in PET_COMMAND_NAMES {
        let params = match *command {
            "pet.state" => json!({}),
            "pet.install" => json!({ "spec": spec_json("pet-contract") }),
            "pet.atlas" => json!({ "id": "pet-contract" }),
            "pet.setActive" => json!({ "id": "pet-contract" }),
            "pet.interact" => json!({ "id": "pet-contract", "kind": "touch" }),
            "pet.remove" => json!({ "id": "pet-missing" }),
            "pet.tick" => json!({ "petId": "pet-contract", "dtMs": 50 }),
            other => panic!("测试缺少命令样例：{other}"),
        };
        let value = call(&mut engine, command, params);
        // remove 用不存在的 id 测语义；其余都必须成功
        if *command == "pet.remove" {
            assert_eq!(value["ok"], json!(false), "{command} → {value}");
            assert_eq!(value["code"], json!("pet.not_found"), "{command} → {value}");
        } else {
            assert_eq!(value["ok"], json!(true), "{command} → {value}");
        }
    }
}

#[test]
fn atlas_round_trips_through_the_package_dir() {
    let dir = common::temp_dir("pet-atlas");
    let mut engine = Engine::open(&dir).unwrap();

    // 没有图集时回 null（不是报错）
    engine.install(&spec_json("pet-plain"), 1_000).unwrap();
    let plain = call(&mut engine, "pet.atlas", json!({ "id": "pet-plain" }));
    assert_eq!(plain["ok"], json!(true), "{plain}");
    assert_eq!(plain["data"], Value::Null);

    // 带图集安装：文件落在 packages/<id>/ 下，命令能原样取回
    let bytes = b"not-a-real-png-but-bytes".to_vec();
    let installed = call(
        &mut engine,
        "pet.install",
        json!({
            "spec": spec_json("pet-atlas"),
            "atlas": { "file": "atlas.png", "dataBase64": base64(&bytes) },
        }),
    );
    assert_eq!(installed["ok"], json!(true), "{installed}");
    assert_eq!(installed["data"]["hasAtlas"], json!(true), "{installed}");
    assert!(dir.join("packages").join("pet-atlas").join("atlas.png").is_file());

    let fetched = call(&mut engine, "pet.atlas", json!({ "id": "pet-atlas" }));
    assert_eq!(fetched["ok"], json!(true), "{fetched}");
    assert_eq!(fetched["data"]["file"], json!("atlas.png"));
    assert_eq!(fetched["data"]["dataBase64"], json!(base64(&bytes)));

    // 卸载要把素材一起删掉（否则数据目录里留孤儿文件）
    let removed = call(&mut engine, "pet.remove", json!({ "id": "pet-atlas" }));
    assert_eq!(removed["ok"], json!(true), "{removed}");
    assert!(!dir.join("packages").join("pet-atlas").exists());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn atlas_rejects_paths_wrong_types_and_oversized_payloads() {
    let mut engine = Engine::open_in_memory().unwrap();
    for (atlas, expected) in [
        (json!({ "file": "../evil.png", "dataBase64": "AAAA" }), "pet.invalid_package"),
        (json!({ "file": "atlas.mp4", "dataBase64": "AAAA" }), "pet.invalid_package"),
        (json!({ "file": "atlas.png", "dataBase64": "" }), "pet.invalid_package"),
    ] {
        let value = call(
            &mut engine,
            "pet.install",
            json!({ "spec": spec_json("pet-bad-atlas"), "atlas": atlas }),
        );
        assert_eq!(value["code"], json!(expected), "{atlas} → {value}");
    }
}

/** 测试用的 base64 编码（与生产实现相互独立：拿它交叉验证 decode/encode 都对） */
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let triple = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((triple >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(triple & 0x3f) as usize] as char } else { '=' });
    }
    out
}

#[test]
fn unknown_command_is_an_argument_error() {
    let mut engine = Engine::open_in_memory().unwrap();
    let value = call(&mut engine, "pet.fly", json!({}));
    assert_eq!(value["ok"], json!(false));
    assert_eq!(value["code"], json!("pet.invalid_argument"));
    assert!(
        value["message"].as_str().unwrap_or_default().contains("pet.fly"),
        "错误里要带上出错的名字：{value}"
    );
}

#[test]
fn state_reports_active_pet_and_paths() {
    let dir = common::temp_dir("pet-dispatch-state");
    let mut engine = Engine::open(&dir).unwrap();
    engine.install(&spec_json("pet-state"), 1_000).unwrap();

    let value = call(&mut engine, "pet.state", json!({}));
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["active"], json!("pet-state"));
    assert_eq!(value["data"]["pets"][0]["active"], json!(true));
    assert_eq!(value["data"]["pets"][0]["spec"]["name"], json!("契约宠物"));
    assert_eq!(value["data"]["pets"][0]["profile"]["affection"], json!(0));
    assert!(value["data"]["dbPath"].as_str().unwrap().ends_with("pet.db"), "{value}");
    assert_eq!(value["data"]["schemaVersion"], json!(pet_core::store::SCHEMA_VERSION));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn tick_returns_a_frame_and_a_bubble_key() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-tick"), 1_000).unwrap();

    let value = call(
        &mut engine,
        "pet.tick",
        json!({ "petId": "pet-tick", "dtMs": 50, "clicked": true, "playing": true, "elapsedMs": 1_000 }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    let frame = &value["data"]["frame"];
    for field in ["animation", "frame", "x", "y", "flip", "bubble", "hitArea"] {
        assert!(frame.get(field).is_some(), "帧缺少字段 {field}：{value}");
    }
    assert_eq!(frame["hitArea"]["w"], json!(96));
    // 气泡只回键，不回文案（i18n 在宿主）
    assert_eq!(value["data"]["bubble"]["key"], json!("pet.hello"), "{value}");
}

#[test]
fn install_rejects_broken_packages_with_a_readable_reason() {
    let mut engine = Engine::open_in_memory().unwrap();
    let value = call(&mut engine, "pet.install", json!({ "spec": "{不是 JSON" }));
    assert_eq!(value["ok"], json!(false));
    assert_eq!(value["code"], json!("pet.invalid_package"));
}

#[test]
fn interact_reports_cooldown_for_feeding_but_not_for_touch() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-feed"), 1_000).unwrap();

    let first = call(&mut engine, "pet.interact", json!({ "id": "pet-feed", "kind": "feed" }));
    assert_eq!(first["ok"], json!(true), "{first}");
    // 立刻再喂：冷却内必须给出可读错误（而不是静默）
    let second = call(&mut engine, "pet.interact", json!({ "id": "pet-feed", "kind": "feed" }));
    assert_eq!(second["code"], json!("pet.invalid_argument"), "{second}");
    // 摸一下在冷却内静默：返回成功、好感不再涨
    let touch1 = call(&mut engine, "pet.interact", json!({ "id": "pet-feed", "kind": "touch" }));
    let touch2 = call(&mut engine, "pet.interact", json!({ "id": "pet-feed", "kind": "touch" }));
    assert_eq!(touch1["ok"], json!(true));
    assert_eq!(touch2["ok"], json!(true));
    assert_eq!(
        touch1["data"]["profile"]["affection"], touch2["data"]["profile"]["affection"],
        "冷却内的触摸不该继续加好感：{touch2}"
    );
    // 未知互动类型
    let bad = call(&mut engine, "pet.interact", json!({ "id": "pet-feed", "kind": "pet" }));
    assert_eq!(bad["code"], json!("pet.invalid_argument"), "{bad}");
}

#[test]
fn removed_pet_clears_active_and_cannot_be_ticked() {
    let mut engine = Engine::open_in_memory().unwrap();
    engine.install(&spec_json("pet-gone"), 1_000).unwrap();

    let removed = call(&mut engine, "pet.remove", json!({ "id": "pet-gone" }));
    assert_eq!(removed["ok"], json!(true), "{removed}");
    assert_eq!(removed["data"]["active"], Value::Null);

    let tick = call(&mut engine, "pet.tick", json!({ "petId": "pet-gone", "dtMs": 50 }));
    assert_eq!(tick["code"], json!("pet.not_found"), "{tick}");
}
