//! 后台服务每秒更新一次、GUI 轮询读取的状态快照。

use crate::config::CoolingMode;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Status {
    #[serde(default)]
    pub ring88: Ring88Status,
    pub uptime_s: u64,
    pub mode: Option<CoolingMode>,
    /// 低通滤波后的水温（°C），曲线用的就是它。
    pub coolant_c: Option<f32>,
    /// 设备报告的原始水温，只有整数精度。
    pub coolant_raw_c: Option<f32>,
    /// 整机 CPU 占用率（%），来自 GetSystemTimes。
    pub cpu_usage: Option<f32>,
    /// CPU 封装温度和功耗，来自 lcl-sensord（PawnIO）；服务没装或驱动没装时为空。
    #[serde(default)]
    pub cpu_temp_c: Option<f32>,
    #[serde(default)]
    pub cpu_power_w: Option<f32>,
    /// 读不到 CPU 温度的原因（比如“没有安装 PawnIO 驱动”）。
    #[serde(default)]
    pub cpu_sensor_error: Option<String>,
    /// CPU 温度保护正在生效（泵拉满、风扇提速）。
    #[serde(default)]
    pub cpu_guard: bool,
    /// 泵的功耗前馈当前加了多少 rpm。
    #[serde(default)]
    pub pump_boost_rpm: Option<f32>,
    /// NVIDIA GPU（NVML）；没有 N 卡或驱动时为空。
    pub gpu_temp_c: Option<f32>,
    pub gpu_usage: Option<f32>,
    pub gpu_power_w: Option<f32>,
    /// RX 采样到的主板 PWM 占空比（%）；没接信号线时为空。
    pub mb_pwm_percent: Option<f32>,
    /// 风扇曲线前馈当前加了多少个百分点。
    pub boost_percent: Option<f32>,
    pub pump_rpm: Option<u16>,
    pub pump_target_rpm: Option<u16>,
    /// 当前下发给风扇的占空比（%）。
    pub fan_percent: Option<f32>,
    pub fan_groups: Vec<FanGroup>,
    pub devices: Vec<DeviceInfo>,
    /// RX 听到的所有无线设备（包括未绑定的、别的发射器的），给“设备与绑定”页用。
    pub wireless: Vec<WirelessDevice>,
    /// 本机发射器 MAC 和频道。
    pub transmitter: Option<(String, u8)>,
    /// 最近一次控制循环里的错误，正常时为空。
    pub last_error: Option<String>,
    /// 后台服务自身的私有内存（MB）。
    #[serde(default)]
    pub memory_mb: Option<f32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ring88Status {
    /// 8.8灯环PID 0416:8050在总线上枚举到，不代表被本服务接管。
    #[serde(default)] pub present: bool,
    /// 灯环句柄已打开、正在由本服务控制。
    pub connected: bool,
    /// 配对的显示PID 1CBE:A088只做只读枚举，画面仍归LP。
    #[serde(default)] pub display_present: bool,
    pub error: Option<String>,
    pub external_display: bool,
}

/// 一个无线风扇组（一条 RX 设备记录，最多 4 个风扇）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanGroup {
    #[serde(default)]
    pub target_percent: Option<f32>,
    #[serde(default)]
    pub source_error: Option<String>,
    #[serde(default)]
    pub supports_control: bool,
    pub address: String,
    pub kind: String,
    pub rpm: Vec<u16>,
    pub pwm: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WirelessDevice {
    pub address: String,
    pub kind: String,
    /// "ours" 本机 / "unbound" 未绑定 / "other" 其他发射器。
    pub owner: String,
    pub master: String,
    pub fan_count: u8,
    pub rx: u8,
    pub channel: u8,
    pub mb_light_sync: bool,
    /// 在锁定列表之外（锁定绑定开着时不受控制）。
    pub excluded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub name: String,
    pub connection: String,
    pub address: String,
}
