//! 隐流二代（HydroShift II LCD）冷头与 L-Wireless 无线设备的 USB 协议层。
//! 协议逻辑移植自 lian-li-linux（MIT），见仓库根目录 THIRD_PARTY_NOTICES.md。

pub mod h2;
pub mod ring88;
pub mod rgb;
pub mod tinyuz;
pub mod usb;
pub mod wireless;

pub use ring88::{LedChannelOrder, Ring88, RING88_ID, RING88_IDS};
