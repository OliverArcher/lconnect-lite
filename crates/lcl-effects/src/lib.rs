//! 灯效渲染：在主机上把效果算成逐帧的 RGB，再交给设备层压缩下发（设备没有内置效果）。
//!
//! 除本文件外，`tl/`（UNI FAN TL，28 种效果）、`h2/`（隐流二代冷头灯圈，11 种效果）、
//! `effects/`、`color.rs`、`animation.rs`、`types.rs` 均移植自 lian-li-linux
//! `crates/lianli-media/src/rgb` 与 `crates/lianli-shared/src/rgb.rs`（MIT，见 THIRD_PARTY_NOTICES.md），
//! 只改了模块路径；其中不少效果与官方软件的输出做过逐帧哈希比对。

pub mod animation;
// 共享的颜色/效果模块原本还服务其他产品线（SL、Strimer 等），这里只用到其中一部分。
#[allow(dead_code)]
mod color;
#[allow(dead_code)]
mod effects;
pub mod h2;
pub mod ring88;
pub mod tl;
pub mod types;

pub use animation::{Animation, SecondaryTiming};
pub use ring88::{render as render_ring88, supported_parameters as ring88_parameters};
pub use types::{RgbDirection, RgbEffect, RgbMode, RgbScope};
