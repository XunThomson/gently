//! TOFU 收敛（ADR-0006 待完成最后一项）的集成测试。
//!
//! 兼容插件没有域名声明，所以「它用了哪些域名」只能靠观测；用户确认后把观测结果固化成
//! `hosts` 白名单并**关闭兼容模式**——这是兼容模式唯一**收窄**权限的路径。
//!
//! 这里盯住三件事：
//! 1. 观测真的记在兼容模式下放行的域名上（且只有兼容模式才记）；
//! 2. 固化后白名单**真的生效**：没写进白名单的域名立刻被拒；
//! 3. 白名单不能凭空写进来（只能来自观测），且必须显式同意。

use std::sync::{Arc, Mutex};

use gently_core::commands::dispatch;
use gently_core::contract::{ErrorCode, Fallible};
use gently_core::plugin::{HttpRequest, HttpResponse, HttpTransport};
use gently_core::{AppPaths, CoreContext, Store};
use serde_json::{json, Value};

mod common;

/// 只记录、永远成功的出网通道（测试里不碰真实网络）。
#[derive(Default)]
struct RecordingTransport {
    calls: Mutex<Vec<String>>,
}

impl HttpTransport for RecordingTransport {
    fn send(&self, request: &HttpRequest) -> Fallible<HttpResponse> {
        self.calls.lock().unwrap().push(request.url.clone());
        Ok(HttpResponse {
            status: 200,
            headers: vec![],
            body: "{}".to_string(),
            truncated: false,
        })
    }
}

/// 兼容插件：搜索时依次访问两个不同域名，并把结果如实报回来（拒绝也要能看出来）。
const COMPAT_PLUGIN: &str = r#"
module.exports = {
    platform: "TOFU 源",
    version: "1.0.0",
    async search() {
        const out = [];
        try { await fetch('https://api.example.com/list'); out.push('api-ok'); }
        catch (err) { out.push('api-denied'); }
        try { await fetch('https://cdn.example.com/x'); out.push('cdn-ok'); }
        catch (err) { out.push('cdn-denied'); }
        return out;
    },
    async getMediaSource() { return null; },
};
"#;

fn temp_ctx(tag: &str) -> (CoreContext, Arc<RecordingTransport>, std::path::PathBuf) {
    let dir = common::temp_dir(&format!("tofu-{tag}"));
    let paths = AppPaths::resolve(&dir);
    paths.ensure().expect("建目录");
    let store = Store::open(&paths.db).expect("打开库");
    let transport = Arc::new(RecordingTransport::default());
    let ctx = CoreContext::new(paths).with_store(store).with_http(transport.clone());
    (ctx, transport, dir)
}

fn call(ctx: &CoreContext, command: &str, params: Value) -> Value {
    serde_json::to_value(dispatch(ctx, command, params)).unwrap()
}

fn install_compat(ctx: &CoreContext) -> String {
    let value = call(
        ctx,
        "plugin.import",
        json!({ "from": { "kind": "paste", "content": COMPAT_PLUGIN }, "consent": true, "compat": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    value["data"]["plugin"]["id"].as_str().unwrap().to_string()
}

/// 加载插件并跑一次 search（返回插件自报的访问结果）。
fn run_search(ctx: &CoreContext, id: &str) -> Value {
    let reloaded = call(ctx, "plugin.reload", json!({ "id": id }));
    assert_eq!(reloaded["ok"], json!(true), "{reloaded}");
    let raw = ctx.plugins.call(id, "search", "[]").expect("search 应能完成");
    serde_json::from_str::<Value>(&raw).unwrap()
}

fn observed(ctx: &CoreContext, id: &str) -> Value {
    let value = call(ctx, "plugin.compat.observed", json!({ "id": id }));
    assert_eq!(value["ok"], json!(true), "{value}");
    value["data"].clone()
}

#[test]
fn observed_hosts_are_recorded_only_in_compat_mode() {
    let (ctx, _transport, dir) = temp_ctx("observe");
    let id = install_compat(&ctx);

    // 还没用过：没有任何观测记录，但插件确实是兼容模式
    let before = observed(&ctx, &id);
    assert_eq!(before["compat"], json!(true));
    assert_eq!(before["hosts"], json!([]));
    assert_eq!(before["whitelist"], json!([]));

    // 兼容模式下两个域名都放行，且都进台账
    assert_eq!(run_search(&ctx, &id), json!(["api-ok", "cdn-ok"]));
    let after = observed(&ctx, &id);
    let hosts: Vec<&str> =
        after["hosts"].as_array().unwrap().iter().map(|h| h["host"].as_str().unwrap()).collect();
    assert_eq!(hosts, vec!["api.example.com", "cdn.example.com"], "{after}");
    // 计数与时间戳都要有（界面用它说明「用了几次」）
    assert_eq!(after["hosts"][0]["count"], json!(1));
    assert!(after["hosts"][0]["firstSeen"].is_number());
    assert!(after["hosts"][0]["lastSeen"].is_number());

    // 观测台账落盘：新进程（新 HostLedger）也读得到
    let reopened = gently_core::plugin::HostLedger::new(ctx.paths.plugins.join(".hosts"));
    assert_eq!(reopened.observed(&id).len(), 2, "台账应已落盘");

    // 未安装的插件 → common.not_found（而不是空列表）
    let missing = call(&ctx, "plugin.compat.observed", json!({ "id": "compat-nope" }));
    assert_eq!(missing["error"]["code"], ErrorCode::NotFound.as_str());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn confirm_freezes_the_whitelist_and_enforces_it() {
    let (ctx, _transport, dir) = temp_ctx("confirm");
    let id = install_compat(&ctx);
    assert_eq!(run_search(&ctx, &id), json!(["api-ok", "cdn-ok"]));

    // 只固化其中一个域名：另一个必须立刻被拒
    let value = call(
        &ctx,
        "plugin.compat.confirm",
        json!({ "id": id, "hosts": ["api.example.com"], "consent": true }),
    );
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["data"]["compat"], json!(false), "收敛必须关掉兼容模式");
    assert_eq!(value["data"]["manifest"]["hosts"], json!(["api.example.com"]));

    // 运行时用新清单重建后：白名单内的放行、名单外的被拒
    assert_eq!(run_search(&ctx, &id), json!(["api-ok", "cdn-denied"]));

    // 收敛后观测记录清空（域名已经进白名单，不需要再记）
    let after = observed(&ctx, &id);
    assert_eq!(after["compat"], json!(false));
    assert_eq!(after["hosts"], json!([]));
    assert_eq!(after["whitelist"], json!(["api.example.com"]));
    assert!(!ctx.paths.plugins.join(".hosts").join(format!("{id}.json")).exists());

    // 非兼容插件再收敛 → 明确报「无需收敛」
    let again = call(
        &ctx,
        "plugin.compat.confirm",
        json!({ "id": id, "hosts": ["api.example.com"], "consent": true }),
    );
    assert_eq!(again["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{again}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn confirm_refuses_hosts_that_were_never_observed() {
    let (ctx, _transport, dir) = temp_ctx("unobserved");
    let id = install_compat(&ctx);
    assert_eq!(run_search(&ctx, &id), json!(["api-ok", "cdn-ok"]));

    // 没观测过的域名不能写进白名单（否则这个命令就成了提权入口）
    let value = call(
        &ctx,
        "plugin.compat.confirm",
        json!({ "id": id, "hosts": ["api.example.com", "evil.example.net"], "consent": true }),
    );
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");
    assert!(value["error"]["message"].as_str().unwrap().contains("观测记录"), "{value}");
    assert!(value["error"]["details"]["observed"].is_array());

    // 形状非法的域名同样拒绝（白名单只接受纯主机名）
    let value = call(
        &ctx,
        "plugin.compat.confirm",
        json!({ "id": id, "hosts": ["https://api.example.com/x"], "consent": true }),
    );
    assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{value}");

    // 没有显式同意 → 拒绝；空列表 → 拒绝（并说明「还没成功出网过」）
    for params in [
        json!({ "id": id, "hosts": ["api.example.com"] }),
        json!({ "id": id, "hosts": [], "consent": true }),
    ] {
        let value = call(&ctx, "plugin.compat.confirm", params.clone());
        assert_eq!(value["error"]["code"], ErrorCode::InvalidArgument.as_str(), "{params} → {value}");
    }

    // 失败不能改动插件：仍然是兼容模式、仍然能访问别的域名
    let state = observed(&ctx, &id);
    assert_eq!(state["compat"], json!(true));
    assert_eq!(run_search(&ctx, &id), json!(["api-ok", "cdn-ok"]));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn uninstall_forgets_observed_hosts() {
    let (ctx, _transport, dir) = temp_ctx("forget");
    let id = install_compat(&ctx);
    assert_eq!(run_search(&ctx, &id), json!(["api-ok", "cdn-ok"]));
    assert_eq!(observed(&ctx, &id)["hosts"].as_array().unwrap().len(), 2);

    assert_eq!(call(&ctx, "plugin.remove", json!({ "id": id }))["ok"], json!(true));

    // 台账跟着插件一起消失：下次装同 id 的插件不该继承旧域名
    assert!(!ctx.paths.plugins.join(".hosts").join(format!("{id}.json")).exists());
    let reinstalled = install_compat(&ctx);
    assert_eq!(reinstalled, id);
    assert_eq!(observed(&ctx, &reinstalled)["hosts"], json!([]));
    assert_eq!(ctx.plugins.loaded_ids(), Vec::<String>::new(), "卸载要顺手把运行时也卸掉");

    std::fs::remove_dir_all(&dir).ok();
}
