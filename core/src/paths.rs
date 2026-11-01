//! 本机数据目录布局（契约 §9）。
//!
//! core 不依赖 tauri，因此**根目录由调用方注入**（Tauri 用 `app_data_dir()`，
//! 测试用临时目录）——这样同一套路径逻辑既能在应用里跑，也能单测。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::contract::{CoreError, Fallible, SystemPaths};

/// 数据目录指针文件（存在**指针目录**里，内容是用户选定的数据目录）。
///
/// 为什么需要它：用户把数据搬到别的盘之后，应用下次启动必须还知道去哪儿找。
/// 指针只能放在「不随数据移动」的位置——默认数据目录（或便携版的 exe 同目录），
/// 而不是数据目录自己内部（搬走之后那里就没人读得到了）。
pub const DATA_LOCATION_FILE: &str = "data-location.json";

/// 便携版标记文件（放在 **exe 同目录**）：存在则默认把数据放在 `<exe 目录>/data`。
pub const PORTABLE_MARKER: &str = "portable.txt";

/// 数据根目录是怎么定下来的（`system.dataDir` 如实上报，设置页据此解释）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataDirSource {
    /// 系统默认位置（`%APPDATA%/<identifier>` 之类）
    Default,
    /// 便携版：exe 同目录下的 `data`
    Portable,
    /// 用户迁移后写入的指针文件
    Pointer,
    /// 环境变量 `GENTLY_DATA_DIR` 显式覆盖（调试 / 绿色部署用）
    Override,
}

/// 数据根目录的元信息：从哪里来、默认在哪里、指针文件应该写到哪。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRootMeta {
    /// 系统默认的数据目录（迁移后仍然需要它：指针文件住在这里）
    pub default_base: PathBuf,
    /// 指针文件所在目录（默认 = `default_base`；便携版 = exe 同目录）
    pub pointer_home: PathBuf,
    pub portable: bool,
    pub source: DataDirSource,
}

impl DataRootMeta {
    /// 纯默认形态：测试与「调用方已经算好根目录」的场景用它。
    pub fn plain(base: &Path) -> Self {
        Self {
            default_base: base.to_path_buf(),
            pointer_home: base.to_path_buf(),
            portable: false,
            source: DataDirSource::Default,
        }
    }

    /// 指针文件路径
    pub fn location_file(&self) -> PathBuf {
        self.pointer_home.join(DATA_LOCATION_FILE)
    }
}

/// 读指针文件里的目标目录；相对路径、缺字段、坏 JSON 一律当「没有指针」。
pub fn read_data_location(pointer_home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(pointer_home.join(DATA_LOCATION_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let raw = value.get("dataDir")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    // 必须是绝对路径：相对路径的含义取决于当前工作目录，重启后可能指向别处
    path.is_absolute().then_some(path)
}

/// 写指针文件（原子替换：先写临时文件再 rename，避免半截 JSON 让应用找不到数据）。
pub fn write_data_location(pointer_home: &Path, target: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(pointer_home)?;
    let file = pointer_home.join(DATA_LOCATION_FILE);
    let temp = pointer_home.join(format!("{DATA_LOCATION_FILE}.tmp"));
    let body = serde_json::json!({
        "dataDir": target.to_string_lossy().replace('\\', "/"),
    });
    std::fs::write(&temp, serde_json::to_vec_pretty(&body)?)?;
    std::fs::rename(&temp, &file)?;
    Ok(file)
}

/// 删掉指针文件（回到默认目录）。没有指针时也算成功。
pub fn clear_data_location(pointer_home: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(pointer_home.join(DATA_LOCATION_FILE)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/**
 * 选出数据根目录并给出完整布局。
 *
 * 优先级（高 → 低）：
 * 1. `GENTLY_DATA_DIR` 环境变量（显式覆盖，调试与绿色部署用）；
 * 2. **指针文件**（用户在设置页迁移过数据 → 记住新位置）；
 * 3. **便携版**：exe 同目录有 `portable.txt` → `<exe 目录>/data`；
 * 4. 系统默认目录。
 *
 * 便携版把指针文件放在 exe 同目录而不是 `%APPDATA%`：便携版本身的意义就是
 * 「不往系统里留东西」，把状态写到用户漫游目录里会自相矛盾。
 */
pub fn resolve_data_paths(
    default_base: &Path,
    exe_dir: Option<&Path>,
    env_override: Option<&str>,
) -> (AppPaths, DataDirSource) {
    let portable = exe_dir.map(|dir| dir.join(PORTABLE_MARKER).is_file()).unwrap_or(false);
    let pointer_home = match (portable, exe_dir) {
        (true, Some(dir)) => dir.to_path_buf(),
        _ => default_base.to_path_buf(),
    };
    let meta_base = DataRootMeta {
        default_base: default_base.to_path_buf(),
        pointer_home: pointer_home.clone(),
        portable,
        source: DataDirSource::Default,
    };

    if let Some(raw) = env_override.map(str::trim).filter(|value| !value.is_empty()) {
        let mut paths = AppPaths::resolve(Path::new(raw));
        paths.meta = DataRootMeta {
            source: DataDirSource::Override,
            ..meta_base
        };
        return (paths, DataDirSource::Override);
    }

    if let Some(target) = read_data_location(&pointer_home) {
        let mut paths = AppPaths::resolve(target);
        paths.meta = DataRootMeta {
            source: DataDirSource::Pointer,
            ..meta_base
        };
        return (paths, DataDirSource::Pointer);
    }

    if portable {
        if let Some(dir) = exe_dir {
            let mut paths = AppPaths::resolve(dir.join("data"));
            paths.meta = DataRootMeta {
                source: DataDirSource::Portable,
                ..meta_base
            };
            return (paths, DataDirSource::Portable);
        }
    }

    let mut paths = AppPaths::resolve(default_base);
    paths.meta = meta_base;
    (paths, DataDirSource::Default)
}

/// 迁移结果（`system.dataDir.move` 的返回体）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirMigration {
    pub target: String,
    pub copied_files: u64,
    pub copied_bytes: u64,
    /// 迁移总是**下次启动**才生效：数据库连接已打开，换根目录不能热切
    pub requires_restart: bool,
    /// 旧目录还在（不删用户数据）：界面要如实提示「确认无误后可自行删除」
    pub source_kept: String,
}

/// 迁移时**不搬**的条目：缓存随时可重建，日志留在原机器上更好排查。
const MIGRATION_SKIP: [&str; 2] = ["cache", "logs"];

/// SQLite 的旁挂文件后缀：连接还开着时它们属于未落盘状态，拷过去反而可能不一致。
///
/// **按后缀判断，不写库名**：R88 的接缝 bug 就是这里写死了 `gently.db-*`，
/// 而宠物库（`pet.db`）会有自己的 `-wal/-shm`——那些会被当成普通文件一起热拷，
/// 结果是「迁移过去了，但最近的数据对不上」。任何 `*.db` 都遵循同一套后缀规则。
const SQLITE_SIDECAR_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];

fn is_sqlite_sidecar(name: &str) -> bool {
    SQLITE_SIDECAR_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/**
 * 把数据目录搬到 `target`，并写好指针文件。
 *
 * 顺序刻意是「先拷、再校验、最后写指针」：
 * - 拷贝失败 → 指针没动，下次启动仍在原目录（用户不会丢数据）；
 * - 拷贝成功但数据库副本校验不过 → 删掉副本、指针不写，如实报错；
 * - 全部成功 → 写指针，返回「重启生效」。
 *
 * **不删除旧目录**：搬运是不可逆操作的反面——多留一份数据，用户确认后再自己删。
 * 数据库副本的校验用 `PRAGMA quick_check`：读的是**拷贝**，不是当前连接。
 */
pub fn migrate_data_dir(current: &AppPaths, target: &Path) -> Fallible<DataDirMigration> {
    let source = normalize(&current.data);
    let destination = normalize(target);

    if destination.as_os_str().is_empty() {
        return Err(CoreError::invalid_argument("目标目录不能为空"));
    }
    if destination == source {
        return Err(CoreError::invalid_argument("目标目录与当前数据目录相同"));
    }
    if destination.starts_with(&source) {
        return Err(CoreError::invalid_argument("目标目录不能位于当前数据目录内部"));
    }
    if source.starts_with(&destination) {
        return Err(CoreError::invalid_argument("目标目录不能是当前数据目录的上级目录"));
    }
    if !destination.is_absolute() {
        return Err(CoreError::invalid_argument("请填写绝对路径（例如 D:/gently-data）"));
    }

    std::fs::create_dir_all(&destination)?;
    // 可写探测：不可写的盘（只读介质 / 权限不足）在拷贝前就说清楚，而不是拷到一半失败
    let probe = destination.join(".gently-write-probe");
    std::fs::write(&probe, b"ok")?;
    let _ = std::fs::remove_file(&probe);

    let mut copied_files = 0u64;
    let mut copied_bytes = 0u64;
    let mut failed: Option<std::io::Error> = None;

    for entry in std::fs::read_dir(&source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();
        if MIGRATION_SKIP.contains(&name_str.as_str()) || is_sqlite_sidecar(&name_str) {
            continue;
        }
        let from = entry.path();
        let to = destination.join(&name);
        match copy_entry(&from, &to, &mut copied_files, &mut copied_bytes) {
            Ok(()) => {}
            Err(err) => {
                failed = Some(err);
                break;
            }
        }
    }

    if let Some(err) = failed {
        // 只清掉这次拷过去的东西：目标是用户指定的目录，可能不是空的，不能整目录删
        for entry in std::fs::read_dir(&destination).into_iter().flatten().flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            if MIGRATION_SKIP.contains(&name_str.as_str()) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
        return Err(CoreError::new(
            crate::contract::ErrorCode::LibraryIoError,
            format!("拷贝数据目录失败（{err}），指针未改动，下次启动仍在原目录"),
        ));
    }

    /* 数据库副本自检：拷的是文件，不是连接，必须证明**每一份**副本都能打开。
       不能只查 `gently.db`：宠物库（`pet.db`，独立引擎、独立库）也在数据目录里，
       R88 之前这里只查一个文件名，等于对宠物数据完全没有保护。 */
    for db_copy in collect_sqlite_files(&destination) {
        if let Err(reason) = verify_sqlite_copy(&db_copy) {
            let _ = std::fs::remove_file(&db_copy);
            return Err(CoreError::new(
                crate::contract::ErrorCode::LibraryIoError,
                format!(
                    "数据目录副本校验失败（{}：{reason}），指针未改动",
                    db_copy.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()
                ),
            ));
        }
    }

    let pointer = write_data_location(&current.meta.pointer_home, &destination)?;

    tracing::info!(
        target = %destination.display(),
        pointer = %pointer.display(),
        copied_files,
        copied_bytes,
        "数据目录已迁移（下次启动生效）"
    );

    Ok(DataDirMigration {
        target: destination.to_string_lossy().replace('\\', "/"),
        copied_files,
        copied_bytes,
        requires_restart: true,
        source_kept: source.to_string_lossy().replace('\\', "/"),
    })
}

/** 递归拷贝一个条目，累计文件数与字节数（符号链接按原样跳过，避免把外面的东西拖进来）。 */
fn copy_entry(from: &Path, to: &Path, files: &mut u64, bytes: &mut u64) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            /* 旁挂文件规则要**递归生效**：宠物库在子目录里（`pet/pet.db-wal`），
               只在顶层过滤会让它被热拷过去（R88 的接缝就是这一层漏的）。 */
            if is_sqlite_sidecar(&entry.file_name().to_string_lossy()) {
                continue;
            }
            copy_entry(&entry.path(), &to.join(entry.file_name()), files, bytes)?;
        }
        return Ok(());
    }
    if to.exists() {
        std::fs::remove_file(to)?;
    }
    std::fs::copy(from, to)?;
    *files += 1;
    *bytes += meta.len();
    Ok(())
}

/** 递归找出一份目录里所有 SQLite 文件（`*.db`）：迁移后逐一自检。 */
fn collect_sqlite_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(collect_sqlite_files(&path));
            continue;
        }
        let is_db = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("db"))
            .unwrap_or(false);
        if is_db {
            out.push(path);
        }
    }
    out
}

/** 用只读连接跑一次 `PRAGMA quick_check`：证明拷贝出来的库是完整可读的。 */
fn verify_sqlite_copy(path: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|err| err.to_string())?;
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(result)
    }
}

/// **源文件路径的稳定字符串形式**（本地曲目 id、曲库里的 `path` 列、封面缓存文件名共用同一个）。
///
/// 规则：`\` → `/`，折叠重复分隔符，去掉末尾分隔符。
///
/// 为什么必须归一：Windows 接受 `C:\\Music\\a.mp3` 这种重复分隔符的写法，用户粘贴目录时很容易带上。
/// 不归一就会把**同一个文件**按两种拼法收进曲库两次（打包版实测真的出现了两行），
/// 而且扫描侧（文件系统路径，单个 `\`）与列表侧（库里的路径）算出的封面哈希也会对不上。
///
/// 不做 `..`/`.` 解析：那要 `canonicalize`，会引入 `\\?\` 前缀并让已有曲库的 id 全部失效——
/// 收益只是多认一种写法，不值得。
pub fn normalize_source_path(path: &Path) -> String {
    normalize_source_path_str(&path.to_string_lossy())
}

/// [`normalize_source_path`] 的字符串版（库里存的是字符串，清理时要按同一份规则比较）。
pub fn normalize_source_path_str(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.replace('\\', "/").chars() {
        if ch == '/' {
            if !out.ends_with('/') {
                out.push('/');
            }
        } else {
            out.push(ch);
        }
    }
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// `<appData>/gently/` 下的全部路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub data: PathBuf,
    /// 可随时整目录删除的缓存（榜单/歌词/封面）
    pub cache: PathBuf,
    pub plugins: PathBuf,
    /// 订阅索引缓存（断网可用）
    pub subscriptions: PathBuf,
    pub skins: PathBuf,
    pub downloads: PathBuf,
    pub logs: PathBuf,
    /// SQLite 文件
    pub db: PathBuf,
    /// 根目录的来源与指针位置（`system.dataDir` 用它解释「数据现在放在哪、为什么」）
    pub meta: DataRootMeta,
}

impl AppPaths {
    /// 由数据根目录推导全部子路径（元信息按「系统默认位置」填充，调用方可以再覆盖）。
    pub fn resolve(base: impl AsRef<Path>) -> Self {
        let data = base.as_ref().to_path_buf();
        let meta = DataRootMeta::plain(&data);
        Self {
            cache: data.join("cache"),
            plugins: data.join("plugins"),
            subscriptions: data.join("subscriptions"),
            skins: data.join("skins"),
            downloads: data.join("downloads"),
            logs: data.join("logs"),
            db: data.join("gently.db"),
            data,
            meta,
        }
    }

    /// 建目录（幂等）。启动时调用一次，失败不应阻塞应用——
    /// 由调用方决定降级策略（见 `src-tauri` 的启动流程）。
    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [
            &self.data,
            &self.cache,
            &self.plugins,
            &self.subscriptions,
            &self.skins,
            &self.downloads,
            &self.logs,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    /// 全部受管目录（用于 `system.reveal` 的白名单校验：不允许前端传任意路径）。
    pub fn managed_roots(&self) -> [&Path; 7] {
        [
            &self.data,
            &self.cache,
            &self.plugins,
            &self.subscriptions,
            &self.skins,
            &self.downloads,
            &self.logs,
        ]
    }

    /// 路径是否位于某个受管目录内（含等于本身）。
    pub fn is_managed(&self, candidate: &Path) -> bool {
        let normalized = normalize(candidate);
        self.managed_roots()
            .iter()
            .any(|root| normalized.starts_with(normalize(root)))
    }

    /// 输出给前端的字符串形式（统一为正斜杠，避免 Windows 反斜杠在 JSON 里被转义）。
    pub fn to_dto(&self) -> SystemPaths {
        let s = |p: &PathBuf| p.to_string_lossy().replace('\\', "/");
        SystemPaths {
            data: s(&self.data),
            cache: s(&self.cache),
            plugins: s(&self.plugins),
            subscriptions: s(&self.subscriptions),
            skins: s(&self.skins),
            downloads: s(&self.downloads),
            logs: s(&self.logs),
        }
    }
}

/// 尽力规范化：去掉 `.`/`..` 段（不触碰文件系统，路径可能还不存在）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_expected_layout() {
        let p = AppPaths::resolve("/tmp/gently");
        assert_eq!(p.db, PathBuf::from("/tmp/gently/gently.db"));
        assert_eq!(p.subscriptions, PathBuf::from("/tmp/gently/subscriptions"));
    }

    #[test]
    fn managed_check_rejects_outside_paths() {
        let p = AppPaths::resolve("/tmp/gently");
        assert!(p.is_managed(Path::new("/tmp/gently/logs/app.log")));
        assert!(p.is_managed(Path::new("/tmp/gently")));
        // 越权路径必须被拒（前端可能传任意字符串）
        assert!(!p.is_managed(Path::new("/tmp/other/file")));
        assert!(!p.is_managed(Path::new("/etc/passwd")));
        // 用 .. 逃逸也要被拒
        assert!(!p.is_managed(Path::new("/tmp/gently/../other")));
    }
}
