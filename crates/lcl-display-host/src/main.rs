//! 屏幕内容宿主（可执行文件）。
//!
//! 问后台服务要配置和状态，把画面渲染成 JPEG，再交回后台服务推屏。
//! 宿主不打开任何 USB 设备，也不启动后台服务：后台服务没跑的时候它就退避重试。

use anyhow::{anyhow, Result};
use clap::Parser;
use lcl_core::config::LcdMode;
use lcl_core::{ipc, Config, Request, Response, Status};
use lcl_display_host::{local_time, Engine};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 失败之后的退避：200 ms 起，翻倍，最多 5 秒。
const BACKOFF_BASE: Duration = Duration::from_millis(200);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

#[derive(Parser)]
#[command(name = "lcl-display-host", about = "H2 屏幕内容宿主：渲染画面交给后台服务推屏（自己不碰 USB）")]
struct Cli {
    /// 只送一帧就退出（调试用）。
    #[arg(long)]
    once: bool,
    /// 取配置的间隔（毫秒，最大 1000）。
    #[arg(long, default_value_t = 500)]
    poll_ms: u64,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let poll = Duration::from_millis(cli.poll_ms.clamp(50, 1000));
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        // 没有控制台时注册会失败，不影响运行。
        let _ = ctrlc::set_handler(move || stop.store(true, Ordering::SeqCst));
    }

    let mut engine = Engine::new();
    let mut backoff = BACKOFF_BASE;
    let mut described = String::new();
    while !stop.load(Ordering::SeqCst) {
        match tick(&mut engine) {
            Ok(()) => {
                backoff = BACKOFF_BASE;
                let desc = engine.description().to_string();
                if desc != described {
                    described = desc;
                    eprintln!("屏幕内容宿主：{described}");
                }
                if let Some(e) = engine.error() {
                    eprintln!("屏幕内容宿主：{e}");
                }
                if cli.once {
                    break;
                }
                // 下一次送帧的时间到了就送；没到就先去问一遍配置（最多 poll 一次）。
                let wait = engine
                    .next_due()
                    .saturating_duration_since(Instant::now())
                    .min(poll)
                    .max(Duration::from_millis(20));
                std::thread::sleep(wait);
            }
            Err(e) => {
                eprintln!("屏幕内容宿主：{e:#}");
                if cli.once {
                    return Err(e);
                }
                // 后台服务没起、或者管道断了：退避重试，不要空转。
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
    Ok(())
}

/// 跑一轮：取配置和状态，准备内容，送一帧。
fn tick(engine: &mut Engine) -> Result<()> {
    let config = fetch_config()?;
    let status = fetch_status()?;
    engine.observe(&status);
    let cfg = config.lcd.clone();
    engine.sync(&cfg);
    if cfg.mode == LcdMode::Unmanaged {
        // 未托管：屏幕保持设备现在的样子，宿主不送任何帧。
        return Ok(());
    }
    if let Some(jpeg) = engine.next_frame(&cfg, &status, Instant::now(), local_time()) {
        submit(jpeg)?;
        // 送到了：这一帧才算数，下一轮可以准备下一帧。
        engine.committed();
    }
    Ok(())
}

/// 要一份配置。
fn fetch_config() -> Result<Config> {
    match ipc::request(&Request::GetConfig)? {
        Response::Config { config } => Ok(config),
        Response::Error { message } => Err(anyhow!("{message}")),
        other => Err(anyhow!("后台服务回了意外的东西：{other:?}")),
    }
}

/// 要一份状态。
fn fetch_status() -> Result<Status> {
    match ipc::request(&Request::GetStatus)? {
        Response::Status { status } => Ok(status),
        Response::Error { message } => Err(anyhow!("{message}")),
        other => Err(anyhow!("后台服务回了意外的东西：{other:?}")),
    }
}

/// 把一帧交给后台服务（信箱只留最新一帧，宿主推得再快也不会堆积）。
fn submit(jpeg: Vec<u8>) -> Result<()> {
    match ipc::request(&Request::SubmitLcdFrame { jpeg })? {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(anyhow!("{message}")),
        other => Err(anyhow!("后台服务回了意外的东西：{other:?}")),
    }
}
