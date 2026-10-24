// release 版是无窗口程序（登录自启、托盘常驻）；调试命令会挂到启动它的终端上输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod cpu;
mod h2slot;
mod lcd;
mod lighting;
mod ring_service;
mod log;
mod probe;
mod service;
mod tray;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "lcl-daemon", about = "LConnect Lite 后台服务")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// 运行后台服务（默认）
    Serve {
        /// 不打开任何设备，只提供命名管道（L-Connect 运行时开发 GUI 用）
        #[arg(long)]
        no_devices: bool,
    },
    /// 开关开机自启（计划任务“LConnect Lite”，登录时立即启动）。安装程序以当前用户身份调用
    Autostart {
        #[arg(value_parser = ["on", "off"])]
        state: String,
    },
    /// 调试：不经过服务，直接读取设备状态
    Probe,
    /// 调试：不经过服务，直接设定泵速和风扇转速，Ctrl+C 退出
    Run {
        /// 泵目标转速（rpm），方屏 1600-3200，圆屏 1600-2500
        #[arg(long, default_value_t = 2400)]
        pump_rpm: u16,
        /// 所有风扇的占空比（%），最低 20
        #[arg(long, default_value_t = 50)]
        fan: u8,
        /// 运行多少秒后自动退出（不填则一直运行）
        #[arg(long)]
        secs: Option<u64>,
        /// 只打印要发给无线设备的包，不实际发送；冷头只读不写
        #[arg(long)]
        dry_run: bool,
    },
}

fn main() -> Result<()> {
    attach_parent_console();
    let result = match Cli::parse().cmd.unwrap_or(Cmd::Serve { no_devices: false }) {
        Cmd::Serve { no_devices } => service::serve(!no_devices),
        Cmd::Autostart { state } => autostart::set(state == "on"),
        Cmd::Probe => probe::status(),
        Cmd::Run {
            pump_rpm,
            fan,
            secs,
            dry_run,
        } => probe::run(pump_rpm, fan, secs.map(Duration::from_secs), dry_run),
    };
    if let Err(e) = &result {
        log::line(&format!("退出：{e:#}"));
    }
    result
}

/// 无窗口程序从终端启动时，把输出接回那个终端；双击或自启时没有父控制台，什么也不做。
fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: 只是尝试连接父进程的控制台，失败无副作用。
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}
