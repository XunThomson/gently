//! 图集文件的**校验和**（FNV-1a 64），用来发现「素材被改坏 / 搬错文件」。
//!
//! 为什么不是 SHA-256：这里只需要「同一个文件两次读到的是不是同一份」，
//! 而 crate 不引依赖（`pet-core` 只带 serde / rusqlite）。
//! 一个 10 行的 FNV-1a 足以发现截断、换文件、文本编辑器误存这类事故；
//! 它**不是**密码学哈希，不能用于安全校验（也不需要：文件在用户自己的数据目录里）。

/// 计算校验和并转成 16 位十六进制（稳定、可比较）
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::fingerprint;

    #[test]
    fn same_bytes_same_fingerprint() {
        assert_eq!(fingerprint(b"hello"), fingerprint(b"hello"));
        assert_eq!(fingerprint(b"hello").len(), 16);
    }

    #[test]
    fn one_byte_change_is_detected() {
        assert_ne!(fingerprint(b"hello"), fingerprint(b"hellp"));
        assert_ne!(fingerprint(b""), fingerprint(b"\0"));
    }
}
