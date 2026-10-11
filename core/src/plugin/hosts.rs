//! 兼容模式的域名观测（TOFU 收敛，ADR-0006 待完成最后一项）。
//!
//! 兼容插件没有域名声明，所以「它到底访问了哪些域名」只能靠**观测**。这个模块做两件事：
//!
//! 1. 沙箱在放行兼容请求时把域名记下来（内存 + `plugins/.hosts/<id>.json`）；
//! 2. 用户确认后，`plugin.compat.confirm` 把这份域名列表固化成插件的 `hosts` 白名单，
//!    并关掉兼容模式——插件从此回到「声明式白名单」的严格模型。
//!    这是兼容模式唯一**收窄**权限的路径（放宽容易，收窄必须有据可依）。
//!
//! 为什么记在文件而不是 SQLite：这是**观测数据**（可丢、可重建、不是权威状态），
//! 与 `plugins/.kv/` 同属插件私有旁路文件；库表留给真正的状态（plugin_state / subscriptions）。
//! 卸载时 `forget` 一并清掉。
//!
//! 落盘策略：只在**出现新域名**时写文件（计数与时间留在内存），
//! 因此正常播放不会因为记账而产生额外 I/O；重启后域名集合仍在。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// 某个域名的使用记录。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUse {
    pub host: String,
    /// 放行次数（进程内累计；重启后从文件恢复的是上次落盘时的值）
    pub count: u64,
    pub first_seen: i64,
    pub last_seen: i64,
}

impl HostUse {
    fn new(host: &str, now: i64) -> Self {
        Self { host: host.to_string(), count: 1, first_seen: now, last_seen: now }
    }

    fn touch(&mut self, now: i64) {
        self.count += 1;
        self.last_seen = now;
    }
}

/// 一个插件的域名台账。
#[derive(Default)]
struct Ledger {
    /// 按首次出现顺序排列（界面按这个顺序展示，用户更容易认出「先用了哪个」）
    hosts: Vec<HostUse>,
    /// 是否已经从磁盘读过（避免每次请求都读文件）
    loaded: bool,
}

/// 全部插件的域名台账（`PluginHost` 持有，跨插件线程共享）。
pub struct HostLedger {
    dir: PathBuf,
    ledgers: Mutex<HashMap<String, Ledger>>,
}

impl HostLedger {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, ledgers: Mutex::new(HashMap::new()) }
    }

    /// 记一次「该插件访问了这个域名」。新域名会立即落盘。
    pub fn observe(&self, plugin_id: &str, host: &str) {
        let host = host.trim().to_ascii_lowercase();
        if host.is_empty() {
            return;
        }
        let now = now_millis();

        let Ok(mut ledgers) = self.ledgers.lock() else { return };
        let ledger = ledgers.entry(plugin_id.to_string()).or_default();
        if !ledger.loaded {
            ledger.hosts = read_file(&self.path(plugin_id));
            ledger.loaded = true;
        }

        match ledger.hosts.iter_mut().find(|entry| entry.host == host) {
            Some(entry) => {
                entry.touch(now);
                return; // 已知域名：不落盘
            }
            None => ledger.hosts.push(HostUse::new(&host, now)),
        }
        write_file(&self.path(plugin_id), &ledger.hosts);
    }

    /// 该插件访问过的域名（首次出现顺序）。
    pub fn observed(&self, plugin_id: &str) -> Vec<HostUse> {
        let Ok(mut ledgers) = self.ledgers.lock() else { return Vec::new() };
        let ledger = ledgers.entry(plugin_id.to_string()).or_default();
        if !ledger.loaded {
            ledger.hosts = read_file(&self.path(plugin_id));
            ledger.loaded = true;
        }
        ledger.hosts.clone()
    }

    /// 收敛后清空：域名已经进了白名单，观测记录没有继续留着的理由。
    pub fn clear(&self, plugin_id: &str) {
        if let Ok(mut ledgers) = self.ledgers.lock() {
            ledgers.remove(plugin_id);
        }
        let _ = std::fs::remove_file(self.path(plugin_id));
    }

    fn path(&self, plugin_id: &str) -> PathBuf {
        self.dir.join(format!("{plugin_id}.json"))
    }
}

/// 读台账文件；损坏或不存在都按「没观测过」处理（观测数据不值得因此报错）。
fn read_file(path: &PathBuf) -> Vec<HostUse> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<HostUse>>(&text).ok())
        .unwrap_or_default()
}

/// 原子写：先写临时文件再 rename（与插件 kv 同一套路，避免半截 JSON）。
fn write_file(path: &PathBuf, hosts: &[HostUse]) {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let Ok(text) = serde_json::to_string(hosts) else { return };
    let temp = path.with_extension("tmp");
    if std::fs::write(&temp, text).is_ok() {
        let _ = std::fs::rename(&temp, path);
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gently-hosts-{tag}-{}-{}",
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
    fn observes_hosts_and_survives_a_restart() {
        let dir = temp_dir("restart");
        let ledger = HostLedger::new(dir.clone());

        ledger.observe("p1", "API.Example.com");
        ledger.observe("p1", "api.example.com");
        ledger.observe("p1", "cdn.example.com");
        ledger.observe("p2", "other.example.net");

        let hosts = ledger.observed("p1");
        assert_eq!(hosts.len(), 2, "同一域名大小写不同只算一次：{hosts:?}");
        assert_eq!(hosts[0].host, "api.example.com");
        assert_eq!(hosts[0].count, 2);
        assert!(hosts[0].first_seen <= hosts[0].last_seen);
        // 插件之间互不串台
        assert_eq!(ledger.observed("p2").len(), 1);

        // 新进程（新台账）也能读到已落盘的域名
        let reopened = HostLedger::new(dir.clone());
        let hosts = reopened.observed("p1");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[1].host, "cdn.example.com");

        reopened.clear("p1");
        assert!(reopened.observed("p1").is_empty());
        assert!(HostLedger::new(dir.clone()).observed("p1").is_empty(), "文件也要删掉");
        assert_eq!(reopened.observed("p2").len(), 1, "清一个插件不影响别的插件");

        std::fs::remove_dir_all(&dir).ok();
    }
}
