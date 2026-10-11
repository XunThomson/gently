//! 通用导入来源（契约 §5.1）。
//!
//! 插件与皮肤**同构**：两者都靠「用户自己提供的来源」导入，
//! 因此这份枚举是跨域的公共类型，放在契约层而不是某个域的实现文件里。
//!
//! 注意 `catalog` 目前只有插件用（订阅条目一键安装），皮肤留着不用也允许
//! ——类型与文档只增不改，将来插件/皮肤共用一条订阅分发路径时不必再改形状。

/// 通用导入来源（与前端 `src/api/index.ts` 的 `ImportSource` 一致）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ImportSource {
    File { path: String },
    Dir { path: String },
    Archive { path: String },
    Url { url: String },
    Paste { content: String },
    Catalog { subscription_id: String, file_name: String },
}

impl ImportSource {
    /// 来源形态名（错误信息与详情里用，便于前端按 kind 分支）。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::File { .. } => "file",
            Self::Dir { .. } => "dir",
            Self::Archive { .. } => "archive",
            Self::Url { .. } => "url",
            Self::Paste { .. } => "paste",
            Self::Catalog { .. } => "catalog",
        }
    }
}
