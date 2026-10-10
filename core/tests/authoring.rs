//! 作者工具（`plugin-tool`）的测试：既覆盖校验/生成逻辑，也保证**随仓库的示例插件始终合法**。

use std::path::PathBuf;

use gently_core::plugin::authoring::{
    check_file, check_text, generate_index, iso8601_from_unix, GenerateOptions,
};
use gently_core::plugin::parse_index;

const GOOD: &str = r#"
// @id author-source
// @name 作者源
// @version 1.0.0
// @author someone
// @tags 示例,测试
// @qualities high,standard
// @hosts api.example.com
async function search(keyword) { return []; }
async function getMediaSource(track, quality) { return null; }
"#;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "gently-authoring-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn check_accepts_a_valid_plugin_and_reports_warnings() {
    let report = check_text("good.js", GOOD);
    assert!(report.ok(), "{:?}", report.error);
    let manifest = report.manifest.unwrap();
    assert_eq!(manifest.id, "author-source");
    assert_eq!(manifest.qualities.len(), 2);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    // 缺 @qualities → 通过但给出警告（作者应看到）
    let minimal = GOOD.replace("// @qualities high,standard\n", "");
    let report = check_text("minimal.js", &minimal);
    assert!(report.ok());
    assert!(report.warnings.iter().any(|w| w.contains("qualities")));
}

#[test]
fn check_reports_field_level_problems() {
    let report = check_text("bad.js", "// @name 只有名字\n");
    assert!(!report.ok());
    let error = report.error.unwrap();
    assert!(error.message.contains("缺少必填字段"));
    assert!(error.details.unwrap().to_string().contains("id"));

    // @hosts 写成 URL 是常见错误，必须被指出
    let report = check_text("bad-host.js", &format!("{GOOD}// @hosts https://api.example.com/x\n"));
    assert!(!report.ok());
    assert!(report.error.unwrap().details.unwrap().to_string().contains("hosts"));

    // 文件不存在
    let report = check_file(&PathBuf::from("does-not-exist.js"));
    assert!(!report.ok());
}

#[test]
fn index_generation_covers_fields_and_validates_input() {
    let dir = temp_dir("index");
    std::fs::write(dir.join("author-source.js"), GOOD).unwrap();

    let options = GenerateOptions {
        base_url: "https://example.com/plugins/".into(),
        name: Some("测试仓库".into()),
        skip_invalid: false,
    };
    let (index, reports) = generate_index(&dir, &options).expect("应生成索引");

    assert_eq!(index.name, "测试仓库");
    assert_eq!(index.sources.len(), 1);
    let entry = &index.sources[0];
    assert_eq!(entry.file_name, "author-source.js");
    assert_eq!(entry.download_url, "https://example.com/plugins/author-source.js");
    assert_eq!(entry.version, "1.0.0");
    assert_eq!(entry.group, "示例", "第一个标签作为分组");
    assert_eq!(entry.sha256.as_deref().unwrap().len(), 64);
    assert!(entry.file_size > 0);
    assert!(entry.updated_at.ends_with('Z'), "{}", entry.updated_at);
    assert_eq!(entry.hosts, vec!["api.example.com"]);
    assert!(reports.iter().all(|report| report.ok()));

    // 生成的索引必须能被客户端解析（闭环校验：作者产出 == 客户端接受）
    let json = serde_json::to_string(&index).unwrap();
    let reparsed = parse_index(&json).expect("生成的索引应通过客户端校验");
    assert_eq!(reparsed.sources.len(), 1);

    // base-url 必须 HTTPS
    let bad = GenerateOptions { base_url: "http://example.com/p".into(), ..options.clone() };
    assert!(generate_index(&dir, &bad).is_err());

    // 目录里有坏文件：默认失败；--skip-invalid 时跳过并保留好文件
    std::fs::write(dir.join("broken.js"), "// @name 缺 id 与版本\n").unwrap();
    let strict = generate_index(&dir, &options);
    assert!(strict.is_err(), "默认不应发布残缺索引");
    assert!(strict.unwrap_err().details.unwrap().to_string().contains("broken.js"));

    let lenient = generate_index(&dir, &GenerateOptions { skip_invalid: true, ..options }).unwrap();
    assert_eq!(lenient.0.sources.len(), 1, "只保留合法文件");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn shipped_demo_plugin_is_valid_and_safe() {
    // 随仓库的示例插件必须始终合法（文档里承诺可直接 check 通过）
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace 根")
        .join("examples/plugins/gently-demo.js");

    let report = check_file(&path);
    assert!(report.ok(), "{:?} @ {}", report.error, path.display());

    let manifest = report.manifest.expect("示例插件应有清单");
    assert_eq!(manifest.id, "gently-demo");
    // `@url` 是社区约定的主页字段，必须被识别（而不是当作未知字段忽略）
    assert_eq!(manifest.homepage.as_deref(), Some("https://example.com/gently-demo"));
    assert!(!report.warnings.iter().any(|w| w.contains("url")), "{:?}", report.warnings);
    // 中立性：示例插件不声明任何网络白名单，也不索要凭据（ADR-0005）
    assert!(manifest.hosts.is_empty(), "示例插件不应声明网络白名单");
    assert!(manifest.credentials.is_empty());
    assert!(manifest.capabilities.iter().any(|c| format!("{c:?}") == "Search"));
}

#[test]
fn iso8601_is_stable_for_the_documented_examples() {
    assert_eq!(iso8601_from_unix(1_760_000_000), "2025-10-09T08:53:20Z");
}
