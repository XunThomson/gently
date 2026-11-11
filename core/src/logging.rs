//! 日志初始化（tracing）：**控制台 + 按天滚动落盘**。
//!
//! 为什么要落盘：产品没有遥测，用户遇到问题只能靠本地日志（契约 §9 的 `logs/` 目录、
//! 设置页的「打开日志目录」）。只打控制台的话，用户关掉应用就什么都没了。
//!
//! 落盘策略（与契约一致）：
//! - 文件名 `gently.log.<日期>`（`tracing-appender` 的按天滚动）；
//! - **保留 7 天**：启动时清理更早的文件（尽力而为，失败只记一条 warn）；
//! - 不会因为写日志失败而影响启动：拿不到目录就只打控制台。

use std::error::Error;
use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// 日志保留天数（契约 §9）。
pub const KEEP_DAYS: u64 = 7;

/// 初始化全局日志；返回的 guard **必须活到进程结束**，否则后台写线程会被提前丢弃。
///
/// 级别优先级：`RUST_LOG` 环境变量 > `level` 参数 > `info`。
/// 重复调用（测试里常见）返回 Ok，不 panic。
pub fn init(level: &str, log_dir: Option<&Path>) -> Result<Option<WorkerGuard>, Box<dyn Error>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    let console = tracing_subscriber::fmt::layer().with_target(false);

    let (file_layer, guard) = match log_dir {
        Some(dir) => match std::fs::create_dir_all(dir) {
            Ok(()) => {
                prune_old_logs(dir);
                /* 用 Builder 而不是 `rolling::daily`：后者在无法创建当天文件时**直接 panic**
                   （tracing-appender 0.2.5 的 `daily()` 内部 `expect`）。真机上遇到过
                   「拒绝访问」——旧进程还握着当天的日志文件，于是 `tauri dev` 一启动就崩。
                   这里改成可失败：先用正常文件名，失败再用带 pid 的备用名，最后退回控制台。 */
                match build_appender(dir) {
                    Some(appender) => {
                        let (writer, guard) = tracing_appender::non_blocking(appender);
                        (Some(
                            tracing_subscriber::fmt::layer()
                                .with_target(false)
                                .with_ansi(false)
                                .with_writer(writer),
                        ), Some(guard))
                    }
                    None => (None, None),
                }
            }
            Err(err) => {
                // 目录建不出来（权限/磁盘）：只打控制台，不因此拦住启动
                eprintln!("日志目录不可用，仅输出到控制台：{err}");
                (None, None)
            }
        },
        None => (None, None),
    };

    let result = tracing_subscriber::registry()
        .with(filter)
        .with(console)
        .with(file_layer)
        .try_init();

    if let Err(err) = result {
        // 已经初始化过：不是错误，只是说明有另一个入口先初始化了
        tracing::debug!(%err, "tracing 已初始化，跳过");
    }
    Ok(guard)
}

/// 先试正常文件名；被占用时退回带 pid 的备用文件；都失败就返回 None（只控制台）。
fn build_appender(dir: &Path) -> Option<RollingFileAppender> {
    let build = |prefix: &str| {
        RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix(prefix)
            .build(dir)
    };
    match build("gently.log") {
        Ok(appender) => return Some(appender),
        Err(err) => {
            eprintln!("日志文件不可用（{err}），尝试进程内备用文件");
        }
    }
    let fallback = format!("gently.fallback-{}", std::process::id());
    match build(&fallback) {
        Ok(appender) => Some(appender),
        Err(err) => {
            eprintln!("备用日志文件也不可用（{err}），仅输出到控制台");
            None
        }
    }
}

/// 清掉超过保留期的日志文件（按文件名里的日期判断，不依赖文件时间戳）。
fn prune_old_logs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or_default();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("gently.log.") {
            continue;
        }
        let Some(day) = day_number(&name) else { continue };
        if today.saturating_sub(day) <= KEEP_DAYS {
            continue;
        }
        if let Err(err) = std::fs::remove_file(entry.path()) {
            tracing::warn!(file = %entry.path().display(), %err, "清理过期日志失败");
        }
    }
}

/// 从 `gently.log.2026-10-11` 解析出「Unix 天数」；格式不符返回 None。
///
/// 自己算而不是引一个日期库：只需要比较日期大小，闰年规则固定（能被 4 整除且不能被 100 整除，
/// 或能被 400 整除）。
fn day_number(name: &str) -> Option<u64> {
    let stamp = name.strip_prefix("gently.log.")?;
    let mut parts = stamp.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let leap = |y: i64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = |y: i64, m: u32| match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if leap(y) {
                29
            } else {
                28
            }
        }
    };
    if day > month_days(year, month) {
        return None;
    }

    // 以 1970-01-01 为 0 的累计天数
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if leap(y) { 366 } else { 365 };
    }
    for m in 1..month {
        days += month_days(year, m) as i64;
    }
    days += day as i64 - 1;
    u64::try_from(days).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rolling_file_names() {
        assert_eq!(day_number("gently.log.1970-01-01"), Some(0));
        assert_eq!(day_number("gently.log.1970-01-02"), Some(1));
        // 1970 不是闰年；2000 是（能被 400 整除）
        assert_eq!(day_number("gently.log.1971-01-01"), Some(365));
        assert_eq!(day_number("gently.log.2000-03-01"), Some(11017));
    }

    #[test]
    fn rejects_anything_that_is_not_a_date() {
        for name in ["gently.log", "gently.log.today", "gently.log.2026-13-01", "gently.log.2026-02-30", "other.log.2026-01-01"] {
            assert_eq!(day_number(name), None, "{name} 不该被当成日志日期");
        }
    }
}
