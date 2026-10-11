//! 集成测试的公共工具（`mod common;` 引入；这个目录本身不会被当成测试编译）。
//!
//! 目前只有一件事：**给每个测试一个真正唯一的临时目录**。
//!
//! 为什么不能只用 `SystemTime::now()`：Windows 上系统时钟的粒度约 15ms，而 cargo 默认
//! **并行跑测试**——同一进程里两个测试很可能拿到同一个纳秒值，于是共享同一个数据目录
//! 与 SQLite 文件，互相看见对方写进去的数据。实测过一次偶发失败：
//! `index_with_path_traversal_is_rejected_at_refresh` 约 1/6 的概率读到另一个测试
//! 写下的订阅计数，断言 `count == 0` 变成 `count == 1`。
//!
//! 这里用「进程 id + 进程内原子自增」做后缀：既不依赖时钟精度，也不会跨进程冲突。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 建一个**干净的**唯一临时子目录（先清空再创建）。
///
/// 「先清空」这一步是必需的：只靠名字唯一并不够——进程 id 会被系统复用，
/// 而上一次失败留下的目录里还有 `gently.db`，于是新测试会读到上一轮的配置/订阅数据。
/// 实测踩到过两次偶发失败（订阅计数、插件配置 revision），根因都是这个。
pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "gently-{tag}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    dir
}
