//! 开机接管：后台服务（用户登录后才启动）还没运行时，按配置里的曲线控制风扇和泵，
//! 免得从开机到登录这段时间设备一直按固件默认值满转。后台服务一出现（它的命名管道建好）就释放设备，
//! 并在传感器管道里报告 `boot_control = false`，后台服务看到后再去打开设备。设备在交接间隙保持最后收到的转速。
//!
//! 只管转速：灯效和屏幕等后台服务接手后再推。用的设置是后台服务同步到 ProgramData 的副本，没有就用默认曲线。

use lcl_core::config::{pump_power_boost, Config, CoolingMode, FanOverride, TempSource, GUARD_FAN_PERCENT, GUARD_HYSTERESIS_C, MIN_FAN_PERCENT, PUMP_MIN_RPM};
use lcl_core::sensors::CpuSensors;
use lcl_core::group_control::{GroupInputs,GroupOutput,GroupRuntime};
use std::collections::HashMap;
use lcl_devices::h2::H2;
use lcl_devices::wireless::{aio_params, RfDevice, Snapshot, Wireless};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_FILE_NOT_FOUND, SYSTEMTIME};
use windows_sys::Win32::System::SystemInformation::GetLocalTime;
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

const TICK: Duration = Duration::from_secs(1);
/// 设备没插好或刚开机还没枚举出来时，隔多久再试。
const REOPEN: Duration = Duration::from_secs(3);
/// 和后台服务一样：冷头 0xFB 写得太勤会卡死，读也不用每秒。
const H2_SYNC_INTERVAL: Duration = Duration::from_millis(3600);
const H2_READ_INTERVAL: Duration = Duration::from_secs(2);
const COOLANT_TAU: Duration = Duration::from_secs(20);
/// 后台服务的命名管道。
const DAEMON_PIPE: &str = r"\\.\pipe\lconnect-lite";

/// 一直接管到后台服务出现或服务停止；`holding` 表示现在是否占着设备（经传感器管道告诉后台服务）。
pub fn run(cpu: &Mutex<CpuSensors>, holding: &AtomicBool, stop: &AtomicBool) {
    let started = Instant::now();
    if daemon_running() {
        log("后台服务已在运行，不接管");
        return;
    }
    let config = Config::load_control_snapshot();
    log(if config.is_some() { "开机接管：按同步过来的设置控制风扇和泵" } else { "开机接管：没有同步过来的设置，用默认曲线" });
    let mut k = Keeper {
        config: config.unwrap_or_default(),
        h2: None,
        wl: None,
        last_open: None,
        last_h2_read: None,
        last_h2_sync: None,
        coolant: None,
        cpu_power: None,
        guard: false,
        logged: (false, false, false),
        started: Instant::now(), group_runtime:HashMap::new(), group_outputs:HashMap::new(),
    };
    while !stop.load(Ordering::SeqCst) && !daemon_running() {
        k.ensure_devices();
        holding.store(k.h2.is_some() || k.wl.is_some(), Ordering::SeqCst);
        let readings = cpu.lock().unwrap().clone();
        k.tick(&readings);
        std::thread::sleep(TICK);
    }
    // 先关设备再报告释放，后台服务看到 false 时设备已经空出来了。
    drop(k);
    holding.store(false, Ordering::SeqCst);
    log(&format!("后台服务已启动，释放设备交给它（接管了 {} 秒）", started.elapsed().as_secs()));
}

/// 记到 %ProgramData%\LConnect Lite\keeper.log（服务以 SYSTEM 运行，没有用户目录）。只记几条关键事件，超过 64 KB 从头写。
fn log(msg: &str) {
    use std::io::Write;
    let path = lcl_core::config::control_snapshot_path().with_file_name("keeper.log");
    let big = std::fs::metadata(&path).is_ok_and(|m| m.len() > 64 * 1024);
    let file = std::fs::OpenOptions::new().create(true).write(true).append(!big).truncate(big).open(&path);
    if let Ok(mut f) = file {
        // SAFETY: GetLocalTime 只写入传入的结构体。
        let t = unsafe {
            let mut t: SYSTEMTIME = std::mem::zeroed();
            GetLocalTime(&mut t);
            t
        };
        let _ = writeln!(f, "{:04}-{:02}-{:02} {:02}:{:02}:{:02} {msg}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    }
}

/// 后台服务在运行：它的命名管道存在。WaitNamedPipe 只查不连，不会占用后台服务的连接。
fn daemon_running() -> bool {
    let name: Vec<u16> = DAEMON_PIPE.encode_utf16().chain([0]).collect();
    // SAFETY: 名字以 0 结尾；最多等 1 ms。
    unsafe { WaitNamedPipeW(name.as_ptr(), 1) != 0 || GetLastError() != ERROR_FILE_NOT_FOUND }
}

struct Keeper {
    config: Config,
    h2: Option<H2>,
    wl: Option<Wireless>,
    last_open: Option<Instant>,
    last_h2_read: Option<Instant>,
    last_h2_sync: Option<Instant>,
    /// 低通滤波后的水温（设备只报整数，和后台服务一样平滑）。
    coolant: Option<f32>,
    cpu_power: Option<f32>,
    guard: bool,
    /// 已记过日志的事件：打开冷头、打开收发器、第一次下发转速。
    logged: (bool, bool, bool),
    started: Instant,
    group_runtime: HashMap<String,GroupRuntime>,
    group_outputs: HashMap<String,GroupOutput>,
}

impl Keeper {
    fn ensure_devices(&mut self) {
        if (self.h2.is_some() && self.wl.is_some()) || self.last_open.is_some_and(|t| t.elapsed() < REOPEN) {
            return;
        }
        self.last_open = Some(Instant::now());
        if self.h2.is_none() {
            self.h2 = H2::open().ok().flatten();
            if self.h2.is_some() && !self.logged.0 {
                self.logged.0 = true;
                log("打开了冷头（USB）");
            }
        }
        if self.wl.is_none() {
            self.wl = Wireless::connect(false).ok().flatten();
            if let (Some(wl), Some(channel)) = (self.wl.as_mut(), self.config.devices.channel) {
                wl.channel = channel;
            }
            if self.wl.is_some() && !self.logged.1 {
                self.logged.1 = true;
                log("打开了无线收发器");
            }
        }
    }

    fn tick(&mut self, cpu: &CpuSensors) {
        let c = &self.config.cooling;
        let snap = self.wl.as_mut().map(|wl| wl.poll().unwrap_or_else(|_| wl.cached()));
        let snap = snap.map(|mut s| {
            // 锁定绑定：只控制锁定列表里的本机设备。
            if let (Some(wl), false) = (&self.wl, self.config.devices.locked.is_empty()) {
                s.devices.retain(|d| d.master != wl.master || self.config.devices.locked.contains(&d.mac_str()));
            }
            s
        });
        let aio = match (&self.wl, &snap) {
            (Some(wl), Some(s)) => wl.own_aio(s).map(|(slot, d)| (slot, d.clone())),
            _ => None,
        };

        // 水温：USB 冷头优先，冷头在无线模式下用 RX 里的记录。
        let mut raw = None;
        if let Some(h2) = self.h2.as_mut() {
            if self.last_h2_read.is_none_or(|t| t.elapsed() >= H2_READ_INTERVAL) {
                self.last_h2_read = Some(Instant::now());
                match h2.get_params() {
                    Ok(p) => raw = Some(f32::from(p.coolant_c)),
                    Err(_) => self.h2 = None,
                }
            }
        }
        let raw = raw.or_else(|| aio.as_ref().and_then(|(_, d)| d.coolant_c()).map(f32::from));
        if let Some(r) = raw {
            self.coolant = Some(match self.coolant {
                Some(prev) => prev + (r - prev) * TICK.as_secs_f32() / (COOLANT_TAU.as_secs_f32() + TICK.as_secs_f32()),
                None => r,
            });
        } else { self.coolant=None; }
        if let Some(p) = cpu.power_w {
            self.cpu_power = Some(match self.cpu_power {
                Some(prev) if p < prev => prev + (p - prev) * 0.05,
                _ => p,
            });
        }

        let square = self.h2.as_ref().is_none_or(|h| h.square);
        let max_pump = if square { 3200.0 } else { 2500.0 };
        // 开机时没有 GPU 读数：按 GPU 温度的曲线退回固定转速。跟随主板时用 RX 采到的主板 PWM。
        let mut fan = match c.mode {
            CoolingMode::Curve if c.fan_source == TempSource::Coolant => self.coolant.and_then(|t| c.fan_curve.eval(t)),
            CoolingMode::Motherboard => snap.as_ref().and_then(|s| s.mb_pwm).filter(|&d| d > 0).map(|d| f32::from(d) * 100.0 / 255.0),
            _ => None,
        }
        .unwrap_or(c.fixed_fan_percent)
        .clamp(MIN_FAN_PERCENT, 100.0);
        let mut pump = match c.mode {
            CoolingMode::Curve => self.coolant.and_then(|t| c.pump_curve.eval(t)).map(|p| p + self.cpu_power.map_or(0.0, |w| pump_power_boost(w, c.pump_power_boost_rpm))),
            _ => None,
        }
        .unwrap_or(c.fixed_pump_rpm);
        self.guard = match (c.cpu_temp_limit_c > 0.0, cpu.temp_c) {
            (true, Some(t)) if t >= c.cpu_temp_limit_c => true,
            (true, Some(t)) if self.guard && t > c.cpu_temp_limit_c - GUARD_HYSTERESIS_C => true,
            (true,None)=>self.guard,
            _ => false,
        };
        if self.guard {
            pump = max_pump;
            fan = fan.max(GUARD_FAN_PERCENT);
        }
        let pump = pump.clamp(PUMP_MIN_RPM, max_pump).round() as u16;
        self.group_outputs.clear();
        for p in &c.groups {
            let inputs=GroupInputs{cpu:cpu.temp_c,gpu:None,coolant:self.coolant,motherboard:snap.as_ref().and_then(|s|s.mb_pwm).filter(|d|*d>0).map(|v|v as f32*100.0/255.0),guard:self.guard};
            let o=self.group_runtime.entry(p.address.clone()).or_default().evaluate(p,inputs,self.started.elapsed().as_secs_f64(),1.0);
            self.group_outputs.insert(p.address.clone(),o);
        }
        let out = Outputs { fan, pump, square, overrides: &c.fan_overrides,groups:&self.group_outputs,guard:self.guard };
        if !self.logged.2 && (self.h2.is_some() || self.wl.is_some()) {
            self.logged.2 = true;
            let water = self.coolant.map_or("—".to_string(), |t| format!("{t:.0}"));
            log(&format!("下发转速：水温 {water} °C → 风扇 {fan:.0}%、泵 {pump} rpm"));
        }

        if let (Some(wl), Some(s)) = (self.wl.as_mut(), snap.as_ref()) {
            if drive_wireless(wl, s, aio.as_ref(), &out).is_err() {
                self.wl = None;
            }
        }
        if aio.is_none() {
            if let Some(h2) = self.h2.as_mut() {
                if self.last_h2_sync.is_none_or(|t| t.elapsed() >= H2_SYNC_INTERVAL) {
                    self.last_h2_sync = Some(Instant::now());
                    if h2.sync_pump_fan(pump, [out.duty(fan); 3]).is_err() {
                        self.h2 = None;
                    }
                }
            }
        }
    }
}

struct Outputs<'a> {
    fan: f32,
    pump: u16,
    square: bool,
    overrides: &'a [FanOverride],
    groups: &'a HashMap<String,GroupOutput>,
    guard: bool,
}

impl Outputs<'_> {
    fn duty(&self, percent: f32) -> u8 {
        (percent.clamp(MIN_FAN_PERCENT, 100.0) * 255.0 / 100.0).round() as u8
    }

    /// 和后台服务一样：单个风扇有固定值用固定值，否则整体值加偏移。
    fn fan_duty(&self, address: &str, index: usize) -> u8 {
        let percent = if let Some(g)=self.groups.get(address) {g.percent} else {match self.overrides.iter().find(|o| o.address == address && usize::from(o.index) == index) {
            Some(FanOverride { fixed_percent: Some(f), .. }) => *f,
            Some(o) => self.fan + o.offset_percent,
            None => self.fan,
        }};
        self.duty(if self.guard{percent.max(GUARD_FAN_PERCENT)}else{percent})
    }
}

/// 和后台服务的 drive_wireless 一致：冷头无线模式下泵速只走参数块，风扇按 PWM 帧。
fn drive_wireless(wl: &mut Wireless, snap: &Snapshot, aio: Option<&(u8, RfDevice)>, out: &Outputs) -> anyhow::Result<()> {
    wl.send_clock()?;
    if let Some((slot, dev)) = aio {
        wl.set_aio_params(dev, &aio_params(out.pump, out.square))?;
        if dev.fan_count > 0 {
            let a = dev.mac_str();
            wl.set_pwm(dev, *slot, [out.fan_duty(&a, 0), out.fan_duty(&a, 1), out.fan_duty(&a, 2), dev.pwm[3]])?;
        }
    }
    let targets: Vec<(u8, RfDevice)> = wl.own_devices(snap).into_iter().filter(|(_, d)| d.supports_fan_control()).map(|(s, d)| (s, d.clone())).collect();
    for (slot, dev) in targets {
        let a = dev.mac_str();
        let percent=out.groups.get(&a).map_or(out.fan,|g|g.percent);
        wl.set_pwm(&dev,slot,[out.duty(if out.guard{percent.max(GUARD_FAN_PERCENT)}else{percent});4])?;
    }
    Ok(())
}
