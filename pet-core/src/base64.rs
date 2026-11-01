//! 极小的 base64 解码（只解码，不编码）。
//!
//! 为什么自己写：M2 的图集从 WebView 传进来用 base64 是最省事的方式（Tauri 命令参数是 JSON），
//! 而为一个 20 行的解码引入一个依赖不划算（AGENTS 红线：不引入重量级依赖）。
//! 只支持标准字母表与 `=` 填充，遇到非法字符直接报错——**不猜**。

use crate::error::{PetError, PetResult};

/// 标准 base64 字符 → 6 位值
fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 解码 base64；空白字符被忽略（用户可能从文本编辑器里粘过来）。
pub fn decode(input: &str) -> PetResult<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for byte in input.bytes() {
        if byte.is_ascii_whitespace() || byte == b'=' {
            continue;
        }
        let Some(value) = sextet(byte) else {
            return Err(PetError::invalid_package(format!(
                "base64 里有非法字符：{}",
                byte as char
            )));
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }

    if out.is_empty() && !input.trim().is_empty() {
        return Err(PetError::invalid_package("base64 解码结果为空"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_known_strings() {
        assert_eq!(decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode("UE5H").unwrap(), b"PNG");
        // 允许换行与空格（用户从文本里粘贴）
        assert_eq!(decode("aGVs\n bG8=").unwrap(), b"hello");
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode("not*base64").is_err());
        assert!(decode("!!!!").is_err());
    }
}
