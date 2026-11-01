//! 语义化版本（`major.minor.patch`）：宠物包声明的 `minPetCoreVersion` 要**真的能比较**。
//!
//! 为什么自己写（而不是加个依赖）：需要的只有「解析 + 比较」，
//! 引入 `semver` 一份 crate 只为了三元组排序不划算（`AGENTS.md`：不引入重量级依赖）。
//!
//! 允许的写法：`1.0`、`1.0.0`、`v1.2.3`、`1.2.3-rc1`、`1.2.3+build`；
//! 缺的段按 0 补齐（`1` = `1.0.0`），预发布/构建后缀**只解析不参与比较**
//! （宠物包的兼容判断不需要预发布排序语义）。

use std::cmp::Ordering;
use std::fmt;

/// 一个 `major.minor.patch` 版本号。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    /// 解析版本字符串；不合法返回 `None`（调用方转成可读的包错误）。
    ///
    /// 段数 1~3 都收（`1` → `1.0.0`），支持 `v` 前缀与 `-` / `+` 后缀；
    /// 数字段必须是纯数字（不接受 `+3` / `-3` / `0x3` / 空段）。
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
        /* 预发布与构建元数据：截掉，不参与比较 */
        let core = text.split(['-', '+']).next().unwrap_or("").trim();
        if core.is_empty() {
            return None;
        }
        let mut segments = core.split('.');
        let major = parse_segment(segments.next()?)?;
        let minor = match segments.next() {
            Some(segment) => parse_segment(segment)?,
            None => 0,
        };
        let patch = match segments.next() {
            Some(segment) => parse_segment(segment)?,
            None => 0,
        };
        /* 四段以上（`1.2.3.4`）不是语义化版本：宁可报错，也别按自己的想象排序 */
        if segments.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch })
    }

    /// 当前宠物核心的版本（`Cargo.toml` 里的 `version`）。
    pub fn current() -> Option<Self> {
        Self::parse(crate::PET_CORE_VERSION)
    }

    /// 是否满足「至少 `min`」的要求（宠物要的核心版本不能比本机新）。
    pub fn satisfies(&self, minimum: Self) -> bool {
        *self >= minimum
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

fn parse_segment(segment: &str) -> Option<u32> {
    if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    segment.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn parses_three_segments_and_short_forms() {
        assert_eq!(Version::parse("1.2.3"), Some(Version { major: 1, minor: 2, patch: 3 }));
        assert_eq!(Version::parse("1.2"), Some(Version { major: 1, minor: 2, patch: 0 }));
        assert_eq!(Version::parse("2"), Some(Version { major: 2, minor: 0, patch: 0 }));
        assert_eq!(Version::parse(" v1.0.0 "), Some(Version { major: 1, minor: 0, patch: 0 }));
    }

    #[test]
    fn prerelease_and_build_suffixes_are_ignored_when_comparing() {
        let release = Version::parse("1.2.3").unwrap();
        assert_eq!(Version::parse("1.2.3-rc1"), Some(release));
        assert_eq!(Version::parse("1.2.3+build.7"), Some(release));
    }

    #[test]
    fn rejects_nonsense() {
        for text in ["", " ", "1.2.3.4", "1..3", "a.b.c", "1.-2", "1.2.x", "1.2.3 "] {
            if text == "1.2.3 " {
                /* 尾部空白会被 trim 掉，属于合法输入 */
                assert!(Version::parse(text).is_some());
                continue;
            }
            assert!(Version::parse(text).is_none(), "{text} 不该被当成版本号");
        }
    }

    #[test]
    fn ordering_is_numeric_per_segment() {
        let v = |text: &str| Version::parse(text).unwrap();
        assert!(v("1.10.0") > v("1.9.9"), "小版本要按数字比，不是按字符串");
        assert!(v("2.0.0") > v("1.99.99"));
        assert!(v("1.0.1") > v("1.0.0"));
        assert!(v("1.0.0").satisfies(v("0.9.9")));
        assert!(!v("0.9.9").satisfies(v("1.0.0")));
    }

    #[test]
    fn the_crate_version_parses() {
        assert!(Version::current().is_some(), "PET_CORE_VERSION 必须是语义化版本");
    }
}
