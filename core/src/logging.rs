//! 日志初始化（tracing）。
//!
//! M0 只做控制台输出与级别控制；按天滚动、保留 7 天、一键打包在 M5 落地
//! （契约 §9 的日志目录已经在 [`crate::paths::AppPaths`] 里预留）。

use std::error::Error;

use tracing_subscriber::EnvFilter;

/// 初始化全局日志。
///
/// 级别优先级：`RUST_LOG` 环境变量 > `level` 参数 > `info`。
/// 重复调用（测试里常见）返回 Ok，不 panic。
pub fn init(level: &str) -> Result<(), Box<dyn Error>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    let result = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
    if let Err(err) = result {
        // 已经初始化过：不是错误，只是说明有另一个入口先初始化了
        tracing::debug!(%err, "tracing 已初始化，跳过");
    }
    Ok(())
}
