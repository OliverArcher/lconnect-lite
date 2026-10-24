//! 灯效下发：按配置渲染，无线风扇上传后靠 GetDev 记录里的 effect_index 确认，
//! 不一致（上传没生效、或固件空闲重置回了默认效果）就退避重传；冷头灯圈配置变化时推送一次。

use crate::log;
use lcl_core::config::Lighting;
use lcl_devices::h2::H2;
use lcl_devices::rgb::RgbUpload;
use lcl_devices::wireless::{RfDevice, Snapshot, Wireless};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 首次重传的等待，之后翻倍，最长 30 秒。
const RETRY_BASE: Duration = Duration::from_millis(1500);
const RETRY_MAX: Duration = Duration::from_secs(30);
/// 冷头推送失败后多久再试。每次推送会让冷头短暂停止应答，不能频繁重试。
const PUMP_RETRY: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct LightingCtl {
    /// 每个风扇组：(渲染输入的摘要, 打包好的上传)。配置不变就不重新渲染。
    uploads: HashMap<[u8; 6], (String, RgbUpload)>,
    /// 每个风扇组：(上次上传时间, 连续未生效次数)。
    attempts: HashMap<[u8; 6], (Instant, u32)>,
    suspended: HashMap<[u8;6],Instant>,
    pump_applied: Option<String>,
    pump_attempt: Option<Instant>,
}

/// TL V2 风扇（LED / LCD 版），渲染器按这种布局（每风扇 26 颗）出帧。
fn is_tl(dev: &RfDevice) -> bool {
    dev.supports_fan_control()
}

impl LightingCtl {
    pub fn suspend(&mut self,address:[u8;6],duration:Duration) { self.suspended.insert(address,Instant::now()+duration); }
    /// 无线风扇组：发现不一致就上传。返回需要报告的错误。
    pub fn drive_fans(&mut self, cfg: &Lighting, wl: &mut Wireless, snap: &Snapshot, errors: &mut Vec<String>) {
        let groups: Vec<RfDevice> = wl.own_devices(snap).into_iter().filter(|(_, d)| d.supports_fan_control()).map(|(_, d)| d.clone()).collect();
        for dev in groups {
            if self.suspended.get(&dev.mac).is_some_and(|until|Instant::now()<*until) {continue;}
            let group=cfg.groups.iter().find(|g|g.address.eq_ignore_ascii_case(&dev.mac_str()));
            let enabled=group.map_or(cfg.enabled,|g|g.enabled);
            if !enabled {continue;}
            let regions=group.map_or(cfg.fans.as_slice(),|g|g.regions.as_slice());
            if !is_tl(&dev) {
                errors.push(format!("{}：暂只支持 TL 无线风扇的灯效", dev.kind()));
                continue;
            }
            let key = format!("{:?}/{}", regions, dev.fan_count);
            if self.uploads.get(&dev.mac).is_none_or(|(k, _)| *k != key) {
                let built = lcl_effects::tl::render(regions, usize::from(dev.fan_count))
                    .and_then(|a| RgbUpload::new(&a.frames, a.interval_hundredths));
                match built {
                    Ok(up) => {
                        self.uploads.insert(dev.mac, (key, up));
                        self.attempts.remove(&dev.mac);
                    }
                    Err(e) => {
                        errors.push(format!("风扇灯效：{e:#}"));
                        continue;
                    }
                }
            }
            let (_, upload) = &self.uploads[&dev.mac];
            if dev.effect_index == upload.effect_index {
                if let Some((at, n)) = self.attempts.remove(&dev.mac) {
                    log::line(&format!("{} 灯效已生效（上传 {n} 次，最后一次 {} ms 前）", dev.mac_str(), at.elapsed().as_millis()));
                }
                continue;
            }
            let due = self.attempts.get(&dev.mac).is_none_or(|(at, n)| at.elapsed() >= backoff(*n));
            if !due {
                continue;
            }
            let n = self.attempts.get(&dev.mac).map_or(0, |(_, n)| *n);
            if n == 3 {
                log::line(&format!("{} 灯效连续 3 次没有生效，继续重试", dev.mac_str()));
            }
            match wl.upload_rgb(&dev, upload) {
                Ok(()) if n == 0 => log::line(&format!(
                    "{} 上传灯效：{} 包，effect_index {:02x?}",
                    dev.mac_str(),
                    upload.packet_count(),
                    upload.effect_index
                )),
                Ok(()) => {}
                Err(e) => errors.push(format!("风扇灯效上传：{e:#}")),
            }
            self.attempts.insert(dev.mac, (Instant::now(), n + 1));
        }
    }

    /// 冷头灯圈（USB）：配置变了才推送。推送成功返回 true，调用方要随后重发泵速。
    pub fn drive_pump(&mut self, cfg: &Lighting, h2: &mut H2, errors: &mut Vec<String>) -> Result<bool, anyhow::Error> {
        if !cfg.enabled {
            return Ok(false);
        }
        let key = format!("{:?}", cfg.pump);
        if self.pump_applied.as_deref() == Some(key.as_str()) || self.pump_attempt.is_some_and(|t| t.elapsed() < PUMP_RETRY) {
            return Ok(false);
        }
        self.pump_attempt = Some(Instant::now());
        let anim = match lcl_effects::h2::render(&cfg.pump, 24) {
            Ok(a) => a,
            Err(e) => {
                errors.push(format!("冷头灯效：{e:#}"));
                return Ok(false);
            }
        };
        let ticks = u8::try_from(anim.interval_hundredths / 100).unwrap_or(u8::MAX).max(1);
        h2.push_ring(&anim.frames, ticks)?;
        log::line(&format!("冷头灯效已推送：{:?}", cfg.pump.mode));
        self.pump_applied = Some(key);
        Ok(true)
    }
}

fn backoff(failures: u32) -> Duration {
    (RETRY_BASE * 2u32.saturating_pow(failures.saturating_sub(1))).min(RETRY_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff(1), RETRY_BASE);
        assert_eq!(backoff(2), RETRY_BASE * 2);
        assert_eq!(backoff(10), RETRY_MAX);
    }
}
