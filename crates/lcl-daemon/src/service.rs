//! 后台服务：独占设备，每秒一轮控制循环，状态和配置通过命名管道给 GUI。

use crate::cpu::CpuUsage;
use lcl_core::group_control::{GroupInputs,GroupOutput,GroupRuntime,GroupSource};
use std::collections::HashMap;
use crate::h2slot::H2Slot;
use crate::lcd;
use crate::lighting::LightingCtl;
use lcl_core::gpu::Gpu;
use lcl_core::ipc::{History, LightingCaps};
use crate::{autostart, log, tray};
use anyhow::{Context, Result};
use lcl_core::config::{
    boost, pump_power_boost, CoolingMode, FanOverride, TempSource, GUARD_FAN_PERCENT, GUARD_HYSTERESIS_C, MIN_FAN_PERCENT, PUMP_MIN_RPM,
};
use lcl_core::sensors::{self, CpuSensors};
use lcl_core::{ipc, Config, DeviceInfo, FanGroup, Request, Response, Status, WirelessDevice};
use std::sync::mpsc;
use lcl_devices::h2::{H2Params, H2};
use lcl_devices::wireless::{aio_params, fmt_mac, Snapshot, Wireless};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_secs(1);
/// 冷头固件在更频繁的 0xFB 写入下会卡死，官方也是约 3.6 秒一次。
const H2_SYNC_INTERVAL: Duration = Duration::from_millis(3600);
const H2_READ_INTERVAL: Duration = Duration::from_secs(2);
/// 设备没插或打开失败后，隔多久再试。
const REOPEN_INTERVAL: Duration = Duration::from_secs(5);
/// 水温低通滤波的时间常数。设备只报整数 °C，在两个值之间来回跳会让风扇目标抖动；
/// 冷却液本身的时间常数是分钟量级，20 秒的滤波不影响响应。
const COOLANT_TAU: Duration = Duration::from_secs(20);
/// CPU 功耗平滑：上升时快（负载一来泵就跟上），下降时慢（短暂停顿不让泵忽快忽慢）。
const CPU_POWER_TAU_UP: Duration = Duration::from_secs(2);
const CPU_POWER_TAU_DOWN: Duration = Duration::from_secs(20);
/// 主板 PWM 采样多久没更新就当作没有信号。
const MB_PWM_STALE: Duration = Duration::from_secs(5);
/// 加载 NVML 失败（没有 N 卡）后隔多久再试。
const GPU_RETRY: Duration = Duration::from_secs(30);

struct Shared {
    status: Status,
    config: Config,
    lcd: lcd::LcdState,
    lcd_frame: Option<Vec<u8>>,
    ring88: lcl_core::status::Ring88Status,
    /// 最近 2 分钟的读数：界面打开时走势图直接是满的。
    history: History,
    /// 界面排队的设备操作，控制线程每轮开始时取走执行，结果从通道传回。
    ops: Vec<(DeviceOp, mpsc::Sender<Result<(), String>>)>,
}

enum DeviceOp {
    Bind([u8; 6]),
    Unbind([u8; 6]),
    MbLightSync([u8; 6], bool),
    Channel(u8),
    Identify([u8;6]),
}

/// 设备操作要等控制线程执行；绑定最多 5 秒收敛再加保存，给足余量。
const OP_TIMEOUT: Duration = Duration::from_secs(15);
/// 切换频道要逐个设备收敛，失败时还要回退，按设备数放宽。
const CHANNEL_OP_TIMEOUT: Duration = Duration::from_secs(90);

pub fn serve(devices_enabled: bool) -> Result<()> {
    if !single_instance() {
        // 安装程序、界面、开机自启可能同时拉起后台服务；已经有一个在运行就直接退出，不去碰设备。
        return Ok(());
    }
    let config = Config::load_or_create()?;
    sync_control_snapshot(&config);
    log::line(&format!(
        "后台服务启动{}；配置 {}",
        if devices_enabled { "" } else { "（不打开设备）" },
        Config::path().display()
    ));
    let shared = Arc::new(Mutex::new(Shared {
        status: Status::default(),
        config,
        lcd: lcd::LcdState::default(),
        lcd_frame:None,
        ring88:lcl_core::status::Ring88Status{external_display:true,..Default::default()},
        history: History::default(),
        ops: Vec::new(),
    }));

    {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            if let Err(e) = ipc::serve(move |req| handle(&shared, req)) {
                log::line(&format!("命名管道服务退出：{e:#}"));
                std::process::exit(1);
            }
        });
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        // 没有控制台（release 版双击启动）时注册会失败，不影响运行。
        let _ = ctrlc::set_handler(move || stop.store(true, Ordering::SeqCst));
    }

    let h2 = Arc::new(H2Slot::default());
    let control = {
        let (shared, stop, h2) = (Arc::clone(&shared), Arc::clone(&stop), Arc::clone(&h2));
        std::thread::spawn(move || control_loop(&shared, &stop, devices_enabled, h2))
    };
    let screen = {
        let (shared, stop, h2) = (Arc::clone(&shared), Arc::clone(&stop), Arc::clone(&h2));
        std::thread::spawn(move || {
            lcd::run(
                &h2,
                &stop,
                || {
                    let mut s = shared.lock().unwrap();
                    (s.config.lcd.clone(), s.lcd_frame.take())
                },
                |state| {
                    let mut s = shared.lock().unwrap();
                    s.lcd = state;
                },
            )
        })
    };
    let ring = {
        let (shared,stop)=(Arc::clone(&shared),Arc::clone(&stop));
        std::thread::spawn(move || crate::ring_service::run(&stop,devices_enabled,
            || shared.lock().unwrap().config.ring88.clone(),
            |status| shared.lock().unwrap().ring88=status))
    };
    tray::run(&TrayHost(Arc::clone(&shared)), &stop);
    stop.store(true, Ordering::SeqCst);
    let _ = control.join();
    let _ = screen.join();
    let _ = ring.join();
    log::line("后台服务已停止，设备保持最后收到的转速");
    Ok(())
}

/// 用命名互斥量保证同一会话里只有一个后台服务。互斥量随进程退出释放，句柄故意不关。
fn single_instance() -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = "Local\\LConnectLiteDaemon".encode_utf16().chain([0]).collect();
    // SAFETY: 名字以 0 结尾；只创建一个互斥量对象。
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        // 创建失败（极少见）时照常运行，退化成以前的行为。
        handle.is_null() || GetLastError() != ERROR_ALREADY_EXISTS
    }
}

fn control_loop(shared: &Mutex<Shared>, stop: &AtomicBool, devices_enabled: bool, h2: Arc<H2Slot>) {
    let mut ctl = Controller::new(devices_enabled, h2);
    let mut last_error: Option<String> = None;
    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();
        let (config, ops) = {
            let mut s = shared.lock().unwrap();
            (s.config.clone(), std::mem::take(&mut s.ops))
        };
        ctl.run_ops(ops);
        let status = ctl.tick(&config);
        // 同样的错误每秒都会出现，只在内容变化时记一次。
        if status.last_error != last_error {
            match &status.last_error {
                Some(e) => log::line(e),
                None if last_error.is_some() => log::line("错误已恢复"),
                None => {}
            }
            last_error = status.last_error.clone();
        }
        {
            let mut s = shared.lock().unwrap();
            s.history.push(&status);
            s.status = status;
        }
        sleep(TICK.saturating_sub(tick.elapsed()));
    }
}

/// 切换成功后把新频道记进配置，重启后照用。
fn set_channel(shared: &Mutex<Shared>, channel: u8) -> Result<()> {
    run_op(shared, DeviceOp::Channel(channel), CHANNEL_OP_TIMEOUT)?;
    let mut config = shared.lock().unwrap().config.clone();
    config.devices.channel = Some(channel);
    apply_config(shared, config)
}

fn apply_config(shared: &Mutex<Shared>, mut config: Config) -> Result<()> {
    config.validate()?;
    config.normalize();
    config.save()?;
    sync_control_snapshot(&config);
    shared.lock().unwrap().config = config;
    Ok(())
}

/// 同步一份配置给传感器系统服务（开机到登录前由它按曲线控制）。写不了只记日志，不影响保存。
fn sync_control_snapshot(config: &Config) {
    if let Err(e) = config.save_control_snapshot() {
        log::line(&format!("开机接管用的配置副本没写成（{e:#}），开机时会用默认曲线"));
    }
}

/// 把设备操作交给控制线程，等它执行完。
fn queue_op(shared: &Mutex<Shared>, address: &str, make: impl FnOnce([u8; 6]) -> DeviceOp) -> Result<()> {
    let mac = lcl_core::parse_mac(address).with_context(|| format!("无效的设备地址：{address}"))?;
    run_op(shared, make(mac), OP_TIMEOUT)
}

fn run_op(shared: &Mutex<Shared>, op: DeviceOp, timeout: Duration) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    shared.lock().unwrap().ops.push((op, tx));
    match rx.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(anyhow::anyhow!(e)),
        Err(_) => Err(anyhow::anyhow!("操作超时（后台服务忙或设备没有响应）")),
    }
}

/// Header-level size/type validation without loading an image decoder into daemon.
fn valid_jpeg_frame(b:&[u8])->bool {
    if b.len()<12 || b.len()>512000 || b[..2]!=[0xff,0xd8] || b[b.len()-2..]!=[0xff,0xd9] {return false;}
    let mut p=2usize;
    while p+4<=b.len() {
        if b[p]!=0xff{return false;}
        let marker=b[p+1];p+=2;
        let n=u16::from_be_bytes([b[p],b[p+1]]) as usize;
        if n<2 || p+n>b.len(){return false;}
        if marker==0xc0 {
            return n>=11 && matches!(b[p+7],1|3) && n==8+3*usize::from(b[p+7]) && b[p+2]==8 && u16::from_be_bytes([b[p+3],b[p+4]])==480 && u16::from_be_bytes([b[p+5],b[p+6]])==480;
        }
        if marker==0xda || marker==0xd9{return false;}
        p+=n;
    }
    false
}

fn handle(shared: &Mutex<Shared>, req: Request) -> Response {
    let result = match req {
        Request::GetStatus => {
            let s=shared.lock().unwrap();
            let mut status=s.status.clone();status.ring88=s.ring88.clone();
            return Response::Status { status }
        }
        Request::SubmitLcdFrame { jpeg } => {
            if !valid_jpeg_frame(&jpeg) {return Response::Error{message:"帧必须是小于512KB的480×480基线JPEG".into()};}
            let mut s=shared.lock().unwrap();
            if s.config.lcd.mode==lcl_core::LcdMode::Unmanaged {return Response::Error{message:"冷头屏幕为外部未接管模式".into()};}
            s.lcd_frame=Some(jpeg);
            Ok(())
        }
        Request::GetConfig => {
            return Response::Config {
                config: shared.lock().unwrap().config.clone(),
            }
        }
        Request::GetAutostart => {
            return Response::Autostart {
                enabled: autostart::is_enabled(),
            }
        }
        Request::GetGroupLightingCaps { address } => {
            let s=shared.lock().unwrap();
            let Some(g)=s.status.fan_groups.iter().find(|g|g.address.eq_ignore_ascii_case(&address) && g.supports_control) else {return Response::Error{message:"设备离线或不支持灯效".into()};};
            let fan_count=g.rpm.len().clamp(1,4) as u8;
            return Response::LightingCaps{caps:LightingCaps{fan_count,fans:lcl_effects::tl::parameters::for_fans(fan_count),pump:lcl_effects::h2::parameters()}};
        }
        Request::RenameDevice { address, name } => {
            let mac=match lcl_core::parse_mac(&address){Some(m)=>m,None=>return Response::Error{message:"无效设备地址".into()}};
            let mut cfg=shared.lock().unwrap().config.clone();
            if name.trim().is_empty(){cfg.devices.aliases.remove(&lcl_devices::wireless::fmt_mac(&mac));}
            else {cfg.devices.aliases.insert(lcl_devices::wireless::fmt_mac(&mac),name.trim().to_owned());}
            apply_config(shared,cfg)
        }
        Request::IdentifyDevice { address } => queue_op(shared,&address,DeviceOp::Identify),
        Request::GetLightingCaps => {
            let fan_count = shared.lock().unwrap().status.fan_groups.first().map_or(3, |g| g.rpm.len()) as u8;
            return Response::LightingCaps {
                caps: LightingCaps {
                    fan_count,
                    fans: lcl_effects::tl::parameters::for_fans(fan_count),
                    pump: lcl_effects::h2::parameters(),
                },
            };
        }
        Request::GetLcdState => {
            let s = shared.lock().unwrap();
            return Response::LcdState {
                state: lcl_core::ipc::LcdState {
                    description: s.lcd.description.clone(),
                    error: s.lcd.error.clone(),
                    preview_jpeg_base64: s.lcd.preview.as_deref().map(lcl_core::base64),
                },
            };
        }
        Request::GetHistory => {
            return Response::History {
                history: shared.lock().unwrap().history.clone(),
            }
        }
        Request::Bind { address } => queue_op(shared, &address, DeviceOp::Bind),
        Request::Unbind { address } => queue_op(shared, &address, DeviceOp::Unbind),
        Request::SetMbLightSync { address, enabled } => queue_op(shared, &address, |mac| DeviceOp::MbLightSync(mac, enabled)),
        Request::SetChannel { channel } => set_channel(shared, channel),
        Request::SetConfig { config } => apply_config(shared, config),
        Request::SetAutostart { enabled } => autostart::set(enabled),
    };
    match result {
        Ok(()) => Response::Ok,
        Err(e) => Response::Error {
            message: format!("{e:#}"),
        },
    }
}

struct TrayHost(Arc<Mutex<Shared>>);

impl tray::Host for TrayHost {
    fn snapshot(&self) -> (Status, Config) {
        let s = self.0.lock().unwrap();
        (s.status.clone(), s.config.clone())
    }

    fn set_config(&self, config: Config) {
        if let Err(e) = apply_config(&self.0, config) {
            log::line(&format!("托盘切换预设失败：{e:#}"));
        }
    }
}

struct Controller {
    started: Instant,
    devices_enabled: bool,
    h2: Arc<H2Slot>,
    wl: Option<Wireless>,
    last_open: Option<Instant>,
    h2_params: Option<H2Params>,
    last_h2_read: Option<Instant>,
    last_h2_sync: Option<Instant>,
    /// 经过限速后实际下发的风扇占空比（%）。
    fan_percent: Option<f32>,
    cpu: CpuUsage,
    cpu_usage: Option<f32>,
    gpu: Option<Gpu>,
    gpu_open_tried: Option<Instant>,
    coolant_filtered: Option<f32>,
    lighting: LightingCtl,
    /// 锁定过滤之前的这一轮无线快照，给状态里的“全部设备”列表用。
    last_full: Option<Snapshot>,
    wireless_poll_error: Option<String>,
    last_rx_layout: String,
    /// 最近一次有效的主板 PWM 采样（RX 偶尔回坏包时用缓存，不带这个值）。
    mb_pwm: Option<(u8, Instant)>,
    errors: Vec<String>,
    /// 新连上的发射器还没换到配置里记的频道。只在连上时换一次：切换频道操作成功后、配置写入前，
    /// 不能被每轮的配置覆盖回去。
    channel_pending: bool,
    /// 最近一次读到的 CPU 温度 / 功耗（lcl-sensord），以及读不到的原因。
    cpu_sensors: Option<(CpuSensors, Instant)>,
    cpu_sensor_error: Option<String>,
    /// 平滑后的 CPU 功耗：上升快、下降慢，泵不会跟着瞬时尖峰来回变。
    cpu_power: Option<f32>,
    /// CPU 温度保护是否在生效（带回差）。
    cpu_guard: bool,
    /// 已经记过“传感器服务在开机接管”的日志。
    keeper_seen: bool,
    group_runtime: HashMap<String,GroupRuntime>,
    group_outputs: HashMap<String,GroupOutput>,
    identified_at: HashMap<[u8;6],Instant>,
}

impl Controller {
    fn new(devices_enabled: bool, h2: Arc<H2Slot>) -> Self {
        Self {
            started: Instant::now(),
            devices_enabled,
            h2,
            wl: None,
            last_open: None,
            h2_params: None,
            last_h2_read: None,
            last_h2_sync: None,
            fan_percent: None,
            cpu: CpuUsage::default(),
            cpu_usage: None,
            gpu: None,
            gpu_open_tried: None,
            coolant_filtered: None,
            lighting: LightingCtl::default(),
            last_full: None,
            wireless_poll_error: None,
            last_rx_layout: String::new(),
            mb_pwm: None,
            errors: Vec::new(),
            channel_pending: false,
            cpu_sensors: None,
            cpu_sensor_error: None,
            cpu_power: None,
            cpu_guard: false,
            keeper_seen: false,
            group_runtime: HashMap::new(),
            group_outputs: HashMap::new(),
            identified_at: HashMap::new(),
        }
    }

    /// 只有用得到 GPU 读数时（风扇曲线按 GPU 温度、GPU 前馈、屏幕仪表盘）才加载 NVML。
    /// nvml.dll 加载后卸不掉、要占约 20 MB，所以默认的水温控制下后台服务不碰它；
    /// 界面显示的 GPU 读数由界面进程自己读。
    fn update_gpu(&mut self, config: &Config) {
        let c = &config.cooling;
        let needed = (c.mode == CoolingMode::Curve && (c.fan_source == TempSource::Gpu || c.gpu_boost_percent > 0.0))
            || config.lcd.mode == lcl_core::LcdMode::Dashboard
            || c.groups.iter().any(|g|g.mode==CoolingMode::Curve && g.source==GroupSource::Gpu);
        // 没有 N 卡时别每秒都去试。
        if needed && self.gpu.is_none() && self.gpu_open_tried.map_or(true, |t| t.elapsed() >= GPU_RETRY) {
            self.gpu_open_tried = Some(Instant::now());
            self.gpu = Gpu::open();
            log::line(if self.gpu.is_some() { "已加载 NVML" } else { "没有可用的 NVIDIA GPU" });
        }
    }

    fn tick(&mut self, config: &Config) -> Status {
        self.update_gpu(config);
        self.errors.clear();
        self.cpu_usage = self.cpu.sample();
        let (cpu_temp, cpu_power_raw) = self.read_cpu_sensors();
        self.cpu_power = match (self.cpu_power, cpu_power_raw) {
            (Some(prev), Some(p)) => Some(low_pass(prev, p, TICK, if p > prev { CPU_POWER_TAU_UP } else { CPU_POWER_TAU_DOWN })),
            (_, p) => p,
        };
        // 开机接管：传感器服务还占着冷头和收发器时先不打开（WinUSB 只能一个程序用）。
        // 它看到我们的命名管道就会释放，下一轮再接手；交接间隙设备保持当前转速。
        let keeper_holding = self.cpu_sensors.as_ref().is_some_and(|(s, _)| s.boot_control);
        if keeper_holding {
            if !self.keeper_seen {
                log::line("传感器服务正在开机接管风扇和泵，等它释放设备后接手");
                self.keeper_seen = true;
            }
        } else {
            self.ensure_devices();
        }
        if self.channel_pending {
            self.channel_pending = false;
            if let (Some(wl), Some(channel)) = (self.wl.as_mut(), config.devices.channel) {
                wl.channel = channel;
            }
        }

        let full = self.poll_wireless();
        self.last_full = full.clone();
        // 锁定绑定：本机设备里只保留锁定列表中的，其余一律不碰（槽位也按保留下来的重新编号，和官方一致）。
        let snap = full.map(|mut s| {
            if let (Some(wl), false) = (&self.wl, config.devices.locked.is_empty()) {
                s.devices.retain(|d| d.master != wl.master || config.devices.locked.contains(&d.mac_str()));
            }
            s
        });
        let aio = match (&self.wl, &snap) {
            (Some(wl), Some(snap)) => wl.own_aio(snap).map(|(slot, d)| (slot, d.clone())),
            _ => None,
        };
        self.read_h2();

        // 水温：优先用冷头 USB 读数，没有就用无线记录里的。
        let coolant_raw = self
            .h2_params
            .as_ref()
            .map(|p| f32::from(p.coolant_c))
            .filter(|&c| c > 0.0)
            .or_else(|| aio.as_ref().and_then(|(_, d)| d.coolant_c()).map(f32::from));
        self.coolant_filtered = match (coolant_raw, self.coolant_filtered) {
            (Some(raw), Some(prev)) => Some(low_pass(prev, raw, TICK, COOLANT_TAU)),
            (raw, _) => raw,
        };
        let coolant = self.coolant_filtered;

        let gpu = self.gpu.as_ref().map(Gpu::sample).unwrap_or_default();
        // 没接信号线时 RX 有时报 0% 而不是“无信号”；真实的主板 PWM 不会是 0，按无信号处理。
        if let Some(d) = snap.as_ref().and_then(|s| s.mb_pwm).filter(|&d| d > 0) {
            self.mb_pwm = Some((d, Instant::now()));
        }
        let mb_percent = self
            .mb_pwm
            .filter(|(_, at)| at.elapsed() < MB_PWM_STALE)
            .map(|(d, _)| f32::from(d) * 100.0 / 255.0);

        let square = self.h2.lock().as_ref().map_or(true, |h| h.square);
        let max_pump = if square { 3200.0 } else { 2500.0 };
        let c = &config.cooling;
        let fan_temp = match c.fan_source {
            TempSource::Coolant => coolant,
            TempSource::Gpu => gpu.temp_c,
        };
        let has_cooler=self.h2.lock().is_some() || aio.is_some();
        let needs_global_fan=has_cooler || snap.as_ref().is_some_and(|s|s.devices.iter().any(|d|d.supports_fan_control() && !c.groups.iter().any(|g|g.address==d.mac_str())));
        let fan_curve_target = match (c.mode, fan_temp) {
            (CoolingMode::Curve, Some(t)) => c.fan_curve.eval(t),
            (CoolingMode::Curve, None) => {
                if needs_global_fan {self.errors.push(format!("没有{}读数，未独立配置的风扇组暂用固定值", temp_source_name(c.fan_source)));}
                None
            }
            (CoolingMode::Motherboard, _) => {
                if needs_global_fan && mb_percent.is_none() {
                    self.errors.push("没有采样到主板 PWM（RX 没接信号线？），风扇暂用固定值".into());
                }
                mb_percent
            }
            (CoolingMode::Fixed, _) => None,
        };
        let pump_target = match (c.mode, coolant) {
            (CoolingMode::Curve, Some(t)) => c.pump_curve.eval(t),
            (CoolingMode::Curve, None) => {
                if has_cooler {self.errors.push("没有水温读数，泵暂用固定值".into());}
                None
            }
            _ => None,
        };
        // 前馈只叠加在曲线输出上；固定和跟随主板模式不加。
        let boost = if c.mode == CoolingMode::Curve {
            boost(self.cpu_usage.unwrap_or(0.0), c.cpu_boost_percent) + boost(gpu.usage.unwrap_or(0.0), c.gpu_boost_percent)
        } else {
            0.0
        };
        let mut fan_target = (fan_curve_target.unwrap_or(c.fixed_fan_percent) + boost).clamp(MIN_FAN_PERCENT, 100.0);
        // 泵的功耗前馈：只叠加在曲线上，功耗一上来泵就加速，不等水温。
        let pump_boost = (c.mode == CoolingMode::Curve && c.pump_power_boost_rpm > 0.0)
            .then(|| self.cpu_power.map(|p| pump_power_boost(p, c.pump_power_boost_rpm)))
            .flatten();
        let mut pump_rpm_f = pump_target.unwrap_or(c.fixed_pump_rpm) + pump_boost.unwrap_or(0.0);

        // CPU 温度保护（所有控制方式下都生效）：到上限泵拉满、风扇至少 GUARD_FAN_PERCENT，降过回差才恢复。
        let guard = match (c.cpu_temp_limit_c > 0.0, cpu_temp) {
            (true, Some(t)) if t >= c.cpu_temp_limit_c => true,
            (true, Some(t)) if self.cpu_guard && t > c.cpu_temp_limit_c - GUARD_HYSTERESIS_C => true,
            (true,None) => self.cpu_guard, // never clear an active thermal guard on sensor loss
            _ => false,
        };
        if guard != self.cpu_guard {
            log::line(&match (guard, cpu_temp) {
                (true, Some(t)) => format!("CPU 温度 {t:.0} °C 到上限 {:.0} °C：泵拉满、风扇提速", c.cpu_temp_limit_c),
                _ => format!("CPU 温度降到 {} °C 以下，恢复正常控制", (c.cpu_temp_limit_c - GUARD_HYSTERESIS_C).round()),
            });
            self.cpu_guard = guard;
        }
        if guard {
            pump_rpm_f = max_pump;
            fan_target = fan_target.max(GUARD_FAN_PERCENT);
        }
        let pump_rpm = pump_rpm_f.clamp(PUMP_MIN_RPM, max_pump).round() as u16;

        // 温度保护时风扇提速不受限速约束太久：至少每秒 20 个百分点。
        let slew = if guard { c.fan_slew_percent_per_s.max(20.0) } else { c.fan_slew_percent_per_s };
        let step = slew * TICK.as_secs_f32();
        let fan = match self.fan_percent {
            Some(prev) => prev + (fan_target - prev).clamp(-step, step),
            None => fan_target,
        };
        self.fan_percent = Some(fan);

        self.group_outputs.clear();
        self.group_runtime.retain(|a,_|c.groups.iter().any(|g|&g.address==a));
        for policy in &c.groups {
            let inputs=GroupInputs{cpu:cpu_temp,gpu:gpu.temp_c,coolant,motherboard:mb_percent,guard};
            let result=self.group_runtime.entry(policy.address.clone()).or_default().evaluate(policy,inputs,self.started.elapsed().as_secs_f64(),TICK.as_secs_f32());
            if let Some(e)=&result.source_error {self.errors.push(format!("{}：{e}",config.devices.aliases.get(&policy.address).unwrap_or(&policy.address)));}
            self.group_outputs.insert(policy.address.clone(),result);
        }
        if let (Some(wl), Some(snap)) = (self.wl.as_mut(), snap.as_ref()) {
            let out = Outputs { fan, pump_rpm, square, overrides: &c.fan_overrides, groups: &self.group_outputs, guard };
            match drive_wireless(wl, snap, aio.as_ref(), &out) {
                Ok(()) => self.lighting.drive_fans(&config.lighting, wl, snap, &mut self.errors),
                Err(e) => {
                    self.errors.push(format!("无线：{e:#}"));
                    self.wl = None;
                }
            }
        }
        if aio.is_none() {
            let mut slot = self.h2.lock();
            if let Some(h2) = slot.as_mut() {
                match self.lighting.drive_pump(&config.lighting, h2, &mut self.errors) {
                    // 推送灯圈后冷头重新初始化过：马上重发泵速，屏幕也要重推。
                    Ok(true) => {
                        self.last_h2_sync = None;
                        self.h2.bump();
                    }
                    Ok(false) => {}
                    Err(e) => {
                        self.errors.push(format!("冷头灯效推送：{e:#}"));
                        *slot = None;
                        self.h2_params = None;
                    }
                }
            }
            drop(slot);
            self.sync_h2(pump_rpm, percent_to_duty(fan));
        }

        let mut status = self.status(config, coolant, pump_rpm, fan, snap.as_ref(), aio.is_some());
        status.coolant_raw_c = coolant_raw;
        status.gpu_temp_c = gpu.temp_c;
        status.gpu_usage = gpu.usage;
        status.gpu_power_w = gpu.power_w;
        status.mb_pwm_percent = mb_percent;
        status.boost_percent = Some(boost);
        status.cpu_temp_c = cpu_temp;
        status.cpu_power_w = cpu_power_raw;
        status.cpu_sensor_error = self.cpu_sensor_error.clone();
        status.cpu_guard = guard;
        status.pump_boost_rpm = pump_boost;
        // 开机接管期间还没拿到设备，这一轮算出来的“没有水温读数”之类不是真问题，不报。
        if keeper_holding {
            status.last_error = None;
        }
        status
    }

    /// 向 lcl-sensord 要 CPU 温度和功耗。服务偶尔忙（一次只接一个连接），3 秒内用上一次的读数。
    fn read_cpu_sensors(&mut self) -> (Option<f32>, Option<f32>) {
        match sensors::read() {
            Some(s) => {
                self.cpu_sensor_error = s.error.clone().filter(|_| s.temp_c.is_none());
                self.cpu_sensors = Some((s, Instant::now()));
            }
            None => {
                if self.cpu_sensors.as_ref().is_none_or(|(_, at)| at.elapsed() > Duration::from_secs(3)) {
                    self.cpu_sensors = None;
                    self.cpu_sensor_error = Some("传感器服务没有运行（LConnectLiteSensors）".into());
                }
            }
        }
        self.cpu_sensors.as_ref().map_or((None, None), |(s, _)| (s.temp_c, s.power_w))
    }

    fn ensure_devices(&mut self) {
        if !self.devices_enabled {
            self.errors.push("设备已禁用（--no-devices）".into());
            return;
        }
        let h2_open = self.h2.lock().is_some();
        if h2_open && self.wl.is_some() {
            return;
        }
        if self.last_open.is_some_and(|t| t.elapsed() < REOPEN_INTERVAL) {
            return;
        }
        self.last_open = Some(Instant::now());
        if !h2_open {
            match H2::open() {
                Ok(Some(h2)) => {
                    *self.h2.lock() = Some(h2);
                    self.h2.bump();
                }
                Ok(None) => {}
                Err(e) => self.errors.push(format!("冷头：{e:#}")),
            }
        }
        if self.wl.is_none() {
            match Wireless::connect(false) {
                Ok(wl) => {
                    self.channel_pending = wl.is_some();
                    self.wl = wl;
                }
                Err(e) => self.errors.push(format!("无线：{e:#}")),
            }
        }
    }

    fn poll_wireless(&mut self) -> Option<Snapshot> {
        let wl = self.wl.as_mut()?;
        // 缓存兜底仍然保留，但不能吞掉读取故障，否则无法区分 USB 读坏和 RF 设备失联。
        let snap = match wl.poll() {
            Ok(snap) => {
                if self.wireless_poll_error.take().is_some() {
                    log::line("无线 RX 读取已恢复");
                }
                snap
            }
            Err(e) => {
                let message = format!("{e:#}");
                if self.wireless_poll_error.as_ref() != Some(&message) {
                    log::line(&format!("无线 RX 读取失败（使用限时缓存）：{message}"));
                }
                self.wireless_poll_error = Some(message);
                wl.cached()
            }
        };
        if self.last_rx_layout != wl.rx_diagnostic() {
            self.last_rx_layout = wl.rx_diagnostic().to_owned();
            log::line(&format!("无线 RX 原始记录布局：{}", self.last_rx_layout));
        }
        let old = self.last_full.as_ref().map(|s| s.devices.as_slice()).unwrap_or(&[]);
        for dev in &snap.devices {
            if !old.iter().any(|d| d.mac == dev.mac && d.master == dev.master) {
                log::line(&format!("无线设备出现 {}：{}，风扇 {} 只，rx {}，频道 {}，主机 {}", dev.mac_str(), dev.kind(), dev.fan_count, dev.rx_type, dev.channel, fmt_mac(&dev.master)));
            }
        }
        for dev in old {
            if !snap.devices.iter().any(|d| d.mac == dev.mac && d.master == dev.master) {
                log::line(&format!("无线设备记录过期或归属改变 {}（15 秒未收到有效记录）；上次 rx {}，频道 {}", dev.mac_str(), dev.rx_type, dev.channel));
            }
        }
        Some(snap)
    }

    fn read_h2(&mut self) {
        let mut slot = self.h2.lock();
        let Some(h2) = slot.as_mut() else { return };
        if self.last_h2_read.is_some_and(|t| t.elapsed() < H2_READ_INTERVAL) {
            return;
        }
        self.last_h2_read = Some(Instant::now());
        match h2.get_params() {
            Ok(p) => self.h2_params = Some(p),
            Err(e) => {
                self.errors.push(format!("冷头读取：{e:#}"));
                self.h2_params = None;
                *slot = None;
            }
        }
    }

    fn sync_h2(&mut self, pump_rpm: u16, fan_duty: u8) {
        let mut slot = self.h2.lock();
        let Some(h2) = slot.as_mut() else { return };
        if self.last_h2_sync.is_some_and(|t| t.elapsed() < H2_SYNC_INTERVAL) {
            return;
        }
        self.last_h2_sync = Some(Instant::now());
        if let Err(e) = h2.sync_pump_fan(pump_rpm, [fan_duty; 3]) {
            self.errors.push(format!("冷头设定：{e:#}"));
            *slot = None;
        }
    }

    fn status(
        &self,
        config: &Config,
        coolant: Option<f32>,
        pump_target: u16,
        fan: f32,
        snap: Option<&Snapshot>,
        h2_wireless: bool,
    ) -> Status {
        let mut devices = Vec::new();
        let mut fan_groups = Vec::new();
        let mut pump_rpm = self.h2_params.as_ref().map(|p| p.pump_rpm);

        if let Some(h2) = self.h2.lock().as_ref() {
            devices.push(DeviceInfo {
                name: format!("隐流二代 {}", if h2.square { "LCD-S" } else { "LCD-C" }),
                connection: if h2_wireless { "USB + 无线" } else { "USB" }.into(),
                address: self
                    .h2_params
                    .as_ref()
                    .and_then(|p| p.mac)
                    .map(|m| fmt_mac(&m))
                    .unwrap_or_default(),
            });
        }
        if let (Some(wl), Some(snap)) = (&self.wl, snap) {
            devices.push(DeviceInfo {
                name: "L-Wireless 收发器".into(),
                connection: format!("USB · 频道 {}", wl.channel),
                address: fmt_mac(&wl.master),
            });
            for (_, d) in wl.own_devices(snap) {
                if d.is_aio() {
                    pump_rpm = pump_rpm.or(d.pump_rpm());
                    continue;
                }
                let n = usize::from(d.fan_count).min(4);
                fan_groups.push(FanGroup {
                    target_percent: d.supports_fan_control().then(||self.group_outputs.get(&d.mac_str()).map_or(fan,|o|o.percent)),
                    source_error: self.group_outputs.get(&d.mac_str()).and_then(|o|o.source_error.clone()),
                    supports_control: d.supports_fan_control(),
                    address: d.mac_str(),
                    kind: d.kind().into(),
                    rpm: d.rpm[..n].to_vec(),
                    pwm: d.pwm[..n].to_vec(),
                });
                devices.push(DeviceInfo {
                    name: format!("{} × {}", d.kind(), d.fan_count),
                    connection: "无线 · 本机绑定".into(),
                    address: d.mac_str(),
                });
            }
        }

        // RX 听到的全部无线设备（锁定过滤之前），给“设备与绑定”页。
        let mut wireless = Vec::new();
        if let (Some(wl), Some(full)) = (&self.wl, &self.last_full) {
            for d in &full.devices {
                let owner = if d.master == wl.master {
                    "ours"
                } else if d.master == [0; 6] {
                    "unbound"
                } else {
                    "other"
                };
                wireless.push(WirelessDevice {
                    address: d.mac_str(),
                    kind: d.kind().into(),
                    owner: owner.into(),
                    master: fmt_mac(&d.master),
                    fan_count: d.fan_count,
                    rx: d.rx_type,
                    channel: d.channel,
                    mb_light_sync: d.mb_light_sync,
                    excluded: owner == "ours" && !config.devices.locked.is_empty() && !config.devices.locked.contains(&d.mac_str()),
                });
            }
        }

        Status {
            uptime_s: self.started.elapsed().as_secs(),
            mode: Some(config.cooling.mode),
            coolant_c: coolant,
            coolant_raw_c: None,
            cpu_usage: self.cpu_usage,
            pump_rpm,
            pump_target_rpm: Some(pump_target),
            fan_percent: Some(fan),
            fan_groups,
            devices,
            wireless,
            transmitter: self.wl.as_ref().map(|wl| (fmt_mac(&wl.master), wl.channel)),
            last_error: (!self.errors.is_empty()).then(|| self.errors.join("；")),
            memory_mb: crate::cpu::private_memory_mb(),
            ..Status::default()
        }
    }

    /// 执行界面排队的设备操作（绑定、解绑、主板灯光同步）。在控制线程里跑，因为无线句柄在这里。
    fn run_ops(&mut self, ops: Vec<(DeviceOp, mpsc::Sender<Result<(), String>>)>) {
        for (op, reply) in ops {
            let result = match self.wl.as_mut() {
                None => Err("无线收发器没有连接".to_string()),
                Some(wl) => {
                    let r = match op {
                        DeviceOp::Identify(mac) => {
                            if self.identified_at.get(&mac).is_some_and(|t|t.elapsed()<Duration::from_secs(5)) {
                                Err(anyhow::anyhow!("定位请求过于频繁，请稍后重试"))
                            } else {
                                let snap=wl.cached();
                                match wl.own_devices(&snap).into_iter().find(|(_,d)|d.mac==mac && d.supports_fan_control()).map(|(_,d)|d.clone()) {
                                    Some(dev)=>{
                                        let result=wl.identify(&dev);
                                        if result.is_ok() {
                                            self.identified_at.insert(mac,Instant::now());
                                            self.lighting.suspend(mac,Duration::from_secs(5));
                                        }
                                        result
                                    },
                                    None=>Err(anyhow::anyhow!("设备未绑定在本机或已离线")),
                                }
                            }
                        }
                        DeviceOp::Bind(mac) => wl.bind(&mac).map(|rx| log::line(&format!("已绑定 {}，rx {rx}", fmt_mac(&mac)))),
                        DeviceOp::Unbind(mac) => wl.unbind(&mac).map(|()| log::line(&format!("已解绑 {}", fmt_mac(&mac)))),
                        DeviceOp::Channel(channel) => {
                            let old = wl.channel;
                            wl.change_channel(channel).map(|n| {
                                if old != channel {
                                    log::line(&format!("无线频道 {old} → {channel}，{n} 个设备已跟过去"));
                                }
                            })
                        }
                        DeviceOp::MbLightSync(mac, on) => {
                            let snap = wl.cached();
                            match wl.own_devices(&snap).into_iter().find(|(_, d)| d.mac == mac).map(|(s, d)| (s, d.clone())) {
                                Some((slot, dev)) => wl.set_mb_light_sync(&dev, slot, on),
                                None => Err(anyhow::anyhow!("这个设备没有绑定在本机")),
                            }
                        }
                    };
                    r.map_err(|e| format!("{e:#}"))
                }
            };
            if let Err(e) = &result {
                log::line(&format!("设备操作失败：{e}"));
            }
            let _ = reply.send(result);
        }
    }
}

/// 一阶低通：每步向新值靠近 dt / (tau + dt)。
fn low_pass(prev: f32, raw: f32, dt: Duration, tau: Duration) -> f32 {
    let a = dt.as_secs_f32() / (tau.as_secs_f32() + dt.as_secs_f32());
    prev + a * (raw - prev)
}

fn percent_to_duty(percent: f32) -> u8 {
    (percent.clamp(0.0, 100.0) * 255.0 / 100.0).round() as u8
}

fn temp_source_name(source: TempSource) -> &'static str {
    match source {
        TempSource::Coolant => "水温",
        TempSource::Gpu => "GPU 温度",
    }
}

/// 本轮要下发的输出；风扇占空比是全局值，单风扇覆盖在下发时套用。
struct Outputs<'a> {
    fan: f32,
    pump_rpm: u16,
    square: bool,
    overrides: &'a [FanOverride],
    groups: &'a HashMap<String,GroupOutput>,
    guard: bool,
}

impl Outputs<'_> {
    /// 某组第 `index` 个风扇的占空比：有固定值用固定值，否则全局值加偏移。
    fn fan_duty(&self, address: &str, index: usize) -> u8 {
        let percent = if let Some(g)=self.groups.get(address) {g.percent} else { match self.overrides.iter().find(|o| o.address == address && usize::from(o.index) == index) {
            Some(FanOverride { fixed_percent: Some(f), .. }) => *f,
            Some(o) => self.fan + o.offset_percent,
            None => self.fan,
        }};
        let percent=if self.guard {percent.max(GUARD_FAN_PERCENT)} else {percent};
        percent_to_duty(percent.clamp(MIN_FAN_PERCENT, 100.0))
    }
}

fn drive_wireless(
    wl: &mut Wireless,
    snap: &Snapshot,
    aio: Option<&(u8, lcl_devices::wireless::RfDevice)>,
    out: &Outputs,
) -> Result<()> {
    wl.send_clock()?;
    if let Some((slot, dev)) = aio {
        // 无线模式下泵速只由参数块里的泵定时器决定。PWM 帧第 4 路对冷头也是泵：
        // 再往那里发占空比会和定时器互相打架（实测泵速在两个值之间来回跳）。
        // 所以和官方一样，不带无线风扇的冷头不发 PWM 帧；带风扇的（CL 版）只改三路风扇，泵那一路回填设备当前值。
        wl.set_aio_params(dev, &aio_params(out.pump_rpm, out.square))?;
        if dev.fan_count > 0 {
            let a = dev.mac_str();
            wl.set_pwm(dev, *slot, [out.fan_duty(&a, 0), out.fan_duty(&a, 1), out.fan_duty(&a, 2), dev.pwm[3]])?;
        }
    }
    let targets: Vec<_> = wl
        .own_devices(snap)
        .into_iter()
        .filter(|(_, d)| d.supports_fan_control())
        .map(|(slot, d)| (slot, d.clone()))
        .collect();
    for (slot, dev) in targets {
        let a = dev.mac_str();
        // A standalone wireless group is one control item. Legacy per-fan overrides
        // are retained in the config backup but never split this group's output.
        let percent=out.groups.get(&a).map_or(out.fan,|g|g.percent);
        let percent=if out.guard {percent.max(GUARD_FAN_PERCENT)} else {percent};
        wl.set_pwm(&dev, slot, [percent_to_duty(percent);4])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_output_is_uniform_and_guard_cannot_be_bypassed() {
        let mut groups=HashMap::new();groups.insert("aa".into(),GroupOutput{percent:35.0,source_error:None});
        let out=Outputs{fan:50.0,pump_rpm:2000,square:true,overrides:&[],groups:&groups,guard:false};
        for i in 0..4 {assert_eq!(out.fan_duty("aa",i),percent_to_duty(35.0));}
        let overrides=[FanOverride{address:"aa".into(),index:0,offset_percent:0.0,fixed_percent:Some(20.0)}];
        let out=Outputs{fan:40.0,pump_rpm:2000,square:true,overrides:&overrides,groups:&groups,guard:true};
        assert_eq!(out.fan_duty("aa",0),percent_to_duty(80.0));
    }

    #[test]
    fn incoming_frames_are_bounded_and_square() {
        assert!(!valid_jpeg_frame(&[]));assert!(!valid_jpeg_frame(&vec![0;512001]));
        let good=[0xff,0xd8,0xff,0xc0,0,11,8,1,0xe0,1,0xe0,1,1,0x11,0,0xff,0xd9];
        assert!(valid_jpeg_frame(&good));
        let mut wrong=good;wrong[10]=0xdf;assert!(!valid_jpeg_frame(&wrong));
    }

    #[test]
    fn low_pass_smooths_integer_flicker() {
        // 26/27 来回跳，滤波后应稳定在中间、波动远小于 1 °C。
        let mut v = 26.0;
        let mut seen = Vec::new();
        for i in 0..200 {
            v = low_pass(v, if i % 2 == 0 { 27.0 } else { 26.0 }, TICK, COOLANT_TAU);
            if i > 150 {
                seen.push(v);
            }
        }
        let (lo, hi) = seen.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)));
        assert!(hi - lo < 0.1, "波动 {}", hi - lo);
        assert!((26.3..26.7).contains(&lo));
    }

    #[test]
    fn overrides_apply_per_fan() {
        let overrides = vec![
            FanOverride { address: "aa".into(), index: 0, offset_percent: 10.0, fixed_percent: None },
            FanOverride { address: "aa".into(), index: 2, offset_percent: -50.0, fixed_percent: None },
            FanOverride { address: "aa".into(), index: 1, offset_percent: 0.0, fixed_percent: Some(80.0) },
        ];
        let groups=HashMap::new();
        let out = Outputs { fan: 40.0, pump_rpm: 2000, square: true, overrides: &overrides, groups: &groups, guard:false };
        assert_eq!(out.fan_duty("aa", 0), percent_to_duty(50.0));
        assert_eq!(out.fan_duty("aa", 1), percent_to_duty(80.0));
        // 偏移后低于下限时抬到 20%。
        assert_eq!(out.fan_duty("aa", 2), percent_to_duty(MIN_FAN_PERCENT));
        assert_eq!(out.fan_duty("bb", 0), percent_to_duty(40.0));
    }

    #[test]
    fn boost_is_linear_above_ten_percent() {
        assert_eq!(boost(5.0, 20.0), 0.0);
        assert_eq!(boost(55.0, 20.0), 10.0);
        assert_eq!(boost(100.0, 20.0), 20.0);
    }
}
