//! 插件清单：单文件头部注释 / 目录包 `plugin.json` 两种形态的统一表示。
//!
//! 设计取舍：
//! - **单文件为主形态**（契约 §5.1）：元数据写在文件头注释里，作者成本 = 一个文件；
//! - 目录包只多一个 `entry` 字段，其余字段完全一致 → 两种形态共用同一个结构体与校验；
//! - 解析**不执行任何代码**：`capabilities` 是**静态预扫描**结果（找 `function <name>`），
//!   M1b 接入运行时后会用它做能力探测的初值——预扫描只用于预览提示，不作为安全判断依据。

use serde::{Deserialize, Serialize};

use crate::contract::{CoreError, ErrorCode, Fallible};

/// 头部元数据只扫描文件前 N 行（沿用 Legado 社区约定，避免整文件扫描）。
pub const HEADER_SCAN_LINES: usize = 60;

/// 单文件插件的大小上限：插件是脚本，超过这个体量基本可以确定有问题。
pub const MAX_SOURCE_BYTES: u64 = 1024 * 1024;

const CAPABILITY_NAMES: [&str; 9] = [
    "search",
    "getMediaSource",
    "getTrackInfo",
    "getAlbumInfo",
    "getPlaylistInfo",
    "getLyric",
    "getTopLists",
    "getTopList",
    "getRecommend",
];

/// 必选函数：缺失时预览给出警告（不作为硬错误——静态扫描可能误判）。
pub(crate) const REQUIRED_CAPABILITIES: [&str; 2] = ["search", "getMediaSource"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackQuality {
    Standard,
    High,
    Lossless,
    Hires,
}

impl TrackQuality {
    fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "standard" => Some(Self::Standard),
            "high" => Some(Self::High),
            "lossless" => Some(Self::Lossless),
            "hires" => Some(Self::Hires),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginPermission {
    #[serde(rename = "network")]
    Network,
    #[serde(rename = "filesystem:read")]
    FilesystemRead,
    #[serde(rename = "filesystem:write")]
    FilesystemWrite,
    #[serde(rename = "credentials")]
    Credentials,
}

impl PluginPermission {
    fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "network" => Some(Self::Network),
            "filesystem:read" => Some(Self::FilesystemRead),
            "filesystem:write" => Some(Self::FilesystemWrite),
            "credentials" => Some(Self::Credentials),
            _ => None,
        }
    }
}

/// 插件能力 = JS 顶层函数名（与契约 §5.2 的 ABI 一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginCapability {
    #[serde(rename = "search")]
    Search,
    #[serde(rename = "getMediaSource")]
    GetMediaSource,
    #[serde(rename = "getTrackInfo")]
    GetTrackInfo,
    #[serde(rename = "getAlbumInfo")]
    GetAlbumInfo,
    #[serde(rename = "getPlaylistInfo")]
    GetPlaylistInfo,
    #[serde(rename = "getLyric")]
    GetLyric,
    #[serde(rename = "getTopLists")]
    GetTopLists,
    #[serde(rename = "getTopList")]
    GetTopList,
    #[serde(rename = "getRecommend")]
    GetRecommend,
}

impl PluginCapability {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "search" => Some(Self::Search),
            "getMediaSource" => Some(Self::GetMediaSource),
            "getTrackInfo" => Some(Self::GetTrackInfo),
            "getAlbumInfo" => Some(Self::GetAlbumInfo),
            "getPlaylistInfo" => Some(Self::GetPlaylistInfo),
            "getLyric" => Some(Self::GetLyric),
            "getTopLists" => Some(Self::GetTopLists),
            "getTopList" => Some(Self::GetTopList),
            "getRecommend" => Some(Self::GetRecommend),
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::GetMediaSource => "getMediaSource",
            Self::GetTrackInfo => "getTrackInfo",
            Self::GetAlbumInfo => "getAlbumInfo",
            Self::GetPlaylistInfo => "getPlaylistInfo",
            Self::GetLyric => "getLyric",
            Self::GetTopLists => "getTopLists",
            Self::GetTopList => "getTopList",
            Self::GetRecommend => "getRecommend",
        }
    }
}

/// 插件向用户索要的凭据字段（值只进 OS keyring，永不落库明文）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub required: bool,
    /// 敏感值：界面掩码显示
    #[serde(default = "default_secret")]
    pub secret: bool,
}

fn default_secret() -> bool {
    true
}

/// 第三方授权声明（OAuth 2.0 授权码 + PKCE），端点由**插件作者**提供，核心侧不内置任何地址
/// （`docs/adr/0005-neutral-third-party.md`）。
///
/// 单文件插件的头部写法（参数之间用逗号分隔，值里不能有逗号）：
///
/// ```text
/// // @oauth authorize=https://id.example.com/authorize,token=https://id.example.com/api/token,client=demo-client,scopes=fav+read,port=0
/// ```
///
/// 目录包的 `plugin.json` 等价写法：
///
/// ```json
/// "oauth": {"authorizeUrl": "...", "tokenUrl": "...", "clientId": "...", "scopes": ["fav"], "pkce": true}
/// ```
///
/// 约束：
/// - 两个端点必须是 **HTTPS**（测试用的本机回环 `http://127.0.0.1` 例外），
///   且域名必须写进 `@hosts`——授权端点和普通出网走同一道白名单，不额外开口子；
/// - 声明了 `@oauth` 会**自动**补上 `network` + `credentials` 权限（令牌存在凭据库里）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConfig {
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// PKCE（S256）：默认开启；老式公共客户端可写 `nopkce` 关闭（安全性下降，预览里会提示）
    #[serde(default = "default_true")]
    pub pkce: bool,
    /// 本机回调监听端口；0 = 随机端口（推荐，避免端口冲突）
    #[serde(default)]
    pub redirect_port: u16,
}

fn default_true() -> bool {
    true
}

/// 插件清单：单文件头部注释与目录包 `plugin.json` 共用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// 目录包的主文件名；单文件形态为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default)]
    pub qualities: Vec<TrackQuality>,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    /// 网络白名单（仅 HTTPS）；空表示不允许任何网络访问
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub credentials: Vec<CredentialField>,
    /// 第三方授权声明（`@oauth`）：端点由插件提供，核心只跑通用流程
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_core_version: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 静态预扫描得到的能力；M1b 由运行时探测覆盖
    #[serde(default)]
    pub capabilities: Vec<PluginCapability>,
    /// **兼容模式**：该插件来自 MusicFree / LX 生态，不声明 `@hosts`。
    /// 开启后允许访问任意**公网** HTTPS 域名（本机/内网始终拒绝），并把实际访问的域名记进日志，
    /// 供后续「把用到的域名固化进白名单」的确认流程使用。默认关闭。
    #[serde(default)]
    pub compat: bool,
}

/// 解析结果：清单 + 非致命警告（预览界面展示给用户）。
#[derive(Debug, Clone)]
pub struct ParsedPlugin {
    pub manifest: PluginManifest,
    pub warnings: Vec<String>,
}

/// 解析单文件插件源码（头部注释 + 正文静态扫描）。
pub fn parse_source(source: &str) -> Fallible<ParsedPlugin> {
    let header = parse_header(source);
    build(header, Some(source))
}

/// 头部是否足以构成清单（四个必填字段齐全）。
///
/// 兼容模式的入口判定用它（ADR-0006）：头部不全 = 只能从 `module.exports` 合成清单，
/// 而那需要用户显式开启兼容模式。
pub fn header_is_complete(source: &str) -> bool {
    let header = parse_header(source);
    ["id", "name", "version", "author"]
        .iter()
        .all(|key| header.iter().any(|(k, value)| k == key && !value.is_empty()))
}

/// 解析目录包的 `plugin.json`。
///
/// `source` 传入入口文件内容时同样会做能力预扫描；不传则只解析声明。
pub fn parse_manifest_json(json: &str, entry_source: Option<&str>) -> Fallible<ParsedPlugin> {
    let raw: serde_json::Value = serde_json::from_str(json).map_err(|err| {
        CoreError::new(ErrorCode::PluginInvalidManifest, format!("plugin.json 不是合法 JSON：{err}"))
            .with_details(serde_json::json!({ "reason": err.to_string() }))
    })?;
    let header = header_from_json(&raw)?;
    build(header, entry_source)
}

// ---------------------------------------------------------------- 头部解析

/// 头部字段：key → 多个值（同名字段可重复出现，用逗号分隔也会展开）。
type Header = Vec<(String, String)>;

fn parse_header(source: &str) -> Header {
    let mut header: Header = Vec::new();

    for line in source.lines().take(HEADER_SCAN_LINES) {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("//") else { continue };
        let Some(at) = rest.trim_start().strip_prefix('@') else { continue };

        // 形如 `@hosts a.com,b.com`：key 到第一个空白为止
        let mut parts = at.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
        let value = parts.next().unwrap_or_default().trim();
        if key.is_empty() {
            continue;
        }

        for single in value.split(',') {
            let single = single.trim();
            if !single.is_empty() {
                header.push((key.clone(), single.to_string()));
            }
        }
        // 无值字段（例如只写 `// @credentials`）也要留下痕迹，便于报错
        if value.is_empty() {
            header.push((key, String::new()));
        }
    }

    header
}

/// 从 `plugin.json` 的 JSON 结构里取出与头部等价的信息。
fn header_from_json(raw: &serde_json::Value) -> Fallible<Header> {
    let object = raw.as_object().ok_or_else(|| {
        CoreError::new(ErrorCode::PluginInvalidManifest, "plugin.json 顶层必须是对象")
    })?;

    let mut header: Header = Vec::new();
    let mut push = |key: &str, value: &serde_json::Value| {
        if let Some(text) = value.as_str() {
            header.push((key.to_string(), text.to_string()));
        }
    };

    for key in ["id", "name", "version", "author", "description", "homepage", "entry", "minCoreVersion"] {
        if let Some(value) = object.get(key) {
            push(key, value);
        }
    }
    for key in ["qualities", "permissions", "hosts", "tags"] {
        if let Some(items) = object.get(key).and_then(|v| v.as_array()) {
            for item in items {
                push(key, item);
            }
        }
    }
    if let Some(credentials) = object.get("credentials").and_then(|v| v.as_array()) {
        for item in credentials {
            let key = item.get("key").and_then(|v| v.as_str()).unwrap_or_default();
            let label = item.get("label").and_then(|v| v.as_str()).unwrap_or(key);
            let required = item.get("required").and_then(|v| v.as_bool()).unwrap_or(false);
            let secret = item.get("secret").and_then(|v| v.as_bool()).unwrap_or(true);
            header.push((
                "credentials".into(),
                format!("{key}:{label}:{}:{}", if required { "required" } else { "optional" }, if secret { "secret" } else { "plain" }),
            ));
        }
    }

    if let Some(oauth) = object.get("oauth").and_then(|v| v.as_object()) {
        // 归一化成与头部相同的 `key=value` 片段，解析只有一份实现
        if let Some(value) = oauth.get("authorizeUrl").and_then(|v| v.as_str()) {
            header.push(("oauth".into(), format!("authorize={value}")));
        }
        if let Some(value) = oauth.get("tokenUrl").and_then(|v| v.as_str()) {
            header.push(("oauth".into(), format!("token={value}")));
        }
        if let Some(value) = oauth.get("clientId").and_then(|v| v.as_str()) {
            header.push(("oauth".into(), format!("client={value}")));
        }
        if let Some(scopes) = oauth.get("scopes").and_then(|v| v.as_array()) {
            let scopes: Vec<String> =
                scopes.iter().filter_map(|scope| scope.as_str().map(str::to_string)).collect();
            header.push(("oauth".into(), format!("scopes={}", scopes.join(" "))));
        }
        if let Some(port) = oauth.get("redirectPort").and_then(|v| v.as_u64()) {
            header.push(("oauth".into(), format!("port={port}")));
        }
        // 默认就是开 PKCE：只有显式 `pkce: false` 才关
        if oauth.get("pkce").and_then(|v| v.as_bool()) == Some(false) {
            header.push(("oauth".into(), "nopkce".into()));
        }
    }

    Ok(header)
}

// ---------------------------------------------------------------- 构建与校验

fn build(header: Header, source: Option<&str>) -> Fallible<ParsedPlugin> {
    let mut warnings: Vec<String> = Vec::new();
    let mut invalid: Vec<serde_json::Value> = Vec::new();

    let single = |key: &str| -> Option<String> {
        header.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).filter(|v| !v.is_empty())
    };
    let many = |key: &str| -> Vec<String> {
        header.iter().filter(|(k, _)| k == key).map(|(_, v)| v.clone()).filter(|v| !v.is_empty()).collect()
    };

    // ---- 必填字段 ----
    let mut missing: Vec<&str> = Vec::new();
    let id = single("id").unwrap_or_default();
    let name = single("name").unwrap_or_default();
    let version = single("version").unwrap_or_default();
    let author = single("author").unwrap_or_default();
    for (field, value) in [("id", &id), ("name", &name), ("version", &version), ("author", &author)] {
        if value.is_empty() {
            missing.push(field);
        }
    }
    if !missing.is_empty() {
        return Err(invalid_source("插件源缺少必填字段", serde_json::json!({ "missing": missing })));
    }

    // ---- id / version 形状 ----
    if !is_valid_id(&id) {
        invalid.push(serde_json::json!({
            "field": "id",
            "value": id,
            "expect": "小写字母/数字/连字符，2~32 位，不能以连字符开头"
        }));
    }
    if !is_valid_version(&version) {
        invalid.push(serde_json::json!({"field": "version", "value": version, "expect": "语义化版本，如 1.0.0"}));
    }

    // ---- 音质 / 权限 / 域名 ----
    let mut qualities = Vec::new();
    for value in many("qualities") {
        match TrackQuality::parse(&value) {
            Some(quality) => {
                if !qualities.contains(&quality) {
                    qualities.push(quality);
                }
            }
            None => invalid.push(serde_json::json!({"field": "qualities", "value": value, "expect": "standard|high|lossless|hires"})),
        }
    }
    if qualities.is_empty() {
        // 未声明时按最低档处理，并在预览里说明（避免插件作者漏写导致不可用）
        qualities.push(TrackQuality::Standard);
        warnings.push("未声明 @qualities，按 standard 处理".into());
    }

    let mut permissions = Vec::new();
    for value in many("permissions") {
        match PluginPermission::parse(&value) {
            Some(permission) => {
                if !permissions.contains(&permission) {
                    permissions.push(permission);
                }
            }
            None => invalid.push(serde_json::json!({"field": "permissions", "value": value, "expect": "network|filesystem:read|filesystem:write|credentials"})),
        }
    }

    let mut hosts = Vec::new();
    for value in many("hosts") {
        if is_valid_host(&value) {
            if !hosts.contains(&value) {
                hosts.push(value);
            }
        } else {
            invalid.push(serde_json::json!({"field": "hosts", "value": value, "expect": "纯域名（不带协议与路径）"}));
        }
    }

    // ---- 凭据 ----
    let mut credentials = Vec::new();
    for value in many("credentials") {
        match parse_credential(&value) {
            Ok(field) => credentials.push(field),
            Err(detail) => invalid.push(detail),
        }
    }

    // ---- 第三方授权（@oauth）：端点由插件声明，核心只跑通用 OAuth 流程 ----
    let oauth = parse_oauth(&many("oauth"), &hosts, &mut invalid);

    // 头部出现 `@compat` 即开启兼容模式（不需要值，避免 @compat=true 这类歧义）
    let compat = header.iter().any(|(key, _)| key == "compat");

    // ---- 权限推导：声明即生效，避免作者漏写 @permissions 导致能力静默失效 ----
    if !hosts.is_empty() && !permissions.contains(&PluginPermission::Network) {
        permissions.push(PluginPermission::Network);
    }
    // 兼容模式必然需要出网（放行任意公网 HTTPS），因此同样推导 network 权限——
    // 否则插件会在权限检查处被拒，兼容模式形同虚设。
    if compat && !permissions.contains(&PluginPermission::Network) {
        permissions.push(PluginPermission::Network);
    }
    if !credentials.is_empty() && !permissions.contains(&PluginPermission::Credentials) {
        permissions.push(PluginPermission::Credentials);
    }
    // 第三方授权：令牌存凭据库（credentials），流程本身要出网（network）——声明即生效，
    // 否则作者漏写 @permissions 时授权会在权限检查处被拒，而界面只会看到一句「失败」。
    if oauth.is_some() {
        for permission in [PluginPermission::Network, PluginPermission::Credentials] {
            if !permissions.contains(&permission) {
                permissions.push(permission);
            }
        }
    }

    // ---- 能力预扫描（仅用于预览提示） ----
    let capabilities = match source {
        Some(text) => scan_capabilities(text),
        None => Vec::new(),
    };
    if source.is_some() {
        let found: Vec<&str> = capabilities.iter().map(|c| c.name()).collect();
        for required in REQUIRED_CAPABILITIES {
            if !found.contains(&required) {
                warnings.push(format!("未找到必选函数 {required}（静态扫描结果，安装后以运行时探测为准）"));
            }
        }
    }

    // ---- 生态兼容性提示 ----
    // 现实中的社区插件大量是 MusicFree / LX Music 风格：CommonJS 模块 + npm 依赖
    // （require("axios"/"crypto-js"/"dayjs"/"he") + module.exports）。兼容模式（@compat）能跑它们，
    // 但**模块清单是固定的**——在**预览阶段**就说清楚会缺什么，而不是让用户装完才看到报错。
    if let Some(text) = source {
        let commonjs = text.contains("require(") || text.contains("module.exports") || text.contains("exports.");
        if commonjs {
            if !compat {
                warnings.push(
                    "检测到 CommonJS 模块（require/module.exports）：需要在文件头加 @compat 开启兼容模式\
                     （兼容模式可访问任意公网域名，权限弱于自有 ABI）"
                        .into(),
                );
            }
            let external: Vec<String> = required_modules(text)
                .into_iter()
                .filter(|name| !BUILTIN_REQUIRE_MODULES.contains(&name.as_str()))
                .collect();
            if !external.is_empty() {
                warnings.push(format!(
                    "require 了固定清单之外的模块：{}——兼容模式只内置 {}，安装后会在 require 处报错",
                    external.join(", "),
                    BUILTIN_REQUIRE_MODULES.join(" / ")
                ));
            }
        }
    }
    // ---- 未知头部字段：提示但不阻断（便于格式演进） ----
    const KNOWN: [&str; 16] = [
        "id", "name", "version", "author", "description", "homepage", "url", "entry", "qualities",
        "permissions", "hosts", "credentials", "oauth", "mincoreversion", "tags", "compat",
    ];
    let unknown: Vec<String> = header
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !KNOWN.contains(&k.as_str()))
        .collect();
    if !unknown.is_empty() {
        let mut unique = unknown;
        unique.sort();
        unique.dedup();
        warnings.push(format!("忽略未知头部字段：{}", unique.join(", ")));
    }

    if !invalid.is_empty() {
        return Err(invalid_source("插件源字段不合法", serde_json::json!({ "invalid": invalid })));
    }

    Ok(ParsedPlugin {
        manifest: PluginManifest {
            id,
            name,
            version,
            author,
            description: single("description").unwrap_or_default(),
            // `@url` 是社区约定（Legado 同款），`@homepage` 为兼容别名，两者都认
            homepage: single("homepage").or_else(|| single("url")),
            entry: single("entry"),
            qualities,
            permissions,
            hosts,
            credentials,
            oauth,
            min_core_version: single("mincoreversion"),
            tags: many("tags"),
            capabilities,
            compat,
        },
        warnings,
    })
}

fn invalid_source(message: &str, details: serde_json::Value) -> CoreError {
    CoreError::new(ErrorCode::PluginInvalidSource, message).with_details(details)
}

/// 解析 `@oauth` 的 `key=value` 片段（目录包走 `header_from_json` 归一化成同一形状）。
///
/// 返回 `None` = 没声明；`Some` = 声明合法（或至少能构造出来），非法项进 `invalid`。
fn parse_oauth(
    pieces: &[String],
    hosts: &[String],
    invalid: &mut Vec<serde_json::Value>,
) -> Option<OAuthConfig> {
    if pieces.is_empty() {
        return None;
    }

    let mut config = OAuthConfig {
        authorize_url: String::new(),
        token_url: String::new(),
        client_id: String::new(),
        scopes: Vec::new(),
        pkce: true,
        redirect_port: 0,
    };

    for piece in pieces {
        let (key, value) = match piece.split_once('=') {
            Some((key, value)) => (key.trim().to_ascii_lowercase(), value.trim().to_string()),
            // 无值片段（`pkce` / `nopkce`）也要认
            None => (piece.trim().to_ascii_lowercase(), String::new()),
        };
        match key.as_str() {
            "authorize" | "authorizeurl" => config.authorize_url = value,
            "token" | "tokenurl" => config.token_url = value,
            "client" | "clientid" => config.client_id = value,
            "scopes" | "scope" => {
                config.scopes = value.split([' ', '+']).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect();
            }
            "port" | "redirectport" => match value.parse::<u16>() {
                Ok(port) => config.redirect_port = port,
                Err(_) => invalid.push(serde_json::json!({
                    "field": "oauth",
                    "value": piece,
                    "expect": "port 必须是 0~65535 的整数（0 = 随机端口）",
                })),
            },
            "pkce" => config.pkce = value.is_empty() || value.eq_ignore_ascii_case("true"),
            "nopkce" => config.pkce = false,
            _ => invalid.push(serde_json::json!({
                "field": "oauth",
                "value": piece,
                "expect": "authorize= / token= / client= / scopes= / port= / pkce / nopkce",
            })),
        }
    }

    for (field, value) in [
        ("authorize", &config.authorize_url),
        ("token", &config.token_url),
        ("client", &config.client_id),
    ] {
        if value.trim().is_empty() {
            invalid.push(serde_json::json!({
                "field": "oauth",
                "value": format!("{field}="),
                "expect": "第三方授权至少需要 authorize= / token= / client= 三项",
            }));
        }
    }

    // 端点白名单：授权端点与令牌端点都要能过普通出网那一关（不额外开口子）。
    // 回环地址不需要声明主机名——它只用于本机/测试，不构成对外访问。
    for (what, url) in [("authorize", &config.authorize_url), ("token", &config.token_url)] {
        if url.trim().is_empty() || is_loopback_http(url) {
            continue;
        }
        let allowed_https = url.starts_with("https://")
            && super::transport::host_of(url)
                .is_some_and(|host| super::transport::host_allowed(hosts, &host));
        if !allowed_https {
            invalid.push(serde_json::json!({
                "field": "oauth",
                "value": format!("{what}={url}"),
                "expect": "授权端点必须是 HTTPS，且域名写进 @hosts（本机回环 http 除外）",
            }));
        }
    }

    Some(config)
}

/// 本机回环的 `http://` 地址（只有它允许明文：测试与本地授权页）。
fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// 兼容模式内置的 `require` 清单（**唯一实现**在 `sandbox/compat.js`，这里只用于预览提示）。
pub const BUILTIN_REQUIRE_MODULES: [&str; 4] = ["he", "axios", "dayjs", "crypto-js"];

/// 静态扫出 `require("...")` 里的模块名（只用于预览提示，不作安全判断）。
///
/// 写法上只认 `require(` + 引号，够覆盖社区插件的实际用法；扫不到的宁可漏报，
/// 也不猜——真正的判定在运行时（清单外一律抛可执行错误）。
pub(crate) fn required_modules(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut index = 0usize;
    while let Some(offset) = text[index..].find("require") {
        let mut rest = &text[index + offset + "require".len()..];
        index += offset + "require".len();
        rest = rest.trim_start();
        let Some(after) = rest.strip_prefix('(') else { continue };
        let after = after.trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
        let Some(end) = after[1..].find(quote) else { continue };
        let name = &after[1..1 + end];
        if !name.is_empty() && !found.iter().any(|seen| seen == name) {
            found.push(name.to_string());
        }
    }
    found
}

fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 语义化版本：`1.0.0`，允许 `-preview`/`+build` 后缀。
pub(crate) fn is_valid_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() >= 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// 域名白名单：只接受纯主机名（可带端口），拒绝协议、路径与通配。
///
/// 也是 `plugin.compat.confirm`（TOFU 收敛）写白名单前的校验——白名单是安全边界，
/// 校验只能有一份实现。
pub fn is_valid_host(host: &str) -> bool {
    if host.is_empty() || host.contains('/') || host.contains(' ') || host.contains("://") || host.contains('*') {
        return false;
    }
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    if let Some(port) = port {
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    name.contains('.') && name.split('.').all(|label| !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// `key:label[:required|optional][:secret|plain]`
fn parse_credential(value: &str) -> Result<CredentialField, serde_json::Value> {
    let parts: Vec<&str> = value.split(':').map(str::trim).collect();
    let key = parts.first().copied().unwrap_or_default();
    let label = parts.get(1).copied().filter(|l| !l.is_empty()).unwrap_or(key);

    if key.is_empty() || !key.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Err(serde_json::json!({
            "field": "credentials",
            "value": value,
            "expect": "key:标签[:required|optional][:secret|plain]，key 以字母开头"
        }));
    }

    let mut required = false;
    let mut secret = true;
    for flag in parts.iter().skip(2) {
        match flag.to_ascii_lowercase().as_str() {
            "" => {}
            "required" => required = true,
            "optional" => required = false,
            "secret" => secret = true,
            "plain" => secret = false,
            other => {
                return Err(serde_json::json!({
                    "field": "credentials",
                    "value": other,
                    "expect": "required|optional|secret|plain"
                }))
            }
        }
    }

    Ok(CredentialField { key: key.to_string(), label: label.to_string(), required, secret })
}

/// 静态预扫描：只认顶层 `function <name>` / `async function <name>` 声明。
fn scan_capabilities(source: &str) -> Vec<PluginCapability> {
    CAPABILITY_NAMES
        .iter()
        .filter(|name| {
            source.contains(&format!("function {name}(")) || source.contains(&format!("function {name} ("))
        })
        .filter_map(|name| PluginCapability::from_name(name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
// @id demo-source
// @name 示例音源
// @version 1.0.0
// @author someone
async function search(keyword, page) { return []; }
async function getMediaSource(track, quality) { return null; }
"#;

    #[test]
    fn parses_minimal_header() {
        let parsed = parse_source(MINIMAL).expect("应解析成功");
        assert_eq!(parsed.manifest.id, "demo-source");
        assert_eq!(parsed.manifest.author, "someone");
        // 未声明音质 → 默认 standard 并给出警告
        assert_eq!(parsed.manifest.qualities, vec![TrackQuality::Standard]);
        assert!(parsed.warnings.iter().any(|w| w.contains("qualities")));
        // 能力预扫描
        assert!(parsed.manifest.capabilities.contains(&PluginCapability::Search));
        assert!(parsed.manifest.capabilities.contains(&PluginCapability::GetMediaSource));
    }

    #[test]
    fn missing_required_field_is_invalid_source() {
        let err = parse_source("// @name 没有 id\n").unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginInvalidSource);
        let details = err.details.unwrap();
        assert!(details["missing"].as_array().unwrap().iter().any(|v| v == "id"));
    }

    #[test]
    fn hosts_grant_network_permission_and_reject_urls() {
        let ok = parse_source(&format!("{MINIMAL}// @hosts api.example.com,cdn.example.com\n")).unwrap();
        assert_eq!(ok.manifest.hosts.len(), 2);
        assert!(ok.manifest.permissions.contains(&PluginPermission::Network));

        let bad = parse_source(&format!("{MINIMAL}// @hosts https://api.example.com/path\n")).unwrap_err();
        assert_eq!(bad.code, ErrorCode::PluginInvalidSource);
    }

    #[test]
    fn credentials_are_parsed_and_imply_permission() {
        let source = format!("{MINIMAL}// @credentials apiKey:API Key:required\n// @credentials user:账号:optional:plain\n");
        let parsed = parse_source(&source).unwrap();
        assert_eq!(parsed.manifest.credentials.len(), 2);
        let first = &parsed.manifest.credentials[0];
        assert_eq!(first.key, "apiKey");
        assert_eq!(first.label, "API Key");
        assert!(first.required && first.secret);
        assert!(!parsed.manifest.credentials[1].secret);
        assert!(parsed.manifest.permissions.contains(&PluginPermission::Credentials));
    }

    #[test]
    fn oauth_header_is_parsed_with_pkce_default_on() {
        let source = format!(
            "{MINIMAL}// @hosts id.example.com\n// @oauth authorize=https://id.example.com/authorize,token=https://id.example.com/token,client=demo,scopes=fav read\n"
        );
        let parsed = parse_source(&source).unwrap();
        let oauth = parsed.manifest.oauth.expect("应解析出 @oauth");
        assert_eq!(oauth.authorize_url, "https://id.example.com/authorize");
        assert_eq!(oauth.token_url, "https://id.example.com/token");
        assert_eq!(oauth.client_id, "demo");
        assert_eq!(oauth.scopes, vec!["fav".to_string(), "read".to_string()]);
        assert!(oauth.pkce, "默认开 PKCE");
        assert_eq!(oauth.redirect_port, 0);
        // 声明 @oauth 即隐含 network + credentials 权限
        assert!(parsed.manifest.permissions.contains(&PluginPermission::Network));
        assert!(parsed.manifest.permissions.contains(&PluginPermission::Credentials));
    }

    #[test]
    fn oauth_endpoint_host_must_be_declared_and_https() {
        // 端点域名没写进 @hosts → 拒绝（授权端点不额外开口子）
        let missing = parse_source(&format!(
            "{MINIMAL}// @hosts api.example.com\n// @oauth authorize=https://id.example.com/authorize,token=https://id.example.com/token,client=demo\n"
        ))
        .unwrap_err();
        assert_eq!(missing.code, ErrorCode::PluginInvalidSource);
        let details = missing.details.unwrap();
        assert!(details["invalid"].as_array().unwrap().iter().any(|item| item["field"] == "oauth"));

        // 明文 http 到公网 → 拒绝
        let plain = parse_source(&format!(
            "{MINIMAL}// @hosts id.example.com\n// @oauth authorize=http://id.example.com/authorize,token=https://id.example.com/token,client=demo\n"
        ))
        .unwrap_err();
        assert_eq!(plain.code, ErrorCode::PluginInvalidSource);

        // 本机回环 http 允许（测试 / 本地授权页），且不必写进 @hosts
        let loopback = parse_source(&format!(
            "{MINIMAL}// @oauth authorize=http://127.0.0.1:9/authorize,token=http://127.0.0.1:9/token,client=demo,nopkce\n"
        ))
        .expect("回环端点应允许");
        let oauth = loopback.manifest.oauth.unwrap();
        assert!(!oauth.pkce, "nopkce 应关闭 PKCE");
    }

    #[test]
    fn oauth_missing_required_pieces_is_invalid() {
        let err = parse_source(&format!("{MINIMAL}// @hosts id.example.com\n// @oauth authorize=https://id.example.com/authorize\n"))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginInvalidSource);
        let details = err.details.unwrap();
        let invalid = details["invalid"].as_array().unwrap();
        assert!(invalid.iter().filter(|item| item["field"] == "oauth").count() >= 2, "{invalid:?}");
    }

    #[test]
    fn oauth_can_be_declared_in_plugin_json() {
        let json = r#"{
            "id": "demo-source", "name": "Demo", "version": "1.0.0", "author": "someone",
            "hosts": ["id.example.com"],
            "oauth": {
                "authorizeUrl": "https://id.example.com/authorize",
                "tokenUrl": "https://id.example.com/token",
                "clientId": "demo",
                "scopes": ["fav"],
                "pkce": false
            }
        }"#;
        let parsed = parse_manifest_json(json, None).unwrap();
        let oauth = parsed.manifest.oauth.expect("目录包也应能声明授权");
        assert_eq!(oauth.client_id, "demo");
        assert_eq!(oauth.scopes, vec!["fav".to_string()]);
        assert!(!oauth.pkce);
    }

    #[test]
    fn commonjs_plugins_get_an_actionable_warning() {
        let cjs = "// @id cjs-source\n// @name CJS\n// @version 1.0.0\n// @author x\nconst axios = require('axios');\nmodule.exports = {async search() { return []; }};\n";

        // 非兼容模式：说清「差一个 @compat」，而不是笼统地说「跑不起来」
        let parsed = parse_source(cjs).expect("头部合法即应解析成功");
        assert!(
            parsed.warnings.iter().any(|w| w.contains("CommonJS") && w.contains("@compat")),
            "应提示需要 @compat：{:?}",
            parsed.warnings
        );
        // axios 在固定清单内 → 不该出现「清单之外」的告警
        assert!(
            !parsed.warnings.iter().any(|w| w.contains("清单之外")),
            "{:?}",
            parsed.warnings
        );

        // 兼容模式 + 清单内的依赖：不再有兼容性告警
        let parsed = parse_source(&format!("{cjs}// @compat\n")).expect("解析成功");
        assert!(parsed.manifest.compat);
        assert!(
            !parsed.warnings.iter().any(|w| w.contains("CommonJS")),
            "{:?}",
            parsed.warnings
        );

        // 清单之外的依赖：预览阶段就要点名
        let parsed = parse_source(&format!("{cjs}const _ = require('lodash');\n")).expect("解析成功");
        assert!(
            parsed.warnings.iter().any(|w| w.contains("lodash") && w.contains("crypto-js")),
            "应列出清单外的模块与可用清单：{:?}",
            parsed.warnings
        );

        // 自有 ABI 的单文件插件不应出现该提示
        let parsed = parse_source(MINIMAL).expect("解析成功");
        assert!(!parsed.warnings.iter().any(|w| w.contains("CommonJS")));
    }

    #[test]
    fn required_module_scan_reads_quoted_specifiers() {
        let text = "const a = require('axios');\nconst b = require(\"crypto-js/md5\");\nconst c = require(variable);\n";
        assert_eq!(required_modules(text), vec!["axios".to_string(), "crypto-js/md5".to_string()]);
        assert!(required_modules("const x = 1;").is_empty());
    }

    #[test]
    fn unknown_header_keys_only_warn() {
        let parsed = parse_source(&format!("{MINIMAL}// @whatever 1\n")).unwrap();
        assert!(parsed.warnings.iter().any(|w| w.contains("whatever")));
    }

    #[test]
    fn bad_quality_is_reported() {
        let err = parse_source(&format!("{MINIMAL}// @qualities hq\n")).unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginInvalidSource);
        let details = err.details.unwrap();
        assert_eq!(details["invalid"][0]["field"], "qualities");
    }

    #[test]
    fn json_manifest_uses_the_same_validation() {
        let json = r#"{
            "id": "dir-source", "name": "目录包", "version": "0.2.0", "author": "someone",
            "entry": "main.js", "qualities": ["high"], "hosts": ["api.example.com"],
            "credentials": [{"key": "token", "label": "Token", "required": true, "secret": true}]
        }"#;
        let parsed = parse_manifest_json(json, None).unwrap();
        assert_eq!(parsed.manifest.entry.as_deref(), Some("main.js"));
        assert_eq!(parsed.manifest.qualities, vec![TrackQuality::High]);
        assert!(parsed.manifest.capabilities.is_empty(), "未提供入口源码时不做能力扫描");

        let broken = parse_manifest_json("{ not json", None).unwrap_err();
        assert_eq!(broken.code, ErrorCode::PluginInvalidManifest);
    }

    #[test]
    fn id_and_version_shapes_are_enforced() {
        assert!(parse_source(&MINIMAL.replace("demo-source", "Bad_ID")).is_err());
        assert!(parse_source(&MINIMAL.replace("1.0.0", "v1")).is_err());
    }
}
