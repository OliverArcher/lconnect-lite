//! 后台服务（lcl-daemon）和 GUI（app）共用的类型：配置文件、状态快照、命名管道协议。

pub mod config;
pub mod group_control;
#[cfg(feature = "nvml")]
pub mod gpu;
pub mod ipc;
pub mod presets;
pub mod sensors;
pub mod status;

pub use config::{Config, CoolingMode, Curve, FanOverride, Lcd, LcdMode, TempSource, ThemeMode};

/// 标准 base64（带补齐），给屏幕预览用；数据量小，不值得为它加依赖。
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (input, want) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foobar", "Zm9vYmFy")] {
            assert_eq!(super::base64(input.as_bytes()), want);
        }
    }
}
pub use ipc::{Request, Response};
pub use status::{DeviceInfo, FanGroup, Status, WirelessDevice};

/// "aa:bb:cc:dd:ee:ff" → 6 字节。
pub fn parse_mac(text: &str) -> Option<[u8; 6]> {
    let parts: Vec<u8> = text.split(':').map(|p| u8::from_str_radix(p, 16)).collect::<Result<_, _>>().ok()?;
    parts.try_into().ok()
}
