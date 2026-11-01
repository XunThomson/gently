//! 宠物域契约的**机械一致性**测试：Rust 清单 ↔ 契约文档表格。
//!
//! 与音乐核心的 `core/tests/contract.rs` 同源思路：命令名是跨语言 ABI，
//! 文档与代码必须同步。区别是这里**同时**锁两件事：
//! 1. 名字的形态（`pet.` 前缀、唯一、有序）——防止手写清单时打错；
//! 2. 文档 §2 表格里的名字与 `PET_COMMAND_NAMES` **完全一致**（双向）。

use std::collections::BTreeSet;
use std::path::Path;

use pet_core::contract::{command_count, is_known_command, PET_COMMAND_NAMES};

/// 文档里 §2「命令清单」表格的命令名（行首第一列的反引号包裹的 `pet.xxx`）
fn documented_commands() -> BTreeSet<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("docs")
        .join("contracts")
        .join("pet-core-api.md");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读不到宠物契约文档 {}：{err}", path.display()));
    let start = text.find("## 2. 命令清单").expect("宠物契约缺少 §2 命令清单");
    let rest = &text[start + "## 2. 命令清单".len()..];
    let end = rest.find("\n## ").unwrap_or(rest.len());
    let section = &rest[..end];

    let mut names = BTreeSet::new();
    for line in section.lines() {
        let line = line.trim_start();
        // 表格行：| `pet.xxx` | …
        if !line.starts_with('|') {
            continue;
        }
        let Some(rest) = line.split_once('`') else { continue };
        let Some((name, _)) = rest.1.split_once('`') else { continue };
        // 表格里写作 `pet.tick{petId, dtMs}`：花括号是参数提示，不属于命令名
        let name = name.split('{').next().unwrap_or(name).trim();
        if name.starts_with("pet.") {
            names.insert(name.to_string());
        }
    }
    names
}

#[test]
fn command_names_are_well_formed() {
    let mut seen = BTreeSet::new();
    for name in PET_COMMAND_NAMES {
        assert!(
            name.starts_with("pet."),
            "宠物命令必须以 `pet.` 开头：{name}"
        );
        assert!(seen.insert(*name), "宠物命令重复：{name}");
        assert!(
            name.split('.').count() >= 2 && !name.ends_with('.'),
            "宠物命令至少要有一段动作名：{name}"
        );
    }
    // 声明式排序：清单按字典序写，diff 更好看，也能提前发现「加在中间忘了排序」
    let sorted: Vec<&&str> = {
        let mut list: Vec<&&str> = PET_COMMAND_NAMES.iter().collect();
        list.sort();
        list
    };
    assert_eq!(
        PET_COMMAND_NAMES.iter().collect::<Vec<_>>(),
        sorted,
        "宠物命令清单要按字典序排列"
    );
    assert_eq!(command_count(), PET_COMMAND_NAMES.len());
    for name in PET_COMMAND_NAMES {
        assert!(is_known_command(name), "is_known_command 要认得自己清单里的名字：{name}");
    }
}

#[test]
fn contract_doc_and_rust_manifest_agree() {
    let documented = documented_commands();
    let implemented: BTreeSet<String> = PET_COMMAND_NAMES.iter().map(|name| name.to_string()).collect();

    let missing_in_rust: Vec<_> = documented.difference(&implemented).cloned().collect();
    let missing_in_doc: Vec<_> = implemented.difference(&documented).cloned().collect();
    assert!(
        missing_in_rust.is_empty(),
        "契约文档里有、Rust 清单里没有：{missing_in_rust:?}"
    );
    assert!(
        missing_in_doc.is_empty(),
        "Rust 清单里有、契约文档里没有：{missing_in_doc:?}"
    );
}
