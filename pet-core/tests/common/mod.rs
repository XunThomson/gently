//! 测试用临时目录（pet-core **自带**一份，不从 music core 借）。
//!
//! 独立性是硬约束：pet-core 的测试也不该依赖 `gently-core` 的测试工具，
//! 否则拆库时连测试都要重写。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 建一个干净的、进程内唯一的临时目录（先清空再创建）。
pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pet-core-{tag}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    dir
}
