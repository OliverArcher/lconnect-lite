//! WinUSB 设备的最小封装：按 VID/PID 打开、认领接口 0、在 EP 0x01/0x81 上收发。

use anyhow::{Context, Result};
use rusb::{Device, DeviceHandle, GlobalContext, TransferType};
use std::time::Duration;

const EP_OUT: u8 = 0x01;
const EP_IN: u8 = 0x81;

/// Read-only USB enumeration: does not open, claim, reset, or send to matching devices.
pub fn device_present(ids: &[(u16,u16)]) -> Result<bool> {
    for device in rusb::devices()?.iter() {
        if let Ok(desc)=device.device_descriptor() {
            if ids.contains(&(desc.vendor_id(),desc.product_id())) {return Ok(true);}
        }
    }
    Ok(false)
}

pub struct UsbDev {
    /// 只在 `reopen` 的关闭与重新打开之间为空。
    handle: Option<DeviceHandle<GlobalContext>>,
    in_interrupt: bool,
    out_interrupt: bool,
    pub vid: u16,
    pub pid: u16,
}

impl UsbDev {
    /// 打开列表中第一个存在的设备；一个都没插时返回 `Ok(None)`。
    pub fn open_any(ids: &[(u16, u16)], name: &str) -> Result<Option<Self>> {
        for device in rusb::devices()?.iter() {
            let Ok(desc) = device.device_descriptor() else {
                continue;
            };
            if ids.contains(&(desc.vendor_id(), desc.product_id())) {
                return Self::open(device, desc.vendor_id(), desc.product_id(), name).map(Some);
            }
        }
        Ok(None)
    }

    /// 关掉再重新打开同一个设备。冷头推送灯圈后会停止应答，只有重开句柄才能恢复。
    /// WinUSB 是独占的：旧句柄必须先彻底关掉，否则新的打开会被拒绝。
    pub fn reopen(&mut self, name: &str) -> Result<()> {
        if let Some(h) = self.handle.take() {
            let _ = h.release_interface(0);
        }
        let mut last_err = None;
        for _ in 0..5 {
            std::thread::sleep(Duration::from_millis(100));
            match Self::open_any(&[(self.vid, self.pid)], name) {
                Ok(Some(mut fresh)) => {
                    self.handle = fresh.handle.take();
                    self.in_interrupt = fresh.in_interrupt;
                    self.out_interrupt = fresh.out_interrupt;
                    return Ok(());
                }
                Ok(None) => last_err = Some(anyhow::anyhow!("设备不见了")),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap()).with_context(|| format!("重新打开 {name} 失败"))
    }

    fn h(&self) -> Result<&DeviceHandle<GlobalContext>> {
        self.handle.as_ref().context("USB 设备正在重新打开")
    }

    fn open(device: Device<GlobalContext>, vid: u16, pid: u16, name: &str) -> Result<Self> {
        let (in_interrupt, out_interrupt) = endpoint_types(&device);
        let handle = device.open().with_context(|| {
            format!("打开 {name} 失败：L-Connect 服务可能还占着设备，先停掉 LConnectService")
        })?;
        handle
            .claim_interface(0)
            .with_context(|| format!("认领 {name} 接口 0 失败（设备被其他程序占用？）"))?;
        Ok(Self {
            handle: Some(handle),
            in_interrupt,
            out_interrupt,
            vid,
            pid,
        })
    }

    pub fn write(&self, data: &[u8], timeout: Duration) -> Result<()> {
        let timeout = timeout.max(Duration::from_millis(1));
        let n = if self.out_interrupt {
            self.h()?.write_interrupt(EP_OUT, data, timeout)?
        } else {
            self.h()?.write_bulk(EP_OUT, data, timeout)?
        };
        anyhow::ensure!(n == data.len(), "USB 短写：{n}/{} 字节", data.len());
        Ok(())
    }

    /// 读一次；超时返回 0 而不是错误。
    pub fn read(&self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        // libusb 的超时以毫秒计，0 表示无限等待：剩余时间不足 1 ms 时也按 1 ms 算。
        let timeout = timeout.max(Duration::from_millis(1));
        let res = if self.in_interrupt {
            self.h()?.read_interrupt(EP_IN, buf, timeout)
        } else {
            self.h()?.read_bulk(EP_IN, buf, timeout)
        };
        match res {
            Ok(n) => Ok(n),
            Err(rusb::Error::Timeout) => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    /// 丢掉管道里残留的旧回复，直到 20 ms 内没有新数据。
    /// RX 的多块回复之间会停顿几毫秒，等得太短会把后半截留给下一轮。
    pub fn flush(&self) {
        let mut buf = [0u8; 512];
        for _ in 0..64 {
            match self.read(&mut buf, Duration::from_millis(20)) {
                Ok(n) if n > 0 => continue,
                _ => break,
            }
        }
    }

    /// 按 64 字节块连续读，直到设备不再发数据（对应官方 WinUsb.ReadAll）。
    pub fn read_until_silence(
        &self,
        buf: &mut [u8],
        first_timeout: Duration,
        chunk_timeout: Duration,
    ) -> Result<usize> {
        let mut chunk = [0u8; 64];
        let mut total = 0;
        let mut timeout = first_timeout;
        while total < buf.len() {
            let n = self.read(&mut chunk, timeout)?;
            if n == 0 {
                break;
            }
            let n = n.min(buf.len() - total);
            buf[total..total + n].copy_from_slice(&chunk[..n]);
            total += n;
            timeout = chunk_timeout;
        }
        Ok(total)
    }
}

impl Drop for UsbDev {
    fn drop(&mut self) {
        if let Some(h) = &self.handle {
            let _ = h.release_interface(0);
        }
    }
}

fn endpoint_types(device: &Device<GlobalContext>) -> (bool, bool) {
    let Ok(config) = device.active_config_descriptor() else {
        return (false, false);
    };
    let mut in_interrupt = false;
    let mut out_interrupt = false;
    for iface in config.interfaces() {
        for desc in iface.descriptors() {
            for ep in desc.endpoint_descriptors() {
                let interrupt = ep.transfer_type() == TransferType::Interrupt;
                if ep.address() == EP_IN && interrupt {
                    in_interrupt = true;
                }
                if ep.address() == EP_OUT && interrupt {
                    out_interrupt = true;
                }
            }
        }
    }
    (in_interrupt, out_interrupt)
}
