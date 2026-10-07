//! 统一信封。
//!
//! 契约要求命令**永不抛异常**：失败也走 `{ok:false, error, traceId}`，
//! 前端因此不需要 try/catch 分支（IPC 反序列化失败才会 reject）。

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::error::CoreError;

/// 成功/失败信封。手写 `Serialize` 是因为契约里的判别字段是
/// **布尔** `ok`（`{ok:true,...}` / `{ok:false,...}`），而 serde 的内部标签
/// 只能输出字符串标签，用属性无法精确表达。
#[derive(Debug, Clone)]
pub enum CoreResult<T> {
    Ok { data: T, trace_id: String },
    Err { error: CoreError, trace_id: String },
}

impl<T> CoreResult<T> {
    /// 成功；自动生成 traceId（贯穿本地日志与诊断页）。
    pub fn ok(data: T) -> Self {
        Self::Ok { data, trace_id: new_trace_id() }
    }

    /// 失败；自动生成 traceId。
    pub fn from_error(error: CoreError) -> Self {
        Self::Err { error, trace_id: new_trace_id() }
    }

    /// 用调用方指定的 traceId 覆盖（跨层追踪同一请求时用）。
    pub fn with_trace_id(mut self, trace_id: String) -> Self {
        match &mut self {
            Self::Ok { trace_id: t, .. } | Self::Err { trace_id: t, .. } => *t = trace_id,
        }
        self
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }

    pub fn trace_id(&self) -> &str {
        match self {
            Self::Ok { trace_id, .. } | Self::Err { trace_id, .. } => trace_id,
        }
    }
}

impl<T: Serialize> Serialize for CoreResult<T> {    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        match self {
            Self::Ok { data, trace_id } => {
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("data", data)?;
                map.serialize_entry("traceId", trace_id)?;
            }
            Self::Err { error, trace_id } => {
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
                map.serialize_entry("traceId", trace_id)?;
            }
        }
        map.end()
    }
}

/// 内部实现用 `Result<T, CoreError>`（可以直接 `?`），
/// 只在**命令边界**转成信封——自定义枚举无法实现 `FromResidual`，
/// 所以 `?` 不能作用在 `CoreResult` 上，这是刻意的分工。
impl<T> From<Result<T, CoreError>> for CoreResult<T> {
    fn from(outcome: Result<T, CoreError>) -> Self {
        match outcome {
            Ok(data) => Self::ok(data),
            Err(error) => Self::from_error(error),
        }
    }
}

/// 生成短 traceId：毫秒时间戳 + 进程内自增序号。
///
/// 不引 uuid 依赖——本机场景只在日志与诊断页里做关联，
/// 单进程内唯一即可，短 id 更便于人工比对。
pub fn new_trace_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();
    format!("t{millis:x}-{seq:04x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_id_is_unique_within_process() {
        let a = new_trace_id();
        let b = new_trace_id();
        assert_ne!(a, b);
        assert!(a.starts_with('t'));
    }

    #[test]
    fn with_trace_id_overrides() {
        let r = CoreResult::ok(1).with_trace_id("fixed".into());
        assert_eq!(r.trace_id(), "fixed");
    }
}
