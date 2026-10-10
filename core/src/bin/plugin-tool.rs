//! `plugin-tool`：插件作者自测工具（契约 §2 的「作者自测 CLI」）。
//!
//! ```text
//! cargo run -p gently-core --bin plugin-tool -- check <file.js>...
//! cargo run -p gently-core --bin plugin-tool -- index <dir> --base-url https://example.com/plugins [--name 仓库名] [--out repository.json] [--skip-invalid]
//! ```
//!
//! 为什么要提供它：社区插件的质量参差是常态，而「装不上/装上了不工作」的排查成本很高。
//! 作者在本地跑一遍 `check` 就能发现头部元数据漏字段、`@hosts` 写成 URL、必选函数写错名等问题。

use std::path::PathBuf;
use std::process::ExitCode;

use gently_core::plugin::authoring::{check_file, generate_index, GenerateOptions};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((command, rest)) if command == "check" => check(rest),
        Some((command, rest)) if command == "index" => index(rest),
        _ => {
            print_usage();
            ExitCode::from(2)
        }
    }
}

fn print_usage() {
    eprintln!(
        "用法：\n  plugin-tool check <file.js>...\n  plugin-tool index <dir> --base-url <https://…> [--name <仓库名>] [--out <file>] [--skip-invalid]"
    );
}

fn check(files: &[String]) -> ExitCode {
    if files.is_empty() {
        print_usage();
        return ExitCode::from(2);
    }

    let mut failed = 0;
    for file in files {
        let report = check_file(&PathBuf::from(file));
        match (&report.manifest, &report.error) {
            (Some(manifest), _) => {
                println!("✓ {}", report.file);
                println!("  id={} name={} version={}", manifest.id, manifest.name, manifest.version);
                println!(
                    "  音质={:?} 域名={:?} 凭据={}",
                    manifest.qualities,
                    manifest.hosts,
                    manifest.credentials.len()
                );
                println!("  能力（静态预扫描，安装后以运行时探测为准）={:?}", manifest.capabilities);
                for warning in &report.warnings {
                    println!("  ⚠ {warning}");
                }
            }
            (None, Some(error)) => {
                failed += 1;
                println!("✗ {}", report.file);
                println!("  {}: {}", error.code.as_str(), error.message);
                if let Some(details) = &error.details {
                    println!("  {details}");
                }
            }
            (None, None) => {
                failed += 1;
                println!("✗ {}：未解析出清单", report.file);
            }
        }
    }

    if failed > 0 {
        eprintln!("\n{failed} 个文件未通过校验");
        return ExitCode::FAILURE;
    }
    println!("\n全部通过");
    ExitCode::SUCCESS
}

fn index(args: &[String]) -> ExitCode {
    let Some(dir) = args.first().filter(|value| !value.starts_with("--")) else {
        print_usage();
        return ExitCode::from(2);
    };

    let mut base_url: Option<String> = None;
    let mut name: Option<String> = None;
    let mut out: Option<String> = None;
    let mut skip_invalid = false;

    let mut cursor = 1;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--base-url" => {
                base_url = args.get(cursor + 1).cloned();
                cursor += 2;
            }
            "--name" => {
                name = args.get(cursor + 1).cloned();
                cursor += 2;
            }
            "--out" => {
                out = args.get(cursor + 1).cloned();
                cursor += 2;
            }
            "--skip-invalid" => {
                skip_invalid = true;
                cursor += 1;
            }
            other => {
                eprintln!("未知参数：{other}");
                print_usage();
                return ExitCode::from(2);
            }
        }
    }

    let Some(base_url) = base_url else {
        eprintln!("缺少 --base-url");
        print_usage();
        return ExitCode::from(2);
    };

    let options = GenerateOptions { base_url, name, skip_invalid };
    match generate_index(&PathBuf::from(dir), &options) {
        Ok((index, reports)) => {
            for report in &reports {
                if !report.ok() {
                    println!("跳过 {}（未通过校验）", report.file);
                }
            }
            let json = match serde_json::to_string_pretty(&index) {
                Ok(json) => json,
                Err(err) => {
                    eprintln!("序列化失败：{err}");
                    return ExitCode::FAILURE;
                }
            };

            match out {
                Some(path) => match std::fs::write(&path, &json) {
                    Ok(()) => {
                        println!("已写入 {path}（{} 个条目）", index.sources.len());
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("写入失败：{err}");
                        ExitCode::FAILURE
                    }
                },
                None => {
                    println!("{json}");
                    ExitCode::SUCCESS
                }
            }
        }
        Err(err) => {
            eprintln!("生成索引失败：{} {}", err.code.as_str(), err.message);
            if let Some(details) = &err.details {
                eprintln!("{details}");
            }
            ExitCode::FAILURE
        }
    }
}
