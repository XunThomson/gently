//! 契约守卫测试：锁定跨语言 ABI（错误码字符串、信封形状、命令清单）。

use gently_core::contract::{command_count, is_known_command, COMMAND_NAMES};
use gently_core::{CoreError, CoreResult, ErrorCode};
use serde_json::json;

/// 错误码字符串是 ABI：改动会静默破坏前端分支，因此逐个锁死。
/// 与 `docs/contracts/local-core-api.md` §1、`src/api/index.ts` 的 CORE_ERROR_CODES 三处必须一致。
#[test]
fn error_codes_are_stable_strings() {
    let expected: &[(ErrorCode, &str)] = &[
        (ErrorCode::InvalidArgument, "common.invalid_argument"),
        (ErrorCode::NotFound, "common.not_found"),
        (ErrorCode::Conflict, "common.conflict"),
        (ErrorCode::Cancelled, "common.cancelled"),
        (ErrorCode::UnsupportedPlatform, "common.unsupported_platform"),
        (ErrorCode::NotImplemented, "common.not_implemented"),
        (ErrorCode::Internal, "common.internal"),
        (ErrorCode::PluginInvalidSource, "plugin.invalid_source"),
        (ErrorCode::PluginInvalidManifest, "plugin.invalid_manifest"),
        (ErrorCode::PluginDuplicateId, "plugin.duplicate_id"),
        (ErrorCode::PluginImportFailed, "plugin.import_failed"),
        (ErrorCode::PluginPermissionDenied, "plugin.permission_denied"),
        (ErrorCode::PluginCredentialMissing, "plugin.credential_missing"),
        (ErrorCode::PluginRuntimeError, "plugin.runtime_error"),
        (ErrorCode::SubscriptionFetchFailed, "subscription.fetch_failed"),
        (ErrorCode::SubscriptionInvalidIndex, "subscription.invalid_index"),
        (ErrorCode::SourceUpstreamFailed, "source.upstream_failed"),
        (ErrorCode::SourceAuthExpired, "source.auth_expired"),
        (ErrorCode::PlaybackNoSource, "playback.no_source"),
        (ErrorCode::MediaProxyFailed, "media.proxy_failed"),
        (ErrorCode::MediaBlockedAddress, "media.blocked_address"),
        (ErrorCode::LibraryIoError, "library.io_error"),
        (ErrorCode::LibraryScanFailed, "library.scan_failed"),
        (ErrorCode::DownloadDiskFull, "download.disk_full"),
        (ErrorCode::SkinInvalidDocument, "skin.invalid_document"),
        (ErrorCode::SkinTokenRejected, "skin.token_rejected"),
    ];

    for (code, text) in expected {
        assert_eq!(code.as_str(), *text, "错误码字符串被改动");
        assert_eq!(
            serde_json::to_value(code).unwrap(),
            json!(text),
            "序列化结果与 as_str 不一致"
        );
    }
}

/// 信封形状：前端按 `ok` 布尔字段分支，字段名必须是 camelCase 的 `traceId`。
#[test]
fn success_envelope_shape() {
    let value = serde_json::to_value(CoreResult::ok(json!({"version": "0.1.0"}))).unwrap();
    let obj = value.as_object().expect("信封应为对象");
    assert_eq!(obj.get("ok"), Some(&json!(true)));
    assert!(obj.contains_key("data"));
    assert!(obj.contains_key("traceId"), "traceId 必须存在");
    assert!(!obj.contains_key("error"));
}

#[test]
fn failure_envelope_shape() {
    let value =
        serde_json::to_value(CoreResult::<()>::from_error(CoreError::not_implemented("system.status")))
            .unwrap();
    let obj = value.as_object().expect("信封应为对象");
    assert_eq!(obj.get("ok"), Some(&json!(false)));
    assert!(!obj.contains_key("data"));
    assert_eq!(obj["error"]["code"], json!("common.not_implemented"));
    assert!(obj["error"]["message"].is_string());
    assert_eq!(obj["error"]["details"]["command"], json!("system.status"));
    assert!(obj.contains_key("traceId"));
}

/// 未实现错误必须带上命令名，便于前端与日志定位到具体契约条目。
#[test]
fn not_implemented_carries_command_name() {
    let err = CoreError::not_implemented("plugin.import");
    assert_eq!(err.code, ErrorCode::NotImplemented);
    assert!(err.message.contains("plugin.import"));
}

/// 命令清单不变量：数量、唯一性、命名前缀合法。
#[test]
fn command_manifest_is_well_formed() {
    // R87：新增 `system.dataDir` / `system.dataDir.move`（数据目录可查、可迁移）
    // R135：新增 `playback.diagnose`（上游回的是不是音频 → 界面才能分开说明失败原因）
    assert_eq!(command_count(), 76, "契约命令数变化时必须同步文档与前端类型");

    let mut seen = std::collections::HashSet::new();
    for name in COMMAND_NAMES {
        assert!(seen.insert(*name), "命令名重复：{name}");
        let domain = name.split('.').next().unwrap_or_default();
        assert!(
            [
                "system", "plugin", "auth", "catalog", "library", "recommend", "playback",
                "download", "skin"
            ]
            .contains(&domain),
            "未知域前缀：{name}"
        );
        assert!(
            name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'),
            "命令名只允许 ASCII 字母、数字与点：{name}"
        );
        // 段名首字母小写（camelCase 允许大写，如 setEnabled / searchCancel）
        for segment in name.split('.') {
            let first = segment.chars().next().unwrap_or(' ');
            assert!(first.is_ascii_lowercase(), "段名应以小写字母开头：{name}");
            assert!(!segment.contains('_'), "命令名不使用下划线：{name}");
        }
    }

    assert!(is_known_command("catalog.search"));
    assert!(!is_known_command("catalog.nope"));
}
