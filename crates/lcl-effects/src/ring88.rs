//! 8.8 灯环（60 颗 LED）的灯效渲染。
//!
//! 设备本身没有效果引擎，主机把每一帧算好再逐帧推下去（见 `lcl-devices` 的 `ring88`）。
//! 这里只实现经过推敲的 6 种：熄灯、静态、彩虹、呼吸、波浪、彩虹渐变；
//! 其余模式一律报 `unsupported`，不假装支持官方那 19 种。
//!
//! 与官方实现的差异（有意为之）：
//! - 官方在设备侧循环播放自己生成的帧，这里按“主机算好、守护线程推帧”的模型出 `Animation`。
//! - 各效果的节奏、配色都是本模块自己定的，跟官方逐帧比对过的是否一致尚未验证。

use crate::animation::Animation;
use crate::types::{
    is_brightness_off, RgbDirection, RgbEffect, RgbEffectParameters, RgbMode, RgbScope,
};
use anyhow::{bail, ensure, Result};

/// 灯环 LED 数量。
pub const LED_COUNT: usize = 60;

/// 本模块支持的模式，按界面顺序排列。
pub const MODES: &[RgbMode] = &[
    RgbMode::Off,
    RgbMode::Static,
    RgbMode::Rainbow,
    RgbMode::Breathing,
    RgbMode::Wave,
    RgbMode::RainbowMorph,
];

/// 各个效果的基准帧间隔，单位是 0.625 ms 的设备 tick。
/// 与 `MODES` 一一对应：Off / Static / Rainbow / Breathing / Wave / RainbowMorph。
/// 实际帧间隔还要乘速度档的倍率。
const BASE_INTERVAL_TICKS: [u32; 6] = [100, 100, 8, 6, 8, 8];

/// 速度档对应的倍率。
const SPEED_FACTOR: [u32; 5] = [7, 6, 5, 4, 3];

/// 各模式可调参数（供界面/配置校验用）。
///
/// 颜色上限沿用项目范围：最多 4 色，这里只有静态/呼吸/波浪用到单色。
/// 方向只有彩虹、波浪、彩虹渐变有意义，且只支持顺/逆时针。
pub fn supported_parameters() -> Vec<RgbEffectParameters> {
    MODES
        .iter()
        .map(|&mode| {
            let max_colors = match mode {
                RgbMode::Static | RgbMode::Breathing | RgbMode::Wave => 1,
                _ => 0,
            };
            RgbEffectParameters {
                mode,
                min_colors: u8::from(max_colors > 0),
                max_colors,
                per_fan_colors: false,
                directions: if matches!(
                    mode,
                    RgbMode::Rainbow | RgbMode::Wave | RgbMode::RainbowMorph
                ) {
                    vec![RgbDirection::Clockwise, RgbDirection::CounterClockwise]
                } else {
                    vec![]
                },
                supports_speed: !matches!(mode, RgbMode::Off | RgbMode::Static),
            }
        })
        .collect()
}

/// 渲染一段动画。`effect` 里的模式必须在本模块支持的列表内。
pub fn render(effect: &RgbEffect) -> Result<Animation> {
    ensure!(
        effect.scope == RgbScope::All,
        "8.8 灯环只支持整圈（All）"
    );
    ensure!(
        effect.colors.len() <= 4,
        "8.8 灯环调色板最多四种颜色"
    );
    ensure!(
        effect.brightness <= 4 || is_brightness_off(effect.brightness),
        "invalid RGB brightness"
    );
    ensure!(effect.speed <= 4, "RGB speed must be 0..=4");
    ensure!(
        MODES.contains(&effect.mode),
        "unsupported 8.8 ring RGB mode: {:?}",
        effect.mode
    );

    let brightness = brightness_level(effect.brightness);
    let reverse = direction_sign(effect.direction, effect.mode)?;
    let color = effect.colors.first().copied().unwrap_or([255, 255, 255]);
    let base = BASE_INTERVAL_TICKS[MODES.iter().position(|&m| m == effect.mode).unwrap_or(0)];

    let frames = if effect.disabled || is_brightness_off(effect.brightness) {
        vec![vec![[0u8; 3]; LED_COUNT]]
    } else {
        match effect.mode {
            RgbMode::Off => vec![vec![[0u8; 3]; LED_COUNT]],
            RgbMode::Static => vec![vec![scale(color, brightness); LED_COUNT]],
            RgbMode::Rainbow => rainbow(brightness, reverse),
            RgbMode::Breathing => breathing(color, brightness),
            RgbMode::Wave => wave(color, brightness, reverse),
            RgbMode::RainbowMorph => rainbow_morph(brightness),
            other => bail!("unsupported 8.8 ring RGB mode: {other:?}"),
        }
    };

    Ok(Animation {
        frames,
        interval_hundredths: base * SPEED_FACTOR[effect.speed as usize] * 100,
        secondary: None,
    })
}

/// 帧间隔的 tick 数（1 tick = 0.625 ms）。
///
/// `Animation::interval_hundredths` 是百分之一 tick，这个函数换算成整 tick，
/// 给 `lcl_devices::ring88::push_animation` 这类以 tick 为单位的接口用。
pub fn interval_ticks(animation: &Animation) -> u16 {
    let ticks = animation.interval_hundredths.div_ceil(100);
    u16::try_from(ticks).unwrap_or(u16::MAX).max(1)
}

/// 亮度档 0-4 映射到 0-255；`BRIGHTNESS_OFF` 已经在上面变成熄灯。
fn brightness_level(brightness: u8) -> u8 {
    if is_brightness_off(brightness) {
        0
    } else {
        [0, 64, 128, 192, 255][(brightness.min(4)) as usize]
    }
}

/// 方向只有顺/逆时针有意义，返回 +1 / -1。
fn direction_sign(direction: RgbDirection, mode: RgbMode) -> Result<i32> {
    match direction {
        RgbDirection::Clockwise => Ok(1),
        RgbDirection::CounterClockwise => Ok(-1),
        other => {
            if matches!(mode, RgbMode::Rainbow | RgbMode::Wave | RgbMode::RainbowMorph) {
                bail!("8.8 灯环只支持顺/逆时针方向: {other:?}")
            } else {
                Ok(1)
            }
        }
    }
}

/// 颜色乘亮度（0-255 → 0-255）。
fn scale(color: [u8; 3], brightness: u8) -> [u8; 3] {
    [
        (u16::from(color[0]) * u16::from(brightness) / 255) as u8,
        (u16::from(color[1]) * u16::from(brightness) / 255) as u8,
        (u16::from(color[2]) * u16::from(brightness) / 255) as u8,
    ]
}

/// 色相（0-360）转 RGB，饱和度与明度都是 0-1。
fn hue_to_rgb(hue: f32, value: f32) -> [u8; 3] {
    let sector = hue / 60.0;
    let x = (1.0 - ((sector % 2.0) - 1.0).abs()) * value;
    let (r, g, b) = match sector as u32 {
        0 => (value, x, 0.0),
        1 => (x, value, 0.0),
        2 => (0.0, value, x),
        3 => (0.0, x, value),
        4 => (x, 0.0, value),
        _ => (value, 0.0, x),
    };
    [
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    ]
}

/// 彩虹：色相沿灯环均匀铺开，每帧整体前进一步。
fn rainbow(brightness: u8, reverse: i32) -> Vec<Vec<[u8; 3]>> {
    let value = f32::from(brightness) / 255.0;
    (0..LED_COUNT)
        .map(|frame| {
            (0..LED_COUNT)
                .map(|led| {
                    let phase = (frame as i32 + led as i32 * reverse).rem_euclid(LED_COUNT as i32);
                    hue_to_rgb(phase as f32 / LED_COUNT as f32 * 360.0, value)
                })
                .collect()
        })
        .collect()
}

/// 呼吸：亮度在 0-1 之间来回摆。
fn breathing(color: [u8; 3], brightness: u8) -> Vec<Vec<[u8; 3]>> {
    const FRAMES: usize = 100;
    (0..FRAMES)
        .map(|frame| {
            let phase = frame as f32 / FRAMES as f32 * std::f32::consts::TAU;
            let wave = (1.0 - phase.cos()) / 2.0;
            let level = (wave * f32::from(brightness)).round() as u8;
            vec![scale(color, level); LED_COUNT]
        })
        .collect()
}

/// 波浪：一道亮带沿灯环跑。
fn wave(color: [u8; 3], brightness: u8, reverse: i32) -> Vec<Vec<[u8; 3]>> {
    (0..LED_COUNT)
        .map(|frame| {
            (0..LED_COUNT)
                .map(|led| {
                    let phase = (led as i32 * reverse - frame as i32).rem_euclid(LED_COUNT as i32);
                    let wave = (1.0
                        - (phase as f32 / LED_COUNT as f32 * std::f32::consts::TAU).cos())
                        / 2.0;
                    let level = (wave * f32::from(brightness)).round() as u8;
                    scale(color, level)
                })
                .collect()
        })
        .collect()
}

/// 彩虹渐变：整圈同时做色相渐变。
fn rainbow_morph(brightness: u8) -> Vec<Vec<[u8; 3]>> {
    let value = f32::from(brightness) / 255.0;
    (0..LED_COUNT)
        .map(|frame| {
            let hue = frame as f32 / LED_COUNT as f32 * 360.0;
            vec![hue_to_rgb(hue, value); LED_COUNT]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effect(mode: RgbMode) -> RgbEffect {
        RgbEffect {
            mode,
            colors: vec![[255, 0, 0]],
            brightness: 4,
            speed: 2,
            ..RgbEffect::default()
        }
    }

    #[test]
    fn every_supported_mode_renders_full_frames() {
        for &mode in MODES {
            let animation = render(&effect(mode)).unwrap();
            assert!(!animation.frames.is_empty(), "{mode:?}");
            for frame in &animation.frames {
                assert_eq!(frame.len(), LED_COUNT, "{mode:?}");
                for led in frame {
                    assert_eq!(led.len(), 3);
                }
            }
        }
    }

    #[test]
    fn unsupported_modes_are_reported_not_faked() {
        for mode in [
            RgbMode::Meteor,
            RgbMode::Tide,
            RgbMode::Kaleidoscope,
            RgbMode::Direct,
        ] {
            let error = render(&effect(mode)).unwrap_err().to_string();
            assert!(error.contains("unsupported"), "{mode:?}: {error}");
        }
    }

    #[test]
    fn off_and_disabled_produce_black_frames() {
        let animation = render(&effect(RgbMode::Off)).unwrap();
        assert_eq!(animation.frames.len(), 1);
        assert!(animation.frames[0].iter().all(|led| *led == [0; 3]));

        let mut disabled = effect(RgbMode::Static);
        disabled.disabled = true;
        let animation = render(&disabled).unwrap();
        assert!(animation.frames[0].iter().all(|led| *led == [0; 3]));
    }

    #[test]
    fn static_uses_the_first_color_scaled_by_brightness() {
        let mut full = effect(RgbMode::Static);
        full.brightness = 4;
        let animation = render(&full).unwrap();
        assert_eq!(animation.frames[0][0], [255, 0, 0]);

        let mut dim = effect(RgbMode::Static);
        dim.brightness = 1;
        let animation = render(&dim).unwrap();
        assert_eq!(animation.frames[0][0], [64, 0, 0]);

        let mut dark = effect(RgbMode::Static);
        dark.brightness = 0;
        let animation = render(&dark).unwrap();
        assert_eq!(animation.frames[0][0], [0, 0, 0]);
    }

    #[test]
    fn brightness_off_sentinel_is_accepted() {
        let mut off = effect(RgbMode::Static);
        off.brightness = crate::types::BRIGHTNESS_OFF;
        let animation = render(&off).unwrap();
        assert!(animation.frames[0].iter().all(|led| *led == [0; 3]));
    }

    #[test]
    fn rainbow_direction_reverses_the_travel() {
        let clockwise = render(&effect(RgbMode::Rainbow)).unwrap();
        let mut counter = effect(RgbMode::Rainbow);
        counter.direction = RgbDirection::CounterClockwise;
        let counter_clockwise = render(&counter).unwrap();

        // 逆时针的第 i 颗灯等于顺时针的第 (60-i)%60 颗灯。
        for led in 0..LED_COUNT {
            let mirrored = (LED_COUNT - led) % LED_COUNT;
            assert_eq!(
                counter_clockwise.frames[0][led], clockwise.frames[0][mirrored],
                "led {led}"
            );
        }
        assert_ne!(
            clockwise.frames[0][1], counter_clockwise.frames[0][1],
            "方向相反时图案应当不同"
        );
    }

    #[test]
    fn faster_speed_shortens_the_frame_interval() {
        let mut slow = effect(RgbMode::Rainbow);
        slow.speed = 0;
        let mut fast = effect(RgbMode::Rainbow);
        fast.speed = 4;
        assert!(render(&slow).unwrap().interval_hundredths > render(&fast).unwrap().interval_hundredths);
    }

    #[test]
    fn breathing_frame_interval_follows_the_speed_scale() {
        let mut effect = effect(RgbMode::Breathing);
        effect.speed = 0;
        let slow = render(&effect).unwrap().interval_hundredths;
        effect.speed = 4;
        let fast = render(&effect).unwrap().interval_hundredths;
        assert_eq!(slow, 6 * SPEED_FACTOR[0] * 100);
        assert_eq!(fast, 6 * SPEED_FACTOR[4] * 100);
    }

    #[test]
    fn parameters_match_what_the_renderers_use() {
        let parameters = supported_parameters();
        assert_eq!(parameters.len(), MODES.len());
        let find = |mode: RgbMode| {
            parameters
                .iter()
                .find(|p| p.mode == mode)
                .expect("mode listed")
        };
        assert_eq!(find(RgbMode::Static).max_colors, 1);
        assert_eq!(find(RgbMode::Static).min_colors, 1);
        assert_eq!(find(RgbMode::Rainbow).max_colors, 0);
        assert_eq!(find(RgbMode::Rainbow).directions.len(), 2);
        assert!(find(RgbMode::Static).directions.is_empty());
        assert!(!find(RgbMode::Static).supports_speed);
        assert!(!find(RgbMode::Off).supports_speed);
        assert!(find(RgbMode::Wave).supports_speed);
    }

    #[test]
    fn frame_interval_uses_the_project_tick_unit() {
        let mut effect = effect(RgbMode::Rainbow);
        effect.speed = 2;
        let animation = render(&effect).unwrap();
        // 基准 8 tick × 速度倍率 5 = 40 tick = 4000 百分之一 tick = 25 ms。
        assert_eq!(animation.interval_hundredths, 4_000);
        assert_eq!(interval_ticks(&animation), 40);
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let mut bad_scope = effect(RgbMode::Static);
        bad_scope.scope = RgbScope::Top;
        assert!(render(&bad_scope).is_err());

        let mut bad_speed = effect(RgbMode::Static);
        bad_speed.speed = 5;
        assert!(render(&bad_speed).is_err());

        let mut bad_brightness = effect(RgbMode::Static);
        bad_brightness.brightness = 9;
        assert!(render(&bad_brightness).is_err());

        let mut bad_direction = effect(RgbMode::Rainbow);
        bad_direction.direction = RgbDirection::Up;
        assert!(render(&bad_direction).is_err());
    }
}
