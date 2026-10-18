//! 兼容模式的接入层（ADR-0006 待完成第 3 项）：把兼容开关接进预览与安装。
//!
//! # 两条入口
//!
//! 1. **头部 `@compat`**：作者自己声明。适合愿意写头部的插件（头部四个必填字段仍然要有）。
//! 2. **导入参数 `compat: true`**：用户在界面上显式开启。MusicFree / LX 生态的插件
//!    **没有头部注释**，元数据在 `module.exports` 里，只能走这条入口。
//!
//! # 头部不全时怎么合成清单
//!
//! 用 `probe` 在沙箱里**只读执行一次**源码（探测期域名白名单为空，插件无法出网），
//! 从导出对象读元数据与真实能力：
//!
//! - `id`：`compat-<8 位 sha256(platform)>`。`platform` 是 MusicFree 的插件身份，同一插件
//!   升级后 id 不变（否则升级会变成「又装了一个新插件」）；不用 platform 原文是因为
//!   我们的 id 形状是 `[a-z0-9-]{2,32}`，而 platform 常常是中文。没有 platform 时退化为
//!   内容摘要并**明确警告**（那种情况下升级会换 id）。
//! - `name` / `author` / `description` / `homepage`：取导出对象里的同名字段（`homepage` 兼容
//!   MusicFree 的 `srcUrl`）；缺 author 用占位文案，因为我们的清单要求非空。
//! - `version`：必须是语义化版本，否则按 `0.0.0` 记录并警告。
//! - 权限：兼容模式必然出网 → `network`；`hosts` 留空（兼容模式的意义就是没有白名单）。
//! - 能力：以**运行时探测**为准——静态扫描认不出 `module.exports` 里挂的箭头函数。
//!
//! 警告里必须写清「可访问任意公网域名，权限弱于自有 ABI」；界面另有专门的提示位
//! （`PluginImportPreview.compat`），文案走 i18n。

use std::sync::Arc;

use crate::contract::{CoreError, ErrorCode, Fallible};

use super::host::{probe, HostLimits};
use super::manifest::{
    header_is_complete, is_valid_version, parse_source, required_modules, PluginManifest,
    PluginPermission, ParsedPlugin, TrackQuality, BUILTIN_REQUIRE_MODULES, REQUIRED_CAPABILITIES,
};
use super::transport::{HttpRequest, HttpResponse, HttpTransport};

/// 头部不全又没开兼容模式时，补一句「怎么办」——比只报「缺少必填字段」有用得多。
const COMPAT_HINT: &str =
    "（若这是 MusicFree / LX 生态的 CommonJS 插件，请在导入时显式开启兼容模式）";

/// 解析单文件插件源码；`compat` 表示用户显式开启了兼容模式。
///
/// - 头部完整：走静态路径；`compat` 为真时把兼容模式写进清单（作者可能没写 `@compat`）；
/// - 头部不全：只有 `compat` 为真才继续，用 `probe` 合成清单；否则把缺字段的错误抛回去。
///
/// 探测**永远不给真实出网通道**（`NoEgress`）：探测阶段白名单本来就为空，
/// 这里是第二道保险——预览与安装共用同一个入口，也就没有「哪条路径忘了加锁」的问题。
pub fn parse_source_compat(source: &str, compat: bool) -> Fallible<ParsedPlugin> {
    if header_is_complete(source) {
        let mut parsed = parse_source(source)?;
        if compat {
            apply_explicit_compat(&mut parsed);
        }
        return Ok(parsed);
    }

    if !compat {
        return parse_source(source).map_err(|err| CoreError {
            message: format!("{}{COMPAT_HINT}", err.message),
            ..err
        });
    }

    synthesize(source, Arc::new(NoEgress))
}

/// 用户显式开启兼容模式：即使作者没写 `@compat` 也生效（并推导出 network 权限）。
pub fn apply_explicit_compat(parsed: &mut ParsedPlugin) {
    if parsed.manifest.compat {
        return;
    }
    parsed.manifest.compat = true;
    if !parsed.manifest.permissions.contains(&PluginPermission::Network) {
        parsed.manifest.permissions.push(PluginPermission::Network);
    }
    parsed.warnings.push(
        "已按你的选择开启兼容模式（源码里没有 @compat 标记）：可访问任意公网域名，权限弱于自有 ABI"
            .into(),
    );
}

/// 只读执行一次源码，从 `module.exports` 合成清单。
fn synthesize(source: &str, transport: Arc<dyn HttpTransport>) -> Fallible<ParsedPlugin> {
    let probed = probe(source, HostLimits::default(), transport).map_err(describe_probe_failure)?;
    let metadata = probed.metadata;
    let field = |key: &str| -> Option<String> {
        metadata.get(key).map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    };

    let platform = field("platform");
    let mut warnings = vec![
        "兼容模式：可访问任意公网 HTTPS 域名（本机/内网仍被拒绝），权限弱于自有 ABI".to_string(),
    ];

    // id：platform 稳定；没有 platform 只能用内容摘要，并说明代价
    let identity = match &platform {
        Some(platform) => platform.clone(),
        None => {
            warnings.push(
                "导出对象里没有 platform：插件 id 由内容摘要派生，更新插件会被视为另一个插件".into(),
            );
            super::install::sha256_hex(source.as_bytes())
        }
    };
    let digest = super::install::sha256_hex(identity.as_bytes());
    let id = format!("compat-{}", &digest[..8]);

    let name = platform.or_else(|| field("name")).unwrap_or_else(|| "未命名兼容插件".to_string());
    // 清单要求 author 非空，而 MusicFree 插件常常不写作者
    let author = field("author").unwrap_or_else(|| "未声明".to_string());
    let version = match field("version") {
        Some(version) if is_valid_version(&version) => version,
        Some(version) => {
            warnings.push(format!("插件声明的版本 {version} 不是语义化版本，已按 0.0.0 记录"));
            "0.0.0".to_string()
        }
        None => "0.0.0".to_string(),
    };

    // 导出对象里没有的音质信息：按最低档处理（与静态路径同一口径）
    warnings.push("未声明 @qualities，按 standard 处理".into());

    let capabilities = probed.capabilities;
    let found: Vec<&str> = capabilities.iter().map(|capability| capability.name()).collect();
    for required in REQUIRED_CAPABILITIES {
        if !found.contains(&required) {
            warnings.push(format!("未找到必选函数 {required}（运行时探测结果，缺了对应入口会被隐藏）"));
        }
    }

    // `module.exports.userVariables` = 插件要向用户索取哪些变量（MusicFree 的约定）。
    // 在我们这里它就是「凭据」：声明了就进清单，用户才能在插件页填写，
    // 插件再通过 `env.getUserVariables()` 读到——两边用的是**同一组键名**。
    let credentials = probed.variables;
    let mut permissions = vec![PluginPermission::Network];
    if !credentials.is_empty() {
        permissions.push(PluginPermission::Credentials);
        warnings.push(format!(
            "插件声明了 {} 个用户变量（{}）：需要在插件页填写后才能真正使用",
            credentials.len(),
            credentials
                .iter()
                .map(|field| field.key.clone())
                .collect::<Vec<_>>()
                .join(" / ")
        ));
    }

    // require 清单之外的依赖：安装后会在 require 处报错，预览阶段先说清
    let external: Vec<String> = required_modules(source)
        .into_iter()
        .filter(|module| !BUILTIN_REQUIRE_MODULES.contains(&module.as_str()))
        .collect();
    if !external.is_empty() {
        warnings.push(format!(
            "require 了固定清单之外的模块：{}——兼容模式只内置 {}，安装后会在 require 处报错",
            external.join(", "),
            BUILTIN_REQUIRE_MODULES.join(" / ")
        ));
    }

    Ok(ParsedPlugin {
        manifest: PluginManifest {
            id,
            name,
            version,
            author,
            description: field("description").unwrap_or_default(),
            // MusicFree 的 `srcUrl`（远程更新地址）当作主页记录：我们**不自动更新**，只作展示
            homepage: field("homepage").or_else(|| field("srcUrl")),
            entry: None,
            qualities: vec![TrackQuality::Standard],
            permissions,
            hosts: Vec::new(),
            credentials,
            // 兼容插件的登录态走 `env.getUserVariables()` 里的 cookie / token：
            // 清单是从 `module.exports` 合成的，没有可信的授权端点声明，因此不认 @oauth
            oauth: None,
            min_core_version: None,
            tags: Vec::new(),
            capabilities,
            compat: true,
        },
        warnings,
    })
}

/// 探测失败的说明：QuickJS 的异常文本很含糊，这里补上最可能的原因。
fn describe_probe_failure(err: CoreError) -> CoreError {
    if err.message.contains("GENTLY_PERMISSION_DENIED") || err.message.contains("权限") {
        return CoreError {
            message: format!(
                "{}——兼容插件在预览/安装的探测期不能出网：顶层的网络请求会被拒绝，请让插件只在被调用时发请求",
                err.message
            ),
            ..err
        };
    }
    CoreError {
        message: format!("{}（兼容模式的清单来自只读执行插件源码，因此顶层代码必须能被安全执行）", err.message),
        ..err
    }
}

/// 安装期的空通道：`probe` 的白名单为空，任何请求都会先被权限闸门拒绝；
/// 万一有人改坏了那层，这里也不会真的发出去。
struct NoEgress;

impl HttpTransport for NoEgress {
    fn send(&self, _request: &HttpRequest) -> Fallible<HttpResponse> {
        Err(CoreError::new(ErrorCode::SourceUpstreamFailed, "安装/预览期不允许插件出网"))
    }
}
