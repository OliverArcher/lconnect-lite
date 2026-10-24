//! L-Wireless 发射器（TX）/ 接收器（RX）和已绑定的无线设备。
//! 协议移植自 lian-li-linux 的 wireless/*.rs（MIT）。
//!
//! TX 只发不收（除了查询主机 MAC），RX 只负责回报设备列表。
//! 发给设备的 240 字节 RF 包被拆成 4 个 64 字节 USB 包，经 TX 发出。

use crate::rgb::RgbUpload;
use crate::usb::UsbDev;
use anyhow::{bail, Context, Result};
use std::thread::sleep;
use std::time::{Duration, Instant};

const TX_IDS: [(u16, u16); 2] = [(0x0416, 0x8040), (0x1A86, 0xE304)];
const RX_IDS: [(u16, u16); 2] = [(0x0416, 0x8041), (0x1A86, 0xE305)];

const USB_CMD_SEND_RF: u8 = 0x10;
const USB_CMD_GET_MAC: u8 = 0x11;

const RF_SELECT: u8 = 0x12;
const RF_PWM: u8 = 0x10;
const RF_CLOCK_SYNC: u8 = 0x14;
const RF_SAVE_CONFIG: u8 = 0x15;
const RF_MB_LIGHT_SYNC: u8 = 0x27;
const RF_SET_RGB: u8 = 0x20;
const RF_AIO_PARAMS: u8 = 0x21;

const RF_DATA_SIZE: usize = 240;
const RF_CHUNK: usize = 60;
const RECORD_LEN: usize = 42;
const BROADCAST: u8 = 0xFF;

const USB_TIMEOUT: Duration = Duration::from_millis(1000);
/// RX 的设备列表偶尔会漏掉某个设备一两轮；超过这么久没出现才当它离线。
const LIVENESS_TIMEOUT: Duration = Duration::from_secs(15);
/// 发给不同目标/不同命令的两帧之间至少隔这么久；灯效帧之后要更久。
const GAP_BETWEEN_FRAMES: Duration = Duration::from_millis(5);
const GAP_AFTER_RGB: Duration = Duration::from_millis(10);

pub const DEV_TYPE_H2_CIRCLE: u8 = 10;
pub const DEV_TYPE_H2_SQUARE: u8 = 11;

#[derive(Debug, Clone)]
pub struct RfDevice {
    pub mac: [u8; 6],
    /// 设备记录里的“绑定到哪个发射器”。
    pub master: [u8; 6],
    pub channel: u8,
    pub rx_type: u8,
    pub dev_type: u8,
    pub fan_count: u8,
    pub fan_types: [u8; 4],
    pub rpm: [u16; 4],
    pub pwm: [u8; 4],
    /// 设备当前在跑的灯效编号（上传时由内容算出），用来确认上传是否生效。
    pub effect_index: [u8; 4],
    pub cmd_seq: u8,
    /// 主板灯光同步开着时设备不接受上传的灯效。
    pub mb_light_sync: bool,
}

impl RfDevice {
    /// Only the existing TL V2 wireless path is enabled for this build.
    pub fn supports_fan_control(&self) -> bool {
        self.dev_type == 0 && (1..=4).contains(&self.fan_count)
            && self.fan_types.iter().take(usize::from(self.fan_count)).all(|t| matches!(t,27..=35))
    }
    pub fn is_aio(&self) -> bool {
        matches!(self.dev_type, DEV_TYPE_H2_CIRCLE | DEV_TYPE_H2_SQUARE)
    }

    fn is_cl(&self) -> bool {
        self.fan_types
            .iter()
            .any(|&t| matches!(t, 40..=42 | 126 | 127))
    }

    /// 冷头记录里第 4 个转速槽是泵，第 4 个风扇类型字节是水温。
    pub fn pump_rpm(&self) -> Option<u16> {
        self.is_aio().then_some(self.rpm[3])
    }

    pub fn coolant_c(&self) -> Option<u8> {
        (self.is_aio() && self.fan_types[3] > 0).then_some(self.fan_types[3])
    }

    pub fn kind(&self) -> &'static str {
        match self.dev_type {
            DEV_TYPE_H2_CIRCLE => "隐流二代 圆屏",
            DEV_TYPE_H2_SQUARE => "隐流二代 方屏",
            1..=9 => "Strimer 灯线",
            65 => "Lancool 217",
            66 => "V150",
            0 => match self.fan_types.iter().find(|&&t| t != 0) {
                Some(20..=26) => "SL 无线",
                Some(27..=35) => "TL 无线",
                Some(36..=39 | 43..=50) => "SL-INF 无线",
                Some(40..=42 | 126 | 127) => "CL 无线",
                Some(51..=58) => "TL V3 无线",
                _ => "未知风扇",
            },
            _ => "未知设备",
        }
    }

    pub fn mac_str(&self) -> String {
        fmt_mac(&self.mac)
    }

    /// 设备记录的频道不合法时退回用主机频道。
    fn traffic_channel(&self, master_channel: u8) -> u8 {
        if (1..=39).contains(&self.channel) {
            self.channel
        } else {
            master_channel
        }
    }
}

pub fn fmt_mac(mac: &[u8; 6]) -> String {
    mac.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub devices: Vec<RfDevice>,
    /// RX 采样到的主板 PWM 占空比（0-255），没接线时为 None。
    pub mb_pwm: Option<u8>,
    /// 这一轮在当前频道上听到的其他发射器：(MAC, 频道)。绑定前用来判断设备的主人是否在线。
    pub masters: Vec<([u8; 6], u8)>,
}

pub struct Wireless {
    tx: UsbDev,
    rx: UsbDev,
    pub master: [u8; 6],
    pub channel: u8,
    pub tx_firmware: u16,
    pages: u8,
    /// 按首次出现顺序保存的设备和最后一次出现的时间；slot 序号依赖这个顺序稳定。
    known: Vec<(RfDevice, Instant)>,
    last_frame: Option<([u8; 6], u8, Instant)>,
    rx_diagnostic: String,
    rx_trace: bool,
    dry_run: bool,
}

impl Wireless {
    /// 两个接收器都没插时返回 `Ok(None)`。
    pub fn connect(dry_run: bool) -> Result<Option<Self>> {
        let Some(tx) = UsbDev::open_any(&TX_IDS, "无线发射器 TX")? else {
            return Ok(None);
        };
        let rx = UsbDev::open_any(&RX_IDS, "无线接收器 RX")?
            .context("找到了 TX 但没有 RX，两个接收器要同时插着")?;
        rx.flush();
        let mut w = Self {
            tx,
            rx,
            master: [0; 6],
            channel: 0,
            tx_firmware: 0,
            pages: 1,
            known: Vec::new(),
            last_frame: None,
            rx_diagnostic: String::new(),
            rx_trace: std::env::var_os("LCL_RX_TRACE").is_some(),
            dry_run,
        };
        w.discover_master()?;
        Ok(Some(w))
    }

    /// 向 TX 查询主机 MAC，同时确定当前频道：先试默认的 8，再试偶数，最后奇数。
    fn discover_master(&mut self) -> Result<()> {
        let channels = std::iter::once(8u8)
            .chain((2..=38).filter(|&c| c != 8 && c % 2 == 0))
            .chain((1..=39).filter(|&c| c % 2 == 1));
        for channel in channels {
            if let Some((mac, firmware)) = self.get_mac(channel)? {
                self.master = mac;
                self.channel = channel;
                self.tx_firmware = firmware;
                return Ok(());
            }
        }
        bail!("TX 在 1-39 所有频道上都没有回应 GetMac")
    }

    /// 在指定频道上向 TX 查询主机 MAC 和固件版本；TX 没有有效应答时返回 None。
    fn get_mac(&mut self, channel: u8) -> Result<Option<([u8; 6], u16)>> {
        let mut cmd = [0u8; 64];
        cmd[0] = USB_CMD_GET_MAC;
        cmd[1] = channel;
        self.tx.flush();
        self.tx.write(&cmd, USB_TIMEOUT).context("向 TX 发 GetMac")?;
        let mut resp = [0u8; 64];
        let n = self.tx.read(&mut resp, Duration::from_millis(500))?;
        let valid = n >= 13
            && resp[0] == USB_CMD_GET_MAC
            && resp[1..7].iter().any(|&b| b != 0)
            && u32::from_be_bytes(resp[7..11].try_into().unwrap()) > 1;
        Ok(valid.then(|| (resp[1..7].try_into().unwrap(), u16::from_be_bytes([resp[11], resp[12]]))))
    }

    /// 向 RX 要设备列表（GetDev）。每页 512 字节、最多 10 条记录。
    /// 只取这一轮 RX 实际报告的记录，不合并缓存。绑定确认要用“新鲜”的记录。
    fn fetch(&mut self) -> Result<Snapshot> {
        let mut cmd = [0u8; 64];
        cmd[0] = USB_CMD_SEND_RF;
        cmd[1] = self.pages;
        self.rx.flush();
        self.rx.write(&cmd, USB_TIMEOUT).context("向 RX 发 GetDev")?;
        let mut resp = vec![0u8; usize::from(self.pages) * 512];
        let len = self.rx.read_until_silence(
            &mut resp,
            Duration::from_millis(100),
            Duration::from_millis(10),
        )?;
        self.rx_diagnostic = describe_rx(&resp[..len], self.pages);
        if self.rx_trace {
            self.rx_diagnostic.push_str(&format!(" raw={}", hex(&resp[..len])));
        }
        let fresh = parse_get_dev(&resp[..len], self.pages)?;
        self.pages = (resp[1].div_ceil(10)).clamp(1, 26);
        Ok(fresh)
    }

    /// 只含包长度和记录身份/类型，不含逐秒变化的转速；供回报缺失排查。
    pub fn rx_diagnostic(&self) -> &str {
        &self.rx_diagnostic
    }

    pub fn poll(&mut self) -> Result<Snapshot> {
        let fresh = self.fetch()?;
        let now = Instant::now();
        for dev in fresh.devices {
            match self.known.iter_mut().find(|(d, _)| d.mac == dev.mac) {
                Some(entry) => *entry = (dev, now),
                None => self.known.push((dev, now)),
            }
        }
        self.known.retain(|(_, seen)| now - *seen < LIVENESS_TIMEOUT);
        Ok(Snapshot {
            devices: self.known.iter().map(|(d, _)| d.clone()).collect(),
            mb_pwm: fresh.mb_pwm,
            masters: fresh.masters,
        })
    }

    /// 这一轮 GetDev 失败时用的上一次结果（同样受 15 秒离线判定约束）。
    pub fn cached(&mut self) -> Snapshot {
        let now = Instant::now();
        self.known.retain(|(_, seen)| now - *seen < LIVENESS_TIMEOUT);
        Snapshot {
            devices: self.known.iter().map(|(d, _)| d.clone()).collect(),
            mb_pwm: None,
            masters: Vec::new(),
        }
    }

    /// 已绑定到本机发射器的设备，按 RX 列表顺序；序号（从 1 开始）就是官方的 slot。
    pub fn own_devices<'a>(&self, snap: &'a Snapshot) -> Vec<(u8, &'a RfDevice)> {
        snap.devices
            .iter()
            .filter(|d| d.master == self.master)
            .enumerate()
            .map(|(i, d)| (i as u8 + 1, d))
            .collect()
    }

    /// 绑定到本机发射器的冷头（即冷头处于无线模式）及其 slot。
    pub fn own_aio<'a>(&self, snap: &'a Snapshot) -> Option<(u8, &'a RfDevice)> {
        self.own_devices(snap).into_iter().find(|(_, d)| d.is_aio())
    }

    /// 设风扇 PWM（每槽 0-255）。冷头的第 4 槽是泵。
    pub fn set_pwm(&mut self, dev: &RfDevice, slot: u8, pwm: [u8; 4]) -> Result<()> {
        let pwm = constrain_pwm(dev, pwm);
        let rf = pwm_packet(dev, &self.master, self.channel, slot, pwm);
        self.send_rf(dev.traffic_channel(self.channel), dev.rx_type, &rf)
    }

    /// 冷头无线模式下的 32 字节参数块，泵定时器在 [28..30]。官方每秒发一次（`SendAioInfo`），
    /// 这是无线模式下泵速的唯一来源；[16]、[17] 和官方一样留 0。
    pub fn set_aio_params(&mut self, dev: &RfDevice, params: &[u8; 32]) -> Result<()> {
        let mut rf = rf_header(RF_AIO_PARAMS, dev, &self.master, self.channel);
        rf[18..50].copy_from_slice(params);
        self.send_rf(dev.traffic_channel(self.channel), dev.rx_type, &rf)
    }

    /// 上传一段灯效：头包重复 4 次（间隔 20 ms），数据包各一次，整个过程须在 3 秒内完成。
    /// 是否生效看之后 GetDev 记录里的 `effect_index`。
    pub fn upload_rgb(&mut self, dev: &RfDevice, upload: &RgbUpload) -> Result<()> {
        anyhow::ensure!(!dev.mb_light_sync, "{} 开着主板灯光同步，先关掉才能上传灯效", dev.mac_str());
        let started = Instant::now();
        let channel = dev.traffic_channel(self.channel);
        for index in 0..upload.packet_count() {
            anyhow::ensure!(started.elapsed() < Duration::from_secs(3), "灯效上传超时");
            let packet = upload.packet(&dev.mac, &self.master, index);
            let repeats = if index == 0 { 4 } else { 1 };
            for r in 0..repeats {
                self.send_rf(channel, dev.rx_type, &packet)?;
                if r + 1 < repeats {
                    sleep(Duration::from_millis(20));
                }
            }
        }
        Ok(())
    }

    // ---------- 绑定 ----------

    /// 把设备绑定到本机发射器，返回分到的 rx 槽位。
    /// 设备必须这一轮在线；属于另一个在线发射器的设备拒绝绑定（两边会互相抢）。
    pub fn bind(&mut self, mac: &[u8; 6]) -> Result<u8> {
        let (dev, masters) = self.find_live(mac)?;
        if dev.master == self.master {
            return Ok(dev.rx_type);
        }
        if dev.master != [0; 6] && masters.iter().any(|(m, _)| *m == dev.master) {
            bail!("设备属于另一个在线的发射器 {}，请先在那边解绑", fmt_mac(&dev.master));
        }
        let own: Vec<RfDevice> = self.known.iter().map(|(d, _)| d.clone()).filter(|d| d.master == self.master && d.mac != *mac).collect();
        anyhow::ensure!(own.len() < 10, "一个发射器最多绑定 10 个设备");
        let rx = (1..=13u8).find(|r| !own.iter().any(|d| d.rx_type == *r)).context("没有空闲的 rx 槽位")?;
        let slot = own.len() as u8 + 1;
        self.converge(&dev, self.master, rx, slot)?;
        self.save_config()?;
        Ok(rx)
    }

    /// 解绑本机的设备（主机 MAC 和 rx 都清零）。
    pub fn unbind(&mut self, mac: &[u8; 6]) -> Result<()> {
        let (dev, _) = self.find_live(mac)?;
        anyhow::ensure!(dev.master == self.master, "这个设备没有绑定在本机");
        self.converge(&dev, [0; 6], 0, 0)?;
        self.save_config()
    }

    // ---------- 切换频道 ----------

    /// 把本机发射器和绑定在本机的设备一起切到 `new` 频道（1-39）。和官方一样：频道只记在主机这边，
    /// 设备靠在它当前频道上重发的绑定帧（同 rx、同 slot，只换频道）换过去。
    ///
    /// 逐个设备等 RX 报告它到了新频道；有设备没跟上就把所有设备切回原频道再报错，
    /// 全部到位后才让设备保存（断电后保留）。返回切过去的设备数。
    pub fn change_channel(&mut self, new: u8) -> Result<usize> {
        anyhow::ensure!((1..=39).contains(&new), "频道必须在 1-39 之间");
        let old = self.channel;
        if new == old {
            return Ok(0);
        }
        anyhow::ensure!(self.get_mac(new)?.is_some_and(|(mac, _)| mac == self.master), "发射器在频道 {new} 上没有应答");
        let snap = self.poll()?;
        let own: Vec<(u8, RfDevice)> = self.own_devices(&snap).into_iter().map(|(s, d)| (s, d.clone())).collect();

        self.channel = new;
        let mut failure = None;
        for (slot, dev) in &own {
            if let Err(e) = self.converge(dev, self.master, dev.rx_type, *slot) {
                failure = Some(format!("{} 没有跟到频道 {new}：{e:#}", dev.mac_str()));
                break;
            }
        }
        let Some(why) = failure else {
            self.save_config()?;
            return Ok(own.len());
        };

        // 回退：设备可能已经换过去了、只是 RX 没听到，所以不等确认，对每个设备都在新频道上发“回到原频道”的绑定帧，
        // 再到原频道上确认。
        self.channel = old;
        let _ = self.get_mac(old);
        for (slot, dev) in &own {
            let frame = bind_frame(dev, &self.master, dev.rx_type, old, *slot);
            for _ in 0..3 {
                for target in [dev.rx_type, BROADCAST] {
                    self.send_rf(new, target, &frame)?;
                    sleep(Duration::from_millis(30));
                }
            }
        }
        let mut stuck: Vec<String> = Vec::new();
        for (slot, dev) in &own {
            match self.find_live(&dev.mac) {
                Ok((now, _)) if now.channel == old && now.master == self.master => {}
                Ok((now, _)) => {
                    if self.converge(&now, self.master, dev.rx_type, *slot).is_err() {
                        stuck.push(dev.mac_str());
                    }
                }
                Err(_) => stuck.push(dev.mac_str()),
            }
        }
        let _ = self.save_config();
        if stuck.is_empty() {
            bail!("{why}；已全部切回频道 {old}")
        }
        bail!("{why}；切回频道 {old} 时这些设备没有确认：{}（可能还在频道 {new}，切到 {new} 再切回来可以找回）", stuck.join("、"))
    }

    /// 确认设备在线并取它最新的记录，以及这几轮听到的其他发射器。
    /// RX 的列表时不时会漏掉某个设备，所以最多问 5 轮；都没有时，缓存里 3 秒内见过也算在线。
    fn find_live(&mut self, mac: &[u8; 6]) -> Result<(RfDevice, Vec<([u8; 6], u8)>)> {
        let mut masters = Vec::new();
        for _ in 0..5 {
            if let Ok(snap) = self.fetch() {
                masters.extend(snap.masters.iter().copied());
                if let Some(d) = snap.devices.iter().find(|d| &d.mac == mac) {
                    return Ok((d.clone(), masters));
                }
            }
            sleep(Duration::from_millis(300));
        }
        self.known
            .iter()
            .find(|(d, seen)| &d.mac == mac && seen.elapsed() < Duration::from_secs(3))
            .map(|(d, _)| (d.clone(), masters))
            .context("设备不在线（RX 连续 5 轮都没有报告它）")
    }

    /// 反复发绑定帧，直到设备报告的主机、rx（以及绑定时的频道）和目标一致，最多 5 秒。
    /// 每轮先按设备当前的 rx 发（官方的做法；未绑定的冷头无线模块报 rx 254，只听这个地址），
    /// 再以 0xFF 广播发（lian-li-linux 的做法；设备的 rx 错乱时靠帧内 MAC 选中它）。
    fn converge(&mut self, dev: &RfDevice, master: [u8; 6], rx: u8, slot: u8) -> Result<()> {
        let frame = bind_frame(dev, &master, rx, self.channel, slot);
        let send_channel = if dev.channel == 0 { self.channel } else { dev.channel };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            for target in [dev.rx_type, dev.rx_type, dev.rx_type, BROADCAST, BROADCAST, BROADCAST] {
                self.send_rf(send_channel, target, &frame)?;
                sleep(Duration::from_millis(30));
            }
            sleep(Duration::from_millis(150));
            let Ok(snap) = self.fetch() else { continue };
            if let Some(d) = snap.devices.iter().find(|d| d.mac == dev.mac) {
                if d.master == master && d.rx_type == rx && (rx == 0 || d.channel == self.channel) {
                    if let Some(entry) = self.known.iter_mut().find(|(k, _)| k.mac == d.mac) {
                        *entry = (d.clone(), Instant::now());
                    }
                    return Ok(());
                }
            }
        }
        bail!("设备 5 秒内没有确认新的绑定状态（没有保存，设备保持原状态）")
    }

    /// 让本机绑定的设备把当前绑定写进自己的存储（断电后保留）。只在确认收敛后调用。
    fn save_config(&mut self) -> Result<()> {
        let mut rf = vec![0u8; RF_DATA_SIZE];
        rf[0] = RF_SELECT;
        rf[1] = RF_SAVE_CONFIG;
        rf[2..8].fill(0xFF);
        rf[8..14].copy_from_slice(&self.master);
        rf[14] = BROADCAST;
        for _ in 0..3 {
            self.send_rf(self.channel, BROADCAST, &rf)?;
            sleep(Duration::from_millis(200));
        }
        Ok(())
    }

    /// 开关主板灯光同步（RF 0x27）。开着时设备跟随主板 ARGB，不接受我们上传的灯效。
    /// `slot` 是本机设备里的序号（从 1 开始），帧里用从 0 开始的序号。
    pub fn set_mb_light_sync(&mut self, dev: &RfDevice, slot: u8, on: bool) -> Result<()> {
        let seq = if dev.cmd_seq >= 254 { 1 } else { dev.cmd_seq + 1 };
        let mut rf = rf_header(RF_MB_LIGHT_SYNC, dev, &self.master, self.channel);
        rf[16] = slot.saturating_sub(1);
        rf[17] = seq;
        rf[20] = u8::from(on);
        let channel = dev.traffic_channel(self.channel);
        for _ in 0..10 {
            self.send_rf(channel, dev.rx_type, &rf)?;
            sleep(Duration::from_millis(200));
            let Ok(snap) = self.fetch() else { continue };
            if snap.devices.iter().any(|d| d.mac == dev.mac && (d.cmd_seq == seq || d.mb_light_sync == on)) {
                return Ok(());
            }
        }
        bail!("设备没有确认主板灯光同步的切换")
    }

    /// Native Select (RF subcommand 0x12). Does not replace stored lighting or PWM.
    /// Sending is not a visual acknowledgement: users must confirm the physical target.
    pub fn identify(&mut self, dev: &RfDevice) -> Result<()> {
        anyhow::ensure!(dev.master == self.master && dev.supports_fan_control(), "只能识别本机绑定的受支持TL风扇组");
        let seq=if dev.cmd_seq>=254 {1} else {dev.cmd_seq+1};
        let mut rf=rf_header(0x12,dev,&self.master,self.channel);
        rf[17]=seq;
        for _ in 0..10 {
            self.send_rf(dev.traffic_channel(self.channel),dev.rx_type,&rf)?;
            sleep(Duration::from_millis(30));
        }
        Ok(())
    }

    /// 每秒一次的时钟广播。官方软件一直在发，设备靠它保持同步。
    pub fn send_clock(&mut self) -> Result<()> {
        let mut rf = vec![0u8; RF_DATA_SIZE];
        rf[0] = RF_SELECT;
        rf[1] = RF_CLOCK_SYNC;
        rf[8..14].copy_from_slice(&self.master);
        // 定向帧会从这一段读 rx_type/频道，填 0x14 表示“未设置”。
        rf[14..64].fill(0x14);
        self.send_rf(self.channel, BROADCAST, &rf)
    }

    fn send_rf(&mut self, channel: u8, rx_target: u8, rf: &[u8]) -> Result<()> {
        debug_assert_eq!(rf.len(), RF_DATA_SIZE);
        let target: [u8; 6] = rf[2..8].try_into().unwrap();
        let opcode = rf[1];
        if let Some((last_target, last_op, at)) = self.last_frame {
            if (last_target, last_op) != (target, opcode) {
                let gap = if last_op == RF_SET_RGB { GAP_AFTER_RGB } else { GAP_BETWEEN_FRAMES };
                sleep(gap.saturating_sub(at.elapsed()));
            }
        }
        for (i, chunk) in rf.chunks(RF_CHUNK).enumerate() {
            let mut packet = [0u8; 64];
            packet[0] = USB_CMD_SEND_RF;
            packet[1] = i as u8;
            packet[2] = channel;
            packet[3] = rx_target;
            packet[4..].copy_from_slice(chunk);
            if self.dry_run {
                println!("    [dry-run] TX {}", hex(&packet[..24]));
            } else {
                self.tx.write(&packet, USB_TIMEOUT).context("向 TX 写 RF 分片")?;
            }
            sleep(Duration::from_millis(1));
        }
        self.last_frame = Some((target, opcode, Instant::now()));
        Ok(())
    }
}

/// 无线模式下的冷头参数块。除泵定时器外都用 lian-li-linux 的默认值：
/// 主题 0、亮度 80、白色文字、不显示传感器数值。会覆盖官方软件里设的屏幕主题。
pub fn aio_params(pump_rpm: u16, square: bool) -> [u8; 32] {
    let mut p = [0u8; 32];
    p[6] = 3; // 循环间隔
    p[7] = 1;
    for start in [13, 17, 21] {
        p[start..start + 4].copy_from_slice(&[0xFF; 4]); // ARGB 白色
    }
    p[25] = 80; // 亮度
    p[26] = 1;
    p[27] = 0; // 主题序号
    p[28..30].copy_from_slice(&crate::h2::pump_timer(pump_rpm, square).to_be_bytes());
    p[30] = 0; // 旋转
    p
}

fn rf_header(opcode: u8, dev: &RfDevice, master: &[u8; 6], channel: u8) -> Vec<u8> {
    let mut rf = vec![0u8; RF_DATA_SIZE];
    rf[0] = RF_SELECT;
    rf[1] = opcode;
    rf[2..8].copy_from_slice(&dev.mac);
    rf[8..14].copy_from_slice(master);
    rf[14] = dev.rx_type;
    rf[15] = channel;
    rf
}

/// 绑定 / 解绑帧：和 PWM 帧同一个命令，[14] 是目标 rx，[17..21] 带上设备当前的 PWM（不改转速）。
/// 解绑时主机 MAC、rx、slot 都是 0。
/// 设备报告的 PWM 全是 0 时（比如未绑定的冷头无线模块）改用官方给新设备的默认值 100：
/// 冷头的第 4 路是泵，发 0 会让泵减速。
fn bind_frame(dev: &RfDevice, master: &[u8; 6], rx: u8, channel: u8, slot: u8) -> Vec<u8> {
    let pwm = if dev.pwm == [0; 4] { [100; 4] } else { dev.pwm };
    let mut rf = vec![0u8; RF_DATA_SIZE];
    rf[0] = RF_SELECT;
    rf[1] = RF_PWM;
    rf[2..8].copy_from_slice(&dev.mac);
    rf[8..14].copy_from_slice(master);
    rf[14] = rx;
    rf[15] = channel;
    rf[16] = slot;
    rf[17..21].copy_from_slice(&pwm);
    rf
}

fn pwm_packet(dev: &RfDevice, master: &[u8; 6], channel: u8, slot: u8, pwm: [u8; 4]) -> Vec<u8> {
    let mut rf = rf_header(RF_PWM, dev, master, channel);
    rf[16] = slot;
    rf[17..21].copy_from_slice(&pwm);
    rf
}

/// 和官方一致的限制：不存在的槽清零、低于最低占空比的抬到最低、
/// CL 风扇避开 153-155（固件里有特殊含义）。值 6 表示“跟随主板”，这里不会产生。
fn constrain_pwm(dev: &RfDevice, mut pwm: [u8; 4]) -> [u8; 4] {
    let min = (0.10 * 255.0) as u8;
    for (i, v) in pwm.iter_mut().enumerate() {
        let pump_slot = i == 3 && dev.is_aio();
        if i as u8 >= dev.fan_count && !pump_slot {
            *v = 0;
            continue;
        }
        if *v > 0 && *v < min {
            *v = min;
        }
        if *v == 6 {
            *v = 7;
        }
        if dev.is_cl() {
            *v = match *v {
                153 | 154 => 152,
                155 => 156,
                other => other,
            };
        }
    }
    pwm
}

fn describe_rx(resp: &[u8], pages: u8) -> String {
    if resp.len() < 4 {
        return format!("pages={pages} bytes={} header={}", resp.len(), hex(resp));
    }
    let records = resp[4..].chunks_exact(RECORD_LEN)
        .take(usize::from(resp[1]).min(usize::from(pages) * 10))
        .map(|r| format!("mac={} master={} ch={} rx={} type={} fans={} tail={:02x} accepted={}",
            hex(&r[..6]), hex(&r[6..12]), r[12], r[13], r[18], r[19], r[41], parse_record(r).is_some()))
        .collect::<Vec<_>>().join(" | ");
    format!("pages={pages} bytes={} declared={} slots={} [{}]", resp.len(), resp[1], (resp.len()-4)/RECORD_LEN, records)
}

fn parse_get_dev(resp: &[u8], pages: u8) -> Result<Snapshot> {
    anyhow::ensure!(
        resp.len() >= 4 && resp[0] == USB_CMD_SEND_RF,
        "RX 回复无效（{} 字节，开头 {}）",
        resp.len(),
        hex(&resp[..resp.len().min(8)])
    );
    let count = usize::from(resp[1]).min(usize::from(pages) * 10);
    // [2] 最高位为 1 表示没有主板 PWM 信号；否则 [2]&0x7F 是低电平时间、[3] 是高电平时间。
    let mb_pwm = if resp[2] >> 7 == 1 {
        None
    } else {
        let off = u16::from(resp[2] & 0x7F);
        let on = u16::from(resp[3]);
        (255 * on).checked_div(off + on).map(|d| d.min(255) as u8)
    };
    let records: Vec<&[u8]> = resp[4..].chunks_exact(RECORD_LEN).take(count).collect();
    let devices = records.iter().filter_map(|r| parse_record(r)).collect();
    // 类型 0xFF 的记录是同频道上的发射器（可能是我们自己，也可能是别人的）。
    let masters = records
        .iter()
        .filter(|r| r[41] == 0x1C && r[18] == 0xFF && r[0..6] != [0; 6])
        .map(|r| (r[0..6].try_into().unwrap(), r[12]))
        .collect();
    Ok(Snapshot { devices, mb_pwm, masters })
}

fn parse_record(r: &[u8]) -> Option<RfDevice> {
    // 0x1C 是有效记录的结尾标记；类型 0xFF 是别的发射器自己。
    if r[41] != 0x1C || r[18] == 0xFF || r[0..6] == [0; 6] {
        return None;
    }
    let be12 = |i: usize| u16::from_be_bytes([r[i] & 0x0F, r[i + 1]]);
    // fan_count ≥ 10 表示 SL-INF 从右侧串联，原型不处理这种反序。
    let fan_count = if r[19] >= 10 { r[19] - 10 } else { r[19] }.min(4);
    Some(RfDevice {
        mac: r[0..6].try_into().unwrap(),
        master: r[6..12].try_into().unwrap(),
        channel: r[12],
        rx_type: r[13],
        dev_type: r[18],
        fan_count,
        fan_types: r[24..28].try_into().unwrap(),
        rpm: [be12(28), be12(30), be12(32), be12(34)],
        pwm: r[36..40].try_into().unwrap(),
        effect_index: r[20..24].try_into().unwrap(),
        cmd_seq: r[40],
        mb_light_sync: r[28] & 0x40 != 0,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(dev_type: u8, fan_count: u8, fan_type: u8) -> [u8; RECORD_LEN] {
        let mut r = [0u8; RECORD_LEN];
        r[..6].copy_from_slice(&[1, 2, 3, 4, 5, 6]);
        r[6..12].copy_from_slice(&[9; 6]);
        r[12] = 8;
        r[13] = 2;
        r[18] = dev_type;
        r[19] = fan_count;
        r[24..28].fill(fan_type);
        r[41] = 0x1C;
        r
    }

    #[test]
    fn rx_diagnostic_distinguishes_missing_and_rejected_records() {
        assert!(describe_rx(&[], 1).contains("bytes=0"));
        let mut reply = vec![0x10, 1, 0x80, 0];
        reply.extend_from_slice(&record(0, 3, 27));
        let accepted = describe_rx(&reply, 1);
        assert!(accepted.contains("declared=1 slots=1"));
        assert!(accepted.contains("fans=3 tail=1c accepted=true"));
        *reply.last_mut().unwrap() = 0;
        assert!(describe_rx(&reply, 1).contains("tail=00 accepted=false"));
        assert!(describe_rx(&[0x10, 0, 0x80, 0], 1).contains("declared=0 slots=0"));
    }

    #[test]
    fn only_known_tl_wireless_groups_are_writable() {
        assert!(parse_record(&record(0,3,27)).unwrap().supports_fan_control());
        assert!(parse_record(&record(0,1,35)).unwrap().supports_fan_control());
        assert!(!parse_record(&record(0,0,27)).unwrap().supports_fan_control());
        assert!(!parse_record(&record(65,3,27)).unwrap().supports_fan_control());
        assert!(!parse_record(&record(0,3,51)).unwrap().supports_fan_control());
        let dev=parse_record(&record(0,3,27)).unwrap();
        let f=rf_header(0x12,&dev,&[9;6],8);
        assert_eq!(f[0],0x12);assert_eq!(f[1],0x12);assert_eq!(&f[2..8],&dev.mac);
    }

    #[test]
    fn pwm_packet_matches_reference_layout() {
        // 与 lian-li-linux fan_speed.rs 的测试向量一致。
        let dev = parse_record(&record(0, 3, 20)).unwrap();
        let rf = pwm_packet(&dev, &[9; 6], 8, 3, [6, 6, 6, 6]);
        assert_eq!(
            &rf[..21],
            &[0x12, 0x10, 1, 2, 3, 4, 5, 6, 9, 9, 9, 9, 9, 9, 2, 8, 3, 6, 6, 6, 6]
        );
        assert_eq!(rf.len(), RF_DATA_SIZE);
    }

    #[test]
    fn bind_frame_matches_reference_layout() {
        // 与 lian-li-linux bind.rs 的测试向量一致。
        let mut dev = parse_record(&record(0, 3, 20)).unwrap();
        dev.pwm = [100, 150, 200, 0];
        let f = bind_frame(&dev, &[9; 6], 7, 8, 2);
        assert_eq!(&f[..21], &[0x12, 0x10, 1, 2, 3, 4, 5, 6, 9, 9, 9, 9, 9, 9, 7, 8, 2, 100, 150, 200, 0]);
        assert!(f[21..].iter().all(|&b| b == 0));
        let unbind = bind_frame(&dev, &[0; 6], 0, 8, 0);
        assert_eq!(&unbind[8..17], &[0, 0, 0, 0, 0, 0, 0, 8, 0]);
        // 报告 PWM 全 0 的设备（未绑定的冷头）用官方默认 100，不能把泵设成 0。
        dev.pwm = [0; 4];
        assert_eq!(&bind_frame(&dev, &[9; 6], 1, 8, 2)[17..21], &[100; 4]);
    }

    #[test]
    fn get_dev_reports_other_transmitters() {
        let mut resp = vec![0u8; 512];
        resp[0] = USB_CMD_SEND_RF;
        resp[1] = 2;
        resp[2] = 0x80;
        resp[4..46].copy_from_slice(&record(0, 3, 30));
        let mut master = record(0xFF, 0, 0);
        master[0] = 7;
        master[12] = 11;
        resp[46..88].copy_from_slice(&master);
        let snap = parse_get_dev(&resp, 1).unwrap();
        assert_eq!(snap.devices.len(), 1);
        assert_eq!(snap.masters, vec![([7, 2, 3, 4, 5, 6], 11)]);
    }

    #[test]
    fn constraints_clear_missing_slots_and_dodge_cl_values() {
        let cl = parse_record(&record(0, 3, 126)).unwrap();
        assert_eq!(constrain_pwm(&cl, [154, 155, 10, 200]), [152, 156, 25, 0]);
        let aio = parse_record(&record(DEV_TYPE_H2_SQUARE, 3, 0)).unwrap();
        assert_eq!(constrain_pwm(&aio, [100, 100, 100, 200])[3], 200);
    }

    #[test]
    fn get_dev_parses_records_and_mb_pwm() {
        let mut resp = vec![0u8; 512];
        resp[0] = USB_CMD_SEND_RF;
        resp[1] = 2;
        resp[2] = 0x40; // 低电平 64
        resp[3] = 64; // 高电平 64 → 50%
        resp[4..46].copy_from_slice(&record(DEV_TYPE_H2_SQUARE, 3, 0));
        let mut master = record(0xFF, 0, 0);
        master[0] = 7;
        resp[46..88].copy_from_slice(&master);
        let snap = parse_get_dev(&resp, 1).unwrap();
        assert_eq!(snap.mb_pwm, Some(127));
        assert_eq!(snap.devices.len(), 1);
        assert!(snap.devices[0].is_aio());
    }

    #[test]
    fn rpm_fields_mask_status_bits() {
        let mut r = record(0, 1, 40);
        r[28] = 0x65; // 高 4 位是状态位
        r[29] = 0x00;
        assert_eq!(parse_record(&r).unwrap().rpm[0], 0x0500);
    }
}
