//! 8.8 灯环线程：按配置把灯效渲染成逐帧颜色，推到 0x0416:0x8050 的灯环接口。
//!
//! 与屏幕线程完全独立：只碰灯环这一个 PID，不开显示接口，也不发任何显示/复位命令。
//!
//! 语义上有三档，界面上要分清：
//! - `enabled = false`：**不接管**灯环。线程不打开设备，也不发任何数据，
//!   灯保持设备自己最后一次收到的画面（想熄灯请用下一档）。
//! - `enabled = true` 且 `effect.mode = Off`：接管并主动推一帧全黑，即熄灯。
//! - `enabled = true` 且其它模式：接管并持续推帧。
//!
//! 帧率来自渲染结果的 `Animation::interval_hundredths`（单位是百分之一 tick，
//! 1 tick = 0.625 ms），按绝对时间点调度而不是「推完再睡」，避免误差累积。
//! 掉线后按 5 秒退避重开，不会空转。
//!
//! 未在硬件上验证：包布局来自官方反编译代码，颜色字节序和实际节奏仍待实测。

use crate::log;
use lcl_core::config::Ring88Config;
use lcl_core::status::Ring88Status;
use lcl_devices::ring88::{duration_from_hundredths, Ring88, LED_COUNT, RING88_IDS, UNIVERSAL_SCREEN_88_ID};
use lcl_devices::usb::device_present;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 掉线（或打开失败）后重开设备的等待。
const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);
/// 空闲时检查配置的间隔。
const IDLE: Duration = Duration::from_millis(200);
/// 一次睡眠的分片长度：保证 stop 能较快生效。
const SLEEP_SLICE: Duration = Duration::from_millis(50);
const PRESENCE_INTERVAL: Duration=Duration::from_secs(2);

/// 渲染好的一段灯效。配置没变就复用，不重复渲染。
struct Rendered {
    /// 用来判断配置有没有变。
    key: String,
    frames: Vec<Vec<[u8; 3]>>,
    /// 帧间隔，单位是百分之一 tick。
    interval_hundredths: u32,
}

/// 推一帧时用到的帧内容（帧本身、帧数、帧间隔）或帧长度不对时的 LED 数。
type PreparedFrame = Result<([[u8; 3]; LED_COUNT], usize, Duration), usize>;

/// 灯环线程。
///
/// * `stop`：置位后线程尽快退出（睡眠按 50 ms 分片）。
/// * `devices_enabled`：服务是否允许打开设备。为 false 时完全不打开灯环。
/// * `snapshot`：取当前配置。
/// * `publish`：状态变化时上报。
pub fn run(
    stop: &AtomicBool,
    devices_enabled: bool,
    snapshot: impl Fn() -> Ring88Config,
    publish: impl Fn(Ring88Status),
) {
    let mut status = Ring88Status {
        present:false,connected: false,display_present:false,
        error: None,
        // 8.8 灯环是独立面板上的外接显示。
        external_display: true,
    };
    let mut published = status.clone();
    publish(status.clone());

    if !devices_enabled {
        // 服务被要求不打开任何设备：灯环这条线整条不启动，只等退出。
        while !stop.load(Ordering::SeqCst) {
            sleep_slice(stop, IDLE);
        }
        return;
    }

    let mut device: Option<Ring88> = None;
    let mut rendered: Option<Rendered> = None;
    let mut frame_index: usize = 0;
    let mut next_due = Instant::now();
    let mut retry_at: Option<Instant> = None;
    // 上一次记过的错误：同一条不重复记，免得每轮都刷日志。
    let mut last_error: Option<String> = None;
    let mut next_presence=Instant::now();

    while !stop.load(Ordering::SeqCst) {
        let now=Instant::now();
        if now>=next_presence {
            if let Ok(v)=device_present(&RING88_IDS){status.present=v;}
            if let Ok(v)=device_present(&[UNIVERSAL_SCREEN_88_ID]){status.display_present=v;}
            next_presence=now+PRESENCE_INTERVAL;
            publish_if_changed(&status,&mut published,&publish);
        }
        let cfg = snapshot();

        // 不接管：释放句柄，不发任何数据（也不发关灯）。
        if !cfg.enabled {
            if device.take().is_some() {
                rendered = None;
                frame_index = 0;
                next_due = Instant::now();
            }
            status.connected = false;
            status.error = None;
            publish_if_changed(&status, &mut published, &publish);
            sleep_slice(stop, IDLE);
            continue;
        }

        // 需要设备；没插或打开失败就退避重试。
        if device.is_none() {
            if retry_at.is_some_and(|at| Instant::now() < at) {
                sleep_slice(stop, SLEEP_SLICE);
                continue;
            }
            match Ring88::open() {
                Ok(Some(dev)) => {
                    device = Some(dev);
                    rendered = None;
                    frame_index = 0;
                    next_due = Instant::now();
                    retry_at = None;
                    status.present=true;
                    status.connected = true;
                    status.error = None;
                    last_error = None;
                }
                Ok(None) => {
                    // 没插不算错误，只是没连上。
                    status.present = false;
                    status.connected = false;
                    status.error = None;
                    retry_at = Some(Instant::now() + RECONNECT_BACKOFF);
                }
                Err(e) => {
                    status.present=device_present(&RING88_IDS).unwrap_or(status.present);
                    let msg = format!("8.8 灯环打开失败：{e:#}");
                    log_once(&mut last_error, &msg);
                    status.connected = false;
                    status.error = Some(msg);
                    retry_at = Some(Instant::now() + RECONNECT_BACKOFF);
                }
            }
            publish_if_changed(&status, &mut published, &publish);
            continue;
        }

        // 配置变了就重新渲染（渲染一次、缓存到下次配置变化）。
        let key = effect_key(&cfg);
        if rendered.as_ref().is_none_or(|r| r.key != key) {
            match lcl_effects::ring88::render(&cfg.effect) {
                Ok(animation) => {
                    rendered = Some(Rendered {
                        key,
                        frames: animation.frames,
                        interval_hundredths: animation.interval_hundredths,
                    });
                    frame_index = 0;
                    next_due = Instant::now();
                    status.error = None;
                    last_error = None;
                }
                Err(e) => {
                    let msg = format!("8.8 灯环效果不支持：{e:#}");
                    log_once(&mut last_error, &msg);
                    rendered = None;
                    status.error = Some(msg);
                }
            }
            publish_if_changed(&status, &mut published, &publish);
        }

        // 渲染失败时等配置变化（下一轮会重新比对 key）。
        let Some(current) = rendered.as_ref() else {
            sleep_slice(stop, IDLE);
            continue;
        };
        if current.frames.is_empty() {
            sleep_slice(stop, IDLE);
            continue;
        }

        // 到点了才推帧。
        let now = Instant::now();
        if now < next_due {
            sleep_slice(stop, next_due - now);
            continue;
        }

        // 先把这一帧和周期算出来；借用到这里就结束，后面可以自由改 rendered。
        let prepared: Option<PreparedFrame> = {
            let slice = &current.frames[frame_index % current.frames.len()];
            match <[[u8; 3]; LED_COUNT]>::try_from(slice.as_slice()) {
                Ok(frame) => Some(Ok((
                    frame,
                    current.frames.len(),
                    duration_from_hundredths(current.interval_hundredths),
                ))),
                Err(_) => Some(Err(slice.len())),
            }
        };

        match prepared {
            Some(Ok((frame, count, period))) => {
                let result = device
                    .as_mut()
                    .expect("上面确认过设备已打开")
                    .push_frame(&frame);
                match result {
                    Ok(()) => {
                        frame_index = (frame_index + 1) % count;
                        // 用「现在」重新起算，不追赶欠下的帧，避免一次性连推好几帧。
                        next_due = Instant::now() + period;
                        status.error = None;
                        last_error = None;
                    }
                    Err(e) => {
                        let msg = format!("8.8 灯环推送失败：{e:#}");
                        log_once(&mut last_error, &msg);
                        status.connected = false;
                        status.error = Some(msg);
                        device = None;
                        rendered = None;
                        frame_index = 0;
                        retry_at = Some(Instant::now() + RECONNECT_BACKOFF);
                    }
                }
            }
            Some(Err(len)) => {
                let msg = format!("8.8 灯环帧长度异常：{len}（应为 {LED_COUNT}）");
                log_once(&mut last_error, &msg);
                status.error = Some(msg);
                rendered = None;
            }
            None => {}
        }
        publish_if_changed(&status, &mut published, &publish);
    }
}

/// 配置的灯效部分变了就重新渲染。
fn effect_key(cfg: &Ring88Config) -> String {
    format!("{:?}", cfg.effect)
}

/// 同一条错误只记一次日志，免得每轮都刷。
fn log_once(last: &mut Option<String>, msg: &str) {
    if last.as_deref() != Some(msg) {
        log::line(msg);
        *last = Some(msg.to_string());
    }
}

/// 状态有变化才上报。
fn publish_if_changed(
    status: &Ring88Status,
    published: &mut Ring88Status,
    publish: &impl Fn(Ring88Status),
) {
    if status.present != published.present
        || status.connected != published.connected
        || status.display_present != published.display_present
        || status.error != published.error
        || status.external_display != published.external_display
    {
        *published = status.clone();
        publish(status.clone());
    }
}

/// 分片睡眠：最多睡 `total`，遇到 stop 立刻返回。
fn sleep_slice(stop: &AtomicBool, total: Duration) {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(left.min(SLEEP_SLICE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lcl_core::config::Ring88Config;
    use lcl_effects::{RgbEffect, RgbMode};

    #[test]
    fn effect_key_changes_with_the_effect() {
        let mut cfg = Ring88Config::default();
        let before = effect_key(&cfg);
        cfg.effect.mode = RgbMode::Rainbow;
        assert_ne!(effect_key(&cfg), before);
    }

    #[test]
    fn status_is_only_published_on_change() {
        let status = Ring88Status {
            present:false,connected: false,display_present:false,error: None,external_display: true,
        };
        let mut published = status.clone();
        let calls = std::cell::Cell::new(0u32);
        let publish = |_: Ring88Status| calls.set(calls.get() + 1);
        publish_if_changed(&status, &mut published, &publish);
        assert_eq!(calls.get(), 0, "没有变化就不该上报");
        let mut changed = status.clone();
        changed.connected = true;
        publish_if_changed(&changed, &mut published, &publish);
        assert_eq!(calls.get(), 1);
        publish_if_changed(&changed, &mut published, &publish);
        assert_eq!(calls.get(), 1, "同样的状态不重复上报");
    }

    #[test]
    fn frame_interval_uses_the_project_tick_unit() {
        // 100 = 1 tick = 0.625 ms。
        let one_tick = duration_from_hundredths(100);
        assert_eq!(one_tick, Duration::from_micros(625));
        // 4000 = 40 tick = 25 ms（彩虹效果速度 2 的默认值）。
        assert_eq!(duration_from_hundredths(4000), Duration::from_millis(25));
    }

    #[test]
    fn rendered_frames_have_the_expected_length() {
        let effect = RgbEffect {
            mode: RgbMode::Static,
            colors: vec![[255, 0, 0]],
            ..RgbEffect::default()
        };
        let animation = lcl_effects::ring88::render(&effect).unwrap();
        for frame in &animation.frames {
            assert_eq!(frame.len(), LED_COUNT);
            assert!(<[[u8; 3]; LED_COUNT]>::try_from(frame.as_slice()).is_ok());
        }
    }
}
