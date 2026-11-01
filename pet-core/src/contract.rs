//! 宠物域的命令清单（**独立命名空间**）。
//!
//! 为什么现在就有这个空清单：契约守卫要从第一天开始守，而不是等命令加进来之后
//! （R88 评估里发现的风险：`check:contract` 只认音乐核心的域名白名单，`pet.*`
//! 一旦加命令就会变成「第二份没人守的契约」）。
//!
//! 规则与音乐核心一致：
//! - 名字是 `pet.<动作>[.<子动作>]`，跨语言 ABI，改名等于破坏兼容；
//! - 这里列的每一条都必须同时出现在 `docs/contracts/pet-core-api.md` 的 §2 表格里；
//! - 前端服务层只允许调用这里登记过的名字（由 `scripts/check-commands.mjs` 双向比对）。
//!
//! M1（宿主桥）之前这里是空的：`pet-core` 目前只有 Rust API，没有任何 IPC 命令。

/// 宠物域的契约命令（M1 宿主桥已接入；新增/改名必须同步契约文档 §2 与 `tests/contract.rs`）。
///
/// 顺序按字典序：diff 与守卫比对都更好读。
pub const PET_COMMAND_NAMES: &[&str] = &[
    "pet.atlas",
    "pet.install",
    "pet.interact",
    "pet.remove",
    "pet.setActive",
    "pet.state",
    "pet.tick",
];

/// 是否为宠物域已登记的命令
pub fn is_known_command(name: &str) -> bool {
    PET_COMMAND_NAMES.contains(&name)
}

/// 已登记的命令数（诊断与守卫用）
pub const fn command_count() -> usize {
    PET_COMMAND_NAMES.len()
}
