//! H2 屏幕内容宿主：把配置里的画面渲染成 JPEG，交给后台服务推屏。
//!
//! 宿主只做两件事：
//!
//! 1. 通过命名管道问后台服务要配置和状态（轮询间隔不超过 1 秒）。
//! 2. 按配置渲染画面，用 `Request::SubmitLcdFrame` 把 JPEG 交给后台服务。
//!
//! 宿主**不打开任何 USB 设备**：H2 冷头（`0x1CBE:0xA034` 方屏 / `0x1CBE:0xA021`
//! 圆屏）的 USB 句柄始终在后台服务手里，8.8 面板的直连接口（`0x1CBE:0xA088`，
//! LP 那条路）和它的灯环（`0x0416:0x8050`）也由后台服务直连，宿主既不认领这些
//! PID，也不碰它们的传输。8.8 的画面仍然走它自己的直连通道。
//!
//! 画面准备的逻辑（裁方、旋转、压 JPEG、GIF 拆帧、主题仪表盘）全部复用
//! `lcl-media`，和原来在守护进程里做的是同一套代码，搬到独立进程里而已。

use anyhow::Result;
use lcl_core::config::{Lcd, LcdMode};
use lcl_core::Status;
use lcl_media::theme::{self, rgb, Style, ThemeData};
use lcl_media::Frame;
use std::collections::VecDeque;
use std::path::Path;
use std::time::{Duration, Instant};

/// 现阶段送帧的上限。屏幕只有 480×480，5 fps 已经够顺，再高只是白占带宽。
pub const MAX_FPS: u8 = 5;
/// 送帧间隔的下限（`MAX_FPS` 对应的间隔）。
pub const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(1000 / MAX_FPS as u64);
/// 配置和状态的轮询间隔。要求不超过 1 秒。
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// 静态图片隔多久重发一次，防止设备自己切回别的画面。
pub const STILL_REFRESH: Duration = Duration::from_secs(30);
/// 主题仪表盘最多每秒重画一次。
pub const DASHBOARD_INTERVAL: Duration = Duration::from_secs(1);
/// 水温走势：每 10 秒记一个点，保留 10 分钟。
const HISTORY_EVERY: Duration = Duration::from_secs(10);
const HISTORY_LEN: usize = 60;
/// “稳定 / 上升 / 下降”看两分钟内的变化。
const TREND_SAMPLES: usize = 12;
/// 媒体文件的大小上限（32 MB）：太大的文件直接拒绝，别把内存吃光。
pub const MAX_MEDIA_BYTES: u64 = 32 * 1024 * 1024;
/// GIF 最多留多少帧（`lcl-media` 自己封顶 300 帧，这里再抽稀一次）。
const MAX_GIF_FRAMES: usize = 150;

/// 本地时间（小时、分钟、月、日、星期）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalTime {
    pub hour: u8,
    pub minute: u8,
    pub month: u8,
    pub day: u8,
    /// 0 = 星期日。
    pub weekday: u8,
}

/// 读本地时间。
pub fn local_time() -> LocalTime {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: GetLocalTime 只往传入的结构体里写。
    let t = unsafe {
        let mut t: SYSTEMTIME = std::mem::zeroed();
        GetLocalTime(&mut t);
        t
    };
    LocalTime {
        hour: t.wHour as u8,
        minute: t.wMinute as u8,
        month: t.wMonth as u8,
        day: t.wDay as u8,
        weekday: t.wDayOfWeek as u8,
    }
}

/// 最近十分钟的水温，给走势线和趋势标签用。
#[derive(Default)]
pub struct History {
    samples: VecDeque<f32>,
    last: Option<Instant>,
}

impl History {
    fn push(&mut self, coolant: Option<f32>) {
        let Some(c) = coolant else { return };
        if self.last.is_some_and(|t| t.elapsed() < HISTORY_EVERY) {
            return;
        }
        self.last = Some(Instant::now());
        self.samples.push_back(c);
        while self.samples.len() > HISTORY_LEN {
            self.samples.pop_front();
        }
    }

    fn trend(&self) -> Option<f32> {
        let n = self.samples.len();
        (n > 1).then(|| self.samples[n - 1] - self.samples[n.saturating_sub(TREND_SAMPLES + 1)])
    }
}

/// 宿主准备好的画面内容。
pub enum Content {
    /// 没有内容（未托管，或者准备失败）。
    None,
    /// 静态图片（已经是 480×480 的 JPEG）。
    Still(Vec<u8>),
    /// GIF 帧序列。
    Anim(Vec<Frame>),
    /// 传感器主题：按状态实时渲染。
    Theme,
}

/// 按配置准备画面，返回内容和一句描述。
pub fn prepare(cfg: &Lcd) -> Result<(Content, String)> {
    let path = Path::new(&cfg.media_path);
    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    match cfg.mode {
        LcdMode::Unmanaged => Ok((Content::None, String::new())),
        LcdMode::Dashboard => Ok((Content::Theme, format!("主题：{}", theme::find(&cfg.theme).name))),
        LcdMode::Image => {
            anyhow::ensure!(!cfg.media_path.is_empty(), "还没有选择图片");
            check_size(path)?;
            Ok((Content::Still(lcl_media::load_still(path, cfg.rotation)?), format!("图片：{name}")))
        }
        LcdMode::Gif => {
            anyhow::ensure!(!cfg.media_path.is_empty(), "还没有选择 GIF");
            check_size(path)?;
            // 帧率按上限裁一下：现在最多 5 fps，没必要解一堆用不上的帧。
            let frames = thin(lcl_media::load_gif(path, cfg.rotation, cfg.max_fps.min(MAX_FPS))?);
            let desc = format!("GIF：{name}（{} 帧）", frames.len());
            Ok((Content::Anim(frames), desc))
        }
    }
}

/// 媒体文件太大就不加载。
fn check_size(path: &Path) -> Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        anyhow::ensure!(
            meta.len() <= MAX_MEDIA_BYTES,
            "文件太大（{} MB），不加载",
            meta.len() / 1024 / 1024
        );
    }
    Ok(())
}

/// GIF 解出来的帧太多时抽稀：每隔 n 帧留一帧，整段动画还看得到，内存小一半。
fn thin(frames: Vec<Frame>) -> Vec<Frame> {
    let total: usize = frames.iter().map(|f| f.jpeg.len()).sum();
    if frames.len() <= MAX_GIF_FRAMES && total <= MAX_MEDIA_BYTES as usize {
        return frames;
    }
    let mut step = 2usize;
    while step <= frames.len() && (frames.len() / step > MAX_GIF_FRAMES || total / step > MAX_MEDIA_BYTES as usize) {
        step += 1;
    }
    frames.into_iter().step_by(step).collect()
}

/// 配置指纹：只有它变了才重新读文件、重新解码。
fn fingerprint(cfg: &Lcd) -> String {
    format!(
        "{:?}|{}|{}|{}|{}|{:?}|{:?}",
        cfg.mode, cfg.media_path, cfg.rotation, cfg.max_fps, cfg.theme, cfg.theme_mode, cfg.accent
    )
}

/// 内容引擎：配置 → 画面 → 一帧一帧的 JPEG。
///
/// 引擎本身不碰 IO，方便测试：时间由调用方传进来，状态也一样。
pub struct Engine {
    content: Content,
    /// 当前内容的配置指纹。
    fingerprint: Option<String>,
    /// 动画当前的帧序号。
    idx: usize,
    /// 主题上次画面的摘要，没变就不重画。
    dash: Option<String>,
    /// 水温历史。
    history: History,
    /// 下一帧什么时候可以发。
    next_due: Instant,
    /// 内容描述。
    description: String,
    /// 准备失败时的错误。
    error: Option<String>,
    /// 已经产出、但还没确认送出去的帧。提交失败时留在这儿，下一轮重发。
    pending: Option<Vec<u8>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            content: Content::None,
            fingerprint: None,
            idx: 0,
            dash: None,
            history: History::default(),
            next_due: Instant::now(),
            description: String::new(),
            error: None,
            pending: None,
        }
    }

    /// 内容描述（“主题：光环表盘”“图片：cat.png”…）。
    pub fn description(&self) -> &str {
        &self.description
    }

    /// 准备内容时的错误。
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// 下一帧什么时候可以发。
    pub fn next_due(&self) -> Instant {
        self.next_due
    }

    /// 记一次水温（趋势和走势线用）。
    pub fn observe(&mut self, status: &Status) {
        self.history.push(status.coolant_c);
    }

    /// 配置变了就重新准备画面；没变就什么都不做（不重复读文件、不重复解码）。
    pub fn sync(&mut self, cfg: &Lcd) {
        let key = fingerprint(cfg);
        if self.fingerprint.as_deref() == Some(key.as_str()) {
            return;
        }
        self.fingerprint = Some(key);
        self.idx = 0;
        self.dash = None;
        self.next_due = Instant::now();
        self.error = None;
        // 内容变了，之前那一帧作废。
        self.pending = None;
        match prepare(cfg) {
            Ok((content, desc)) => {
                self.content = content;
                self.description = desc;
            }
            Err(e) => {
                self.content = Content::None;
                self.description = "画面准备失败".into();
                self.error = Some(format!("{e:#}"));
            }
        }
    }

    /// 到点了就产出下一帧；没到点返回 `None`。
    ///
    /// 上一帧还没送出去（提交失败）时，先把它重发一遍——不能丢帧，
    /// 也不该让静态图干等 30 秒。
    ///
    /// 主题模式下，画面内容没变就不产出帧（不重画、不重发）。
    pub fn next_frame(&mut self, cfg: &Lcd, status: &Status, now: Instant, time: LocalTime) -> Option<Vec<u8>> {
        if let Some(frame) = self.pending.as_ref() {
            return Some(frame.clone());
        }
        if now < self.next_due {
            return None;
        }
        let frame = match &self.content {
            Content::None => {
                self.next_due = now + POLL_INTERVAL;
                None
            }
            Content::Still(jpeg) => {
                // 静态图隔一段时间重发一次，防止设备自己切回别的画面。
                self.next_due = now + STILL_REFRESH;
                Some(jpeg.clone())
            }
            Content::Anim(frames) => {
                let frame = &frames[self.idx % frames.len()];
                let delay = Duration::from_millis(u64::from(frame.delay_ms)).max(MIN_FRAME_INTERVAL);
                self.idx = (self.idx + 1) % frames.len();
                self.next_due = now + delay;
                Some(frame.jpeg.clone())
            }
            Content::Theme => {
                self.next_due = now + DASHBOARD_INTERVAL;
                let data = self.theme_data(status, time);
                let info = theme::find(&cfg.theme);
                let style = Style {
                    dark: cfg.theme_mode.is_dark(time.hour),
                    accent: cfg.accent.map_or(rgb(info.accent), |[r, g, b]| [r, g, b, 255]),
                };
                // 显示的内容和外观都没变就不重画、不重发。
                let key = format!("{}|{:?}|{}|{}", info.id, style, cfg.rotation, data.key());
                if self.dash.as_deref() == Some(key.as_str()) {
                    return None;
                }
                let jpeg = match lcl_media::encode(theme::render(info.id, &data, &style), cfg.rotation) {
                    Ok(jpeg) => jpeg,
                    Err(e) => {
                        self.error = Some(format!("{e:#}"));
                        return None;
                    }
                };
                self.dash = Some(key);
                self.error = None;
                Some(jpeg)
            }
        };
        if let Some(frame) = &frame {
            self.pending = Some(frame.clone());
        }
        frame
    }

    /// 这一帧已经送到后台服务了。
    pub fn committed(&mut self) {
        self.pending = None;
    }

    /// 状态快照 → 主题要显示的数据（加上本地时间和水温历史）。
    fn theme_data(&self, status: &Status, time: LocalTime) -> ThemeData {
        ThemeData {
            coolant_c: status.coolant_c,
            coolant_trend: self.history.trend(),
            coolant_history: self.history.samples.iter().copied().collect(),
            pump_rpm: status.pump_rpm,
            pump_target_rpm: status.pump_target_rpm,
            fan_percent: status.fan_percent,
            fan_rpm: status.fan_groups.first().map(|g| g.rpm.clone()).unwrap_or_default(),
            cpu_usage: status.cpu_usage,
            cpu_temp_c: status.cpu_temp_c,
            gpu_temp_c: status.gpu_temp_c,
            gpu_usage: status.gpu_usage,
            time: (time.hour, time.minute),
            date: (time.month, time.day, time.weekday),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lcl_core::config::ThemeMode;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join("lcl-display-host-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_png(name: &str, color: [u8; 4]) -> PathBuf {
        let path = temp_dir().join(name);
        image::RgbaImage::from_pixel(64, 64, image::Rgba(color)).save(&path).unwrap();
        path
    }

    fn write_gif(name: &str) -> PathBuf {
        let path = temp_dir().join(name);
        // 三帧的 GIF，每帧 100 ms。
        let mut buf = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut buf);
            for i in 0..3u8 {
                let frame = image::Frame::from_parts(
                    image::RgbaImage::from_pixel(32, 32, image::Rgba([i * 80, 0, 0, 255])),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(100, 1),
                );
                encoder.encode_frame(frame).unwrap();
            }
        }
        std::fs::write(&path, &buf).unwrap();
        path
    }

    #[test]
    fn still_image_is_prepared_once_and_reused() {
        let path = write_png("still.png", [10, 20, 30, 255]);
        let cfg = Lcd { mode: LcdMode::Image, media_path: path.to_string_lossy().into(), ..Default::default() };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        assert!(engine.error().is_none());
        assert_eq!(engine.description(), "图片：still.png");

        let now = Instant::now();
        let frame = engine.next_frame(&cfg, &Status::default(), now, LocalTime::default()).unwrap();
        // 解出来必须是 480×480 的 JPEG。
        let img = image::load_from_memory(&frame).unwrap();
        assert_eq!((img.width(), img.height()), (480, 480));
        engine.committed();

        // 静态图不会一帧接一帧地发：下一次要等 STILL_REFRESH。
        assert!(engine.next_frame(&cfg, &Status::default(), now + Duration::from_secs(1), LocalTime::default()).is_none());
        let again = engine
            .next_frame(&cfg, &Status::default(), now + STILL_REFRESH, LocalTime::default())
            .unwrap();
        assert_eq!(again, frame, "重发的应该是同一帧");
    }

    #[test]
    fn a_frame_that_failed_to_submit_is_sent_again() {
        let path = write_png("retry.png", [10, 20, 30, 255]);
        let cfg = Lcd { mode: LcdMode::Image, media_path: path.to_string_lossy().into(), ..Default::default() };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        let now = Instant::now();
        let first = engine.next_frame(&cfg, &Status::default(), now, LocalTime::default()).unwrap();
        // 没 committed（相当于提交失败）：下一轮必须重发同一帧，不能干等 30 秒。
        let again = engine.next_frame(&cfg, &Status::default(), now + Duration::from_millis(50), LocalTime::default()).unwrap();
        assert_eq!(first, again);
    }

    #[test]
    fn gif_frames_are_capped_at_the_frame_rate_limit() {
        let path = write_gif("anim.gif");
        let cfg = Lcd {
            mode: LcdMode::Gif,
            media_path: path.to_string_lossy().into(),
            max_fps: 30,
            ..Default::default()
        };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        assert!(engine.error().is_none(), "{:?}", engine.error());
        let now = Instant::now();
        let first = engine.next_frame(&cfg, &Status::default(), now, LocalTime::default()).unwrap();
        engine.committed();
        // 上限是 5 fps：100 ms 的帧要按 200 ms 的节奏发。
        assert!(engine.next_frame(&cfg, &Status::default(), now + Duration::from_millis(100), LocalTime::default()).is_none());
        let second = engine
            .next_frame(&cfg, &Status::default(), now + MIN_FRAME_INTERVAL, LocalTime::default())
            .unwrap();
        assert_ne!(first, second, "GIF 应该在换帧");
    }

    #[test]
    fn theme_is_redrawn_only_when_the_content_changes() {
        let cfg = Lcd { mode: LcdMode::Dashboard, theme: "ring".into(), ..Default::default() };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        let now = Instant::now();
        let time = LocalTime { hour: 12, minute: 30, month: 10, day: 21, weekday: 3 };
        let status = Status { coolant_c: Some(27.0), ..Default::default() };
        let first = engine.next_frame(&cfg, &status, now, time).unwrap();
        let img = image::load_from_memory(&first).unwrap();
        assert_eq!((img.width(), img.height()), (480, 480));
        engine.committed();

        // 读数没变：下一秒不重画。
        assert!(engine
            .next_frame(&cfg, &status, now + DASHBOARD_INTERVAL, time)
            .is_none());
        // 读数变了：要重画。
        let hotter = Status { coolant_c: Some(31.0), ..Default::default() };
        assert!(engine
            .next_frame(&cfg, &hotter, now + DASHBOARD_INTERVAL * 2, time)
            .is_some());
    }

    #[test]
    fn config_change_reloads_the_media() {
        let path = write_png("reload.png", [10, 20, 30, 255]);
        let cfg = Lcd { mode: LcdMode::Image, media_path: path.to_string_lossy().into(), ..Default::default() };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        let first = engine
            .next_frame(&cfg, &Status::default(), Instant::now(), LocalTime::default())
            .unwrap();

        // 换一张图：内容要重新准备，帧也要换。
        let other = write_png("reload2.png", [200, 100, 50, 255]);
        let cfg2 = Lcd { media_path: other.to_string_lossy().into(), ..cfg.clone() };
        engine.sync(&cfg2);
        let second = engine
            .next_frame(&cfg2, &Status::default(), Instant::now(), LocalTime::default())
            .unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn unmanaged_mode_prepares_nothing() {
        let cfg = Lcd { mode: LcdMode::Unmanaged, ..Default::default() };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        assert!(engine
            .next_frame(&cfg, &Status::default(), Instant::now(), LocalTime::default())
            .is_none());
        assert!(engine.description().is_empty());
    }

    #[test]
    fn missing_media_reports_an_error_instead_of_panicking() {
        let cfg = Lcd {
            mode: LcdMode::Image,
            media_path: "Z:\\不存在的图片.png".into(),
            ..Default::default()
        };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        assert!(engine.error().is_some());
        assert!(engine
            .next_frame(&cfg, &Status::default(), Instant::now(), LocalTime::default())
            .is_none());
    }

    #[test]
    fn theme_mode_switches_between_light_and_dark() {
        let dark = Lcd { mode: LcdMode::Dashboard, theme_mode: ThemeMode::Dark, ..Default::default() };
        let light = Lcd { mode: LcdMode::Dashboard, theme_mode: ThemeMode::Light, ..Default::default() };
        let status = Status::default();
        let noon = LocalTime { hour: 12, minute: 0, month: 1, day: 1, weekday: 0 };
        let mut engine = Engine::new();
        engine.sync(&dark);
        let a = engine.next_frame(&dark, &status, Instant::now(), noon).unwrap();
        engine.committed();
        engine.sync(&light);
        let b = engine.next_frame(&light, &status, Instant::now(), noon).unwrap();
        assert_ne!(a, b, "明暗不同，画面应该不同");
    }

    #[test]
    fn oversized_media_is_refused_before_decoding() {
        // 造一个超大的稀疏文件（只是检查大小，不该被读进内存）。
        let path = temp_dir().join("huge.png");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_MEDIA_BYTES + 1).unwrap();
        drop(file);
        let cfg = Lcd { mode: LcdMode::Image, media_path: path.to_string_lossy().into(), ..Default::default() };
        let mut engine = Engine::new();
        engine.sync(&cfg);
        assert!(engine.error().is_some(), "太大的文件要报错");
        assert!(engine
            .next_frame(&cfg, &Status::default(), Instant::now(), LocalTime::default())
            .is_none());
        let _ = std::fs::remove_file(&path);
    }
}
