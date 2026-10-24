//! 8.8 灯环（USB VID 0x0416 / PID 0x8050）的灯效数据通道。
//!
//! 协议来自官方 `lianli.lcd207` 的 `LEDController.SetEffect` 与 `WinUsbLed`（反编译参考）：
//! 一帧 180 字节（60 颗 LED × R,G,B），拆成 3 个 64 字节的 USB 包依次写出，包首字节是命令号 17。
//! 设备没有内置效果引擎，主机必须自己算好每一帧并持续下发。
//!
//! 边界（有意为之）：
//! - 只认 0x0416:0x8050。这个 PID 和 LP 冷头（0x1CBE:0xA088）不是同一个设备，
//!   本模块永远不会去开 LP 的显示接口，也从不发显示/复位类命令，只写灯效数据包。
//! - 官方写灯效包时用 `isRead: false`，设备不回包；这里同样只写不读。
//! - 颜色字节序（R,G,B 还是 G,R,B）在反编译代码里看不出结论，也没在真机上验证过，
//!   默认按 R,G,B 写；`LedChannelOrder` 留了切换的口子，方便真机 bring-up 时改一处即可。
//!
//! 未验证项：包的字节序、真机上的推送节奏、帧间隔的合适取值，都需要在硬件上实测。

use crate::usb::UsbDev;
use anyhow::{ensure, Context, Result};
use std::time::{Duration, Instant};

/// 8.8 灯环的 USB 标识（VID, PID）。
pub const RING88_ID: (u16, u16) = (0x0416, 0x8050);
/// Read-only identification of the paired 8.8 display interface; never open it here.
pub const UNIVERSAL_SCREEN_88_ID: (u16,u16) = (0x1CBE,0xA088);
/// 打开设备时用的候选列表。
pub const RING88_IDS: [(u16, u16); 1] = [RING88_ID];

/// 灯环 LED 数量。
pub const LED_COUNT: usize = 60;
/// 一帧的原始颜色字节数：60 × RGB。
pub const FRAME_BYTES: usize = LED_COUNT * 3;
/// 一个 USB 包的大小。
pub const PACKET_BYTES: usize = 64;
/// 包头占 4 字节，每包带 20 颗 LED。
pub const LEDS_PER_PACKET: usize = 20;
/// 一帧拆成几个包。
pub const PACKET_COUNT: usize = FRAME_BYTES / (LEDS_PER_PACKET * 3);
/// 灯效数据命令：官方 `sendData[0] = 17`。
pub const CMD_LED_DATA: u8 = 0x11;

/// 写单个包的超时。官方是同步写完就返回，给 200 ms 余量。
const WRITE_TIMEOUT: Duration = Duration::from_millis(200);
/// 一个设备时钟 tick 是 0.625 ms。
pub const TICK_MS: f32 = 0.625;

/// 把「百分之一 tick」换算成时长。
///
/// `lcl_effects::Animation::interval_hundredths` 用的就是这个单位：
/// 100 = 1 tick = 0.625 ms。
pub fn duration_from_hundredths(hundredths: u32) -> Duration {
    Duration::from_secs_f32(hundredths as f32 * TICK_MS / 100.0 / 1000.0)
}

/// 把「百分之一 tick」换算成整 tick（向上取整，至少 1）。
///
/// 给 `push_animation` 这类以 tick 为单位的接口用。
pub fn ticks_from_hundredths(hundredths: u32) -> u16 {
    let ticks = hundredths.div_ceil(100);
    u16::try_from(ticks).unwrap_or(u16::MAX).max(1)
}

/// 每颗 LED 三个颜色通道在包里的排列顺序。
///
/// 真机未验证：官方把渲染好的颜色字节整段拷进包里，看不出是 RGB 还是 GRB。
/// 默认 `Rgb`，若实测发现红绿互换就切到 `Grb`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LedChannelOrder {
    #[default]
    Rgb,
    Grb,
}

/// 8.8 灯环的句柄。
pub struct Ring88 {
    usb: UsbDev,
    order: LedChannelOrder,
}

impl Ring88 {
    /// 打开第一个匹配 0x0416:0x8050 的设备；设备没插时返回 `Ok(None)`。
    ///
    /// 只认这一个 PID，不会误开 LP 冷头（0x1CBE:0xA088）。
    pub fn open() -> Result<Option<Self>> {
        let Some(usb) = UsbDev::open_any(&RING88_IDS, "8.8 灯环")? else {
            return Ok(None);
        };
        ensure!(
            usb.vid == RING88_ID.0 && usb.pid == RING88_ID.1,
            "打开的不是 8.8 灯环：{:04X}:{:04X}",
            usb.vid,
            usb.pid
        );
        Ok(Some(Self {
            usb,
            order: LedChannelOrder::default(),
        }))
    }

    /// 切换颜色字节序（默认 R,G,B；真机验证后可能要改成 G,R,B）。
    pub fn set_channel_order(&mut self, order: LedChannelOrder) {
        self.order = order;
    }

    /// 当前使用的颜色字节序。
    pub fn channel_order(&self) -> LedChannelOrder {
        self.order
    }

    /// 丢掉输入端管道里残留的数据。官方写灯效包时不读，长期只写不读时可以清一次。
    pub fn flush_input(&self) {
        self.usb.flush();
    }

    /// 推一帧：60 颗 LED 的颜色，拆成 3 个 64 字节包依次写出。
    ///
    /// 设备不回包，所以这里只管写成功与否。
    pub fn push_frame(&mut self, frame: &[[u8; 3]; LED_COUNT]) -> Result<()> {
        let packets = encode_frame(frame, self.order);
        for (index, packet) in packets.iter().enumerate() {
            self.usb
                .write(packet, WRITE_TIMEOUT)
                .with_context(|| format!("写 8.8 灯环第 {} 包", index))?;
        }
        Ok(())
    }

    /// 推一整段动画并按 `interval_ticks` 控制帧率（1 tick = 0.625 ms）。
    ///
    /// 官方是循环播放的：这里只推一遍，循环由调用方（守护进程的独立线程）负责。
    /// 长动画建议直接用 `push_frame` 逐帧推，那样才能随时换配置或响应停止。
    pub fn push_animation(&mut self, frames: &[Vec<[u8; 3]>], interval_ticks: u16) -> Result<()> {
        ensure!(!frames.is_empty(), "灯效至少一帧");
        ensure!(interval_ticks > 0, "帧间隔至少 1 tick");
        let period = duration_from_hundredths(u32::from(interval_ticks) * 100);
        for frame in frames {
            ensure!(
                frame.len() == LED_COUNT,
                "每帧须有 {LED_COUNT} 颗 LED，实际 {}",
                frame.len()
            );
            let fixed: &[[u8; 3]; LED_COUNT] = frame
                .as_slice()
                .try_into()
                .map_err(|_| anyhow::anyhow!("每帧须有 {LED_COUNT} 颗 LED"))?;
            let started = Instant::now();
            self.push_frame(fixed)?;
            let spent = started.elapsed();
            if let Some(rest) = period.checked_sub(spent) {
                std::thread::sleep(rest);
            }
        }
        Ok(())
    }
}

/// 把一帧 60 颗 LED 的颜色编成 3 个 64 字节的包。
///
/// 布局（照抄官方 `LEDController.SetEffect`）：
/// - `[0]` = 17（灯效数据命令）
/// - `[1]` = 本包第一颗 LED 的序号，依次 0 / 20 / 40
/// - `[2..4]` = 0
/// - `[4..64]` = 20 颗 LED 的颜色，每颗 3 字节
pub fn encode_frame(
    frame: &[[u8; 3]; LED_COUNT],
    order: LedChannelOrder,
) -> [[u8; PACKET_BYTES]; PACKET_COUNT] {
    let mut packets = [[0u8; PACKET_BYTES]; PACKET_COUNT];
    for (index, packet) in packets.iter_mut().enumerate() {
        packet[0] = CMD_LED_DATA;
        packet[1] = (index * LEDS_PER_PACKET) as u8;
        let first = index * LEDS_PER_PACKET;
        for led in 0..LEDS_PER_PACKET {
            let [r, g, b] = frame[first + led];
            let at = 4 + led * 3;
            match order {
                LedChannelOrder::Rgb => {
                    packet[at] = r;
                    packet[at + 1] = g;
                    packet[at + 2] = b;
                }
                LedChannelOrder::Grb => {
                    packet[at] = g;
                    packet[at + 1] = r;
                    packet[at + 2] = b;
                }
            }
        }
    }
    packets
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(seed: u8) -> [[u8; 3]; LED_COUNT] {
        core::array::from_fn(|n| [(n as u8).wrapping_add(seed), (n as u8).wrapping_add(1), 0xA5])
    }

    #[test]
    fn constants_describe_one_frame() {
        assert_eq!(LED_COUNT, 60);
        assert_eq!(FRAME_BYTES, 180);
        assert_eq!(PACKET_COUNT, 3);
        assert_eq!(PACKET_COUNT * (PACKET_BYTES - 4), FRAME_BYTES);
        assert_eq!(PACKET_COUNT * LEDS_PER_PACKET, LED_COUNT);
        assert_eq!(RING88_ID, (0x0416, 0x8050));
        // 和 LP 冷头（0x1CBE:0xA088）是两个完全不同的 PID。
        assert_ne!(RING88_ID.1, 0xA088);
    }

    #[test]
    fn packet_header_matches_the_vendor_layout() {
        let packets = encode_frame(&frame_of(0), LedChannelOrder::Rgb);
        for (index, packet) in packets.iter().enumerate() {
            assert_eq!(packet[0], 17);
            assert_eq!(packet[1] as usize, index * LEDS_PER_PACKET);
            assert_eq!(&packet[2..4], &[0, 0]);
        }
    }

    #[test]
    fn every_led_lands_in_the_right_packet() {
        let frame = frame_of(0);
        let packets = encode_frame(&frame, LedChannelOrder::Rgb);
        for (index, packet) in packets.iter().enumerate() {
            let first = index * LEDS_PER_PACKET;
            for led in 0..LEDS_PER_PACKET {
                let at = 4 + led * 3;
                assert_eq!(&packet[at..at + 3], &frame[first + led]);
            }
        }
    }

    #[test]
    fn channel_order_swap_only_touches_red_and_green() {
        let frame = frame_of(3);
        let rgb = encode_frame(&frame, LedChannelOrder::Rgb);
        let grb = encode_frame(&frame, LedChannelOrder::Grb);
        for (a, b) in rgb.iter().zip(grb.iter()) {
            assert_eq!(a[0], b[0]);
            assert_eq!(a[1], b[1]);
            assert_eq!(a[2], b[2]);
            assert_eq!(a[4], b[5]);
            assert_eq!(a[5], b[4]);
        }
    }

    #[test]
    fn a_frame_carries_exactly_180_color_bytes() {
        let packets = encode_frame(&frame_of(0), LedChannelOrder::Rgb);
        let color_bytes: usize = packets.iter().map(|p| p.len() - 4).sum();
        assert_eq!(color_bytes, FRAME_BYTES);
    }

    #[test]
    fn hundredths_of_a_tick_match_the_project_unit() {
        // 100 = 1 tick = 0.625 ms。
        assert_eq!(duration_from_hundredths(100), Duration::from_micros(625));
        assert_eq!(duration_from_hundredths(4_000), Duration::from_millis(25));
        assert_eq!(ticks_from_hundredths(4_000), 40);
        // 不足一个 tick 时向上取整，至少 1 tick。
        assert_eq!(ticks_from_hundredths(1), 1);
        assert_eq!(ticks_from_hundredths(101), 2);
    }
}
