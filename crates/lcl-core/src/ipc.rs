//! 后台服务与 GUI 之间的命名管道协议：每行一个 JSON 请求，对应一行 JSON 回复。
//! 管道名 `\\.\pipe\lconnect-lite`。

use crate::{Config, Status};
use lcl_effects::types::RgbEffectParameters;
use anyhow::{Context, Result};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions, Stream};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};

pub const PIPE_NAME: &str = "lconnect-lite";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    GetStatus,
    GetConfig,
    SetConfig { config: Config },
    GetAutostart,
    SetAutostart { enabled: bool },
    /// 各类设备支持的灯效和每种效果可调的参数。
    GetLightingCaps,
    GetGroupLightingCaps { address: String },
    IdentifyDevice { address: String },
    RenameDevice { address: String, name: String },
    /// 屏幕当前在显示什么，以及最近一帧画面（JPEG，base64）。
    GetLcdState,
    /// Latest-only mailbox for the independent H2 content host. No 8.8 transport.
    SubmitLcdFrame { jpeg: Vec<u8> },
    /// 把无线设备绑定到本机发射器 / 解绑。由控制线程执行，最多等 15 秒。
    Bind { address: String },
    Unbind { address: String },
    /// 开关某个本机设备的主板灯光同步。
    SetMbLightSync { address: String, enabled: bool },
    /// 最近 2 分钟的读数，界面打开时用来画走势图。
    GetHistory,
    /// 把本机发射器和已绑定的设备切到另一个无线频道（1-39）。有设备没跟上会自动切回原频道并报错。
    SetChannel { channel: u8 },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LcdState {
    /// 例如“主题：光环表盘”“图片：xxx.png”“GIF：xxx.gif（42 帧）”“未控制”。
    pub description: String,
    pub error: Option<String>,
    /// 最近一次推到屏幕上的 JPEG，base64 编码。
    pub preview_jpeg_base64: Option<String>,
}

/// 最近 [`History::LEN`] 秒的读数，每秒一个，旧的在前。没有读数的那一秒跳过（和界面的走势图一致）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct History {
    pub coolant: Vec<f32>,
    pub pump: Vec<f32>,
    pub fan: Vec<f32>,
    pub cpu: Vec<f32>,
    pub gpu: Vec<f32>,
    /// CPU 封装温度（lcl-sensord 在运行时才有）。
    #[serde(default)]
    pub cpu_temp: Vec<f32>,
}

impl History {
    pub const LEN: usize = 120;

    /// 记一秒的读数。
    pub fn push(&mut self, s: &Status) {
        let series = [
            (&mut self.coolant, s.coolant_c),
            (&mut self.pump, s.pump_rpm.map(f32::from)),
            (&mut self.fan, s.fan_percent),
            (&mut self.cpu, s.cpu_usage),
            (&mut self.gpu, s.gpu_temp_c),
            (&mut self.cpu_temp, s.cpu_temp_c),
        ];
        for (v, x) in series {
            if let Some(x) = x {
                v.push(x);
                if v.len() > Self::LEN {
                    v.remove(0);
                }
            }
        }
    }
}

/// 灯效能力：每种效果的颜色数、方向、能否调速。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LightingCaps {
    /// 本机绑定的无线风扇组里第一个组的风扇数（Static/Breathing 每个风扇一种颜色）。
    pub fan_count: u8,
    pub fans: Vec<RgbEffectParameters>,
    pub pump: Vec<RgbEffectParameters>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Status { status: Status },
    Config { config: Config },
    Autostart { enabled: bool },
    LightingCaps { caps: LightingCaps },
    LcdState { state: LcdState },
    History { history: History },
    Ok,
    Error { message: String },
}

/// 客户端：连上管道、发一个请求、等一行回复。
pub fn request(req: &Request) -> Result<Response> {
    let name = PIPE_NAME.to_ns_name::<GenericNamespaced>()?;
    let conn = Stream::connect(name).context("连不上后台服务（lcl-daemon 没在运行？）")?;
    let mut conn = BufReader::new(conn);
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    conn.get_mut().write_all(line.as_bytes())?;
    let mut reply = String::new();
    conn.read_line(&mut reply)?;
    Ok(serde_json::from_str(&reply)?)
}

/// 服务端：阻塞监听，每个连接一个线程，逐行交给 `handler`。
pub fn serve<F>(handler: F) -> Result<()>
where
    F: Fn(Request) -> Response + Send + Sync + 'static,
{
    let name = PIPE_NAME.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new()
        .name(name)
        .create_sync()
        .context("创建命名管道失败（已经有一个 lcl-daemon 在运行？）")?;
    let handler = std::sync::Arc::new(handler);
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        let handler = std::sync::Arc::clone(&handler);
        std::thread::spawn(move || {
            let mut conn = BufReader::new(conn);
            let mut line = String::new();
            while matches!(conn.read_line(&mut line), Ok(n) if n > 0) {
                let resp = match serde_json::from_str::<Request>(&line) {
                    Ok(req) => handler(req),
                    Err(e) => Response::Error { message: format!("无法解析请求：{e}") },
                };
                let mut out = serde_json::to_string(&resp).unwrap_or_default();
                out.push('\n');
                if conn.get_mut().write_all(out.as_bytes()).is_err() {
                    break;
                }
                line.clear();
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_last_two_minutes_and_skips_missing() {
        let mut h = History::default();
        for i in 0..150 {
            let s = Status { coolant_c: Some(i as f32), pump_rpm: (i % 2 == 0).then_some(2000), ..Default::default() };
            h.push(&s);
        }
        assert_eq!(h.coolant.len(), History::LEN);
        assert_eq!(h.coolant[0], 30.0);
        assert_eq!(*h.coolant.last().unwrap(), 149.0);
        assert_eq!(h.pump.len(), 75);
        assert!(h.fan.is_empty());
    }
}
