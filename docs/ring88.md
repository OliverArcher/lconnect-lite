# 8.8 灯环（USB 灯环隔离模块）

本文描述 `lconnect-lite-0.2.1` 里新增的 8.8 灯环支持：协议来源、字节布局、对外 API、
已实现的效果，以及**尚未在硬件上验证**的部分。

代码位置：

| 内容 | 文件 |
| --- | --- |
| USB 数据层 | `crates/lcl-devices/src/ring88.rs` |
| 灯效渲染 | `crates/lcl-effects/src/ring88.rs` |
| 守护线程 | `crates/lcl-daemon/src/ring_service.rs` |
| 导出 | `crates/lcl-devices/src/lib.rs`、`crates/lcl-effects/src/lib.rs` |

---

## 1. 设备身份

| 项 | 值 |
| --- | --- |
| VID | `0x0416`（1046） |
| PID | `0x8050`（32848） |
| 官方设备名 | `UniversalScreen8p8InchLighting`（`LConnectCore.Devices/KnownDevices.cs:48`） |
| LED 数 | 60 |
| 每帧原始颜色 | 180 字节（60 × RGB） |
| USB 包 | 每帧 3 个 64 字节包 |

**和 LP 冷头完全是两个设备。** LP 冷头是 `0x1CBE:0xA088`，本模块只认 `0x0416:0x8050`，
不会去开 LP 的显示接口，也从不发送显示/复位类命令——本模块只写灯效数据包（命令号 17）。
`Ring88::open()` 打开后会再核对一次 VID/PID，不匹配直接报错。

同一块 8.8 英寸屏上有三个 USB 接口（见 `tools/lianli88.py` 的设备说明）：

| 接口 | VID:PID | 说明 |
| --- | --- | --- |
| LCD / 视频 | `0x1CBE:0xA088` | WinUSB，EP1 OUT / EP1 IN（512 字节中断） |
| HID 控制 | `0x1A86:0xAD21` | 旋钮/按键 |
| RGB / 灯环 | `0x0416:0x8050` | 本模块负责的灯效接口 |

也就是说灯环和屏幕是同一块面板，但**不同的 USB 设备条目**：屏幕侧被 L-Connect 独占时，
灯环接口通常也会被一起占用（L-Connect 打开 LED88 时会 `InitDev` 认领它）。
`tools/lianli88.py probe` 可以一次列出这三个接口的在场情况。

官方 `WinUsbLed` 里还有一组 `0x7358:0xA088`（`LCD_88inchPid = 41096`）的旧标识，
那是同一设备的旧固件标识，本模块没有采用，也没有在真机上确认过。

## 2. 协议

逆向证据：`decompiled/lcd207/lcd207/LEDController.cs:1663+`（`SetEffect`）与
`decompiled/lcd207/lcd207/WinUsbLed.cs`。

### 2.1 帧与包

一帧 = 180 字节颜色，按 20 颗 LED（60 字节）切成 3 个 64 字节的 USB 包，依次写出：

```
包偏移   长度   含义
0        1      命令号，固定 17 (0x11)
1        1      本包第一颗 LED 的序号：0 / 20 / 40
2        2      0（官方从不赋值）
4        60     20 颗 LED 的颜色，每颗 3 字节
```

对应的官方代码：

```csharp
sendData[0] = 17;
sendData[1] = (byte)(i * 20);
Array.Copy(effectData, i * 60 + curFrameNum * frameLen, sendData, 4, 60);
ledUsb?.SendAndRead(sendData, isRead: false);
```

`frameLen` 固定 180，`effectData` 是「帧 → LED → RGB」的连续字节流。

### 2.2 时序

- 官方写灯效包时 `isRead: false`，**设备不回包**。本模块同样只写不读。
- 帧间隔由主机控制：官方用 `interval`（单位 0.625 ms 的设备 tick），
  实际睡眠 `interval * 0.625 ms`，并扣掉本次发送耗时。
- 设备没有内置效果引擎：静态色官方也只发 1 帧并循环重发，其余效果由主机逐帧推。

本模块里 `Animation::interval_hundredths` 的单位与项目其他地方一致：
**百分之一 tick**，1 tick = 0.625 ms。守护进程推帧时用
`ticks = interval_hundredths / 100`（`Ring88::push_animation` 的 `interval_ticks` 参数）。

### 2.3 颜色字节序（未验证）

官方是把渲染好的颜色字节**整段拷贝**进包里，反编译代码里看不出通道顺序是
R,G,B 还是 G,R,B，本项目**没有在真机上验证过**。

默认按 **R,G,B** 写。为了 bring-up 时只改一处，设备层留了开关：

```rust
ring.set_channel_order(LedChannelOrder::Rgb);   // 默认
ring.set_channel_order(LedChannelOrder::Grb);   // 真机发现红绿互换时改这个
```

`LedChannelOrder::Grb` 只交换每颗 LED 的前两个字节，包头和 LED 顺序不动。

## 3. 对外 API

### 3.1 `lcl-devices`

```rust
use lcl_devices::ring88::{Ring88, LedChannelOrder, LED_COUNT};

let mut ring = Ring88::open()?;               // Ok(None) = 设备没插
let Some(mut ring) = ring else { return Ok(()) };

ring.push_frame(&[[r, g, b]; 60])?;           // 推一帧
ring.push_animation(&frames, interval_ticks)?;// 推整段并按节奏限速
ring.set_channel_order(LedChannelOrder::Grb);
ring.flush_input();                            // 清掉输入端残留数据
```

| API | 说明 |
| --- | --- |
| `Ring88::open() -> Result<Option<Self>>` | 打开第一个 `0x0416:0x8050`；没插返回 `Ok(None)`，不会自己重试或轮询 |
| `Ring88::push_frame(&[[u8;3];60]) -> Result<()>` | 写 3 个包，设备不回包 |
| `Ring88::push_animation(&[Vec<[u8;3]>], interval_ticks) -> Result<()>` | 逐帧写并限速；帧数/帧长/tick 都会校验 |
| `Ring88::set_channel_order` / `channel_order` | 颜色通道顺序 |
| `Ring88::flush_input` | 丢弃输入端残留数据 |
| `encode_frame(frame, order) -> [[u8;64];3]` | 纯函数，包布局的可见形式（测试与文档用） |
| `LED_COUNT` / `FRAME_BYTES` / `PACKET_COUNT` / `CMD_LED_DATA` | 常量 |

`Ring88::open()` **不会**自动打开设备、不会自动推送、不会在析构时做任何恢复动作。
所有对真机的动作都由调用方显式触发。

### 3.2 `lcl-effects`

```rust
use lcl_effects::ring88::{render, supported_parameters};

let animation = render(&effect)?;                 // 60 颗 LED 的逐帧颜色
let caps = supported_parameters();                 // Vec<RgbEffectParameters>
```

| API | 说明 |
| --- | --- |
| `ring88::render(&RgbEffect) -> Result<Animation>` | 渲染动画；不支持的模式返回 `Err`（含 `unsupported`） |
| `ring88::supported_parameters() -> Vec<RgbEffectParameters>` | 各模式可调的颜色数/方向/是否支持速度 |
| `ring88::MODES` | 支持的模式清单 |
| `ring88::LED_COUNT` | 60 |

根导出：`lcl_effects::render_ring88`、`lcl_effects::ring88_parameters`；
设备层根导出：`lcl_devices::Ring88`、`lcl_devices::LedChannelOrder`、`lcl_devices::RING88_ID(S)`。

## 4. 已实现的效果

设备没有内置效果，全部由主机渲染。**只实现 6 种**，其余模式一律返回
`unsupported 8.8 ring RGB mode: …`，不假装支持官方那 19 种：

| 模式 | 帧数 | 说明 |
| --- | --- | --- |
| `Off` | 1 | 整圈熄灭 |
| `Static` | 1 | 单色（设备会保持最后一帧） |
| `Rainbow` | 60 | 色相沿灯环铺开，每帧前进一步 |
| `Breathing` | 100 | 亮度 0→1→0 往返 |
| `Wave` | 60 | 一道亮带沿灯环跑 |
| `RainbowMorph` | 60 | 整圈同时做色相渐变 |

参数（`supported_parameters()` 的口径）：

- 颜色：静态/呼吸/波浪各 1 色，其余 0 色；调色板上限仍是项目统一的 4 色。
- 方向：只有 `Rainbow`、`Wave`、`RainbowMorph` 有方向，取值只有顺时针/逆时针；
  其余方向（Up/Down/Spread/Gather）在这些模式下直接报错。
- 速度：0-4，帧间隔 = 基准 tick × [7,6,5,4,3]。`Off`/`Static` 不支持速度。
- 亮度：0-4 映射到 0/64/128/192/255；`BRIGHTNESS_OFF`（255）当作熄灯。
- 作用域：只支持整圈（`RgbScope::All`）。

这些效果是本项目自己写的节奏，**没有**与官方逐帧比对过。

## 5. 未验证项（务必在真机上确认）

1. **没有在真机上跑过。** 本模块只做了纯函数层面的测试，包不会真的发出去。
2. **颜色通道顺序未知**：R,G,B 是默认假设，红绿互换的可能性没有排除。
3. **时序未标定**：200 ms 写超时、0.625 ms tick 的换算、实际帧率是否被固件限速，都没测过。
4. **端点未核对**：`UsbDev` 固定用 EP 0x01 写、0x81 读（bulk/interrupt 自动判断）。
   灯环接口的实际端点号没有确认过；官方 `WinUsbLed` 走的是自己的 `InitDev` 管道。
4. **LED 序号方向未知**：第 0 颗 LED 在物理环上的位置、以及 `sendData[1]` 的 0/20/40
   是否真的表示首颗 LED 序号（从字节形态看很像，但没有文档佐证），都没验证。
5. **效果与官方不一致**：官方 `RgbEffect.Get88LedData` 的算法没有移植，
   本模块的 6 种效果是自研版本。
6. **多设备**：同一台机器插多个灯环时，`Ring88::open()` 只开第一个。

## 6. 真机 bring-up 清单（手动执行，勿自动化）

以下步骤需要人守着做，**不要**写进守护进程的自动流程：

1. 确认设备枚举：`VID_0416&PID_8050`，且没有被 L-Connect 服务占着（WinUSB 独占）。
   注意灯环和 8.8 英寸屏的 LCD 接口（`0x1CBE:0xA088`）是同一块面板，L-Connect 会一起占着。
2. 静态色：`push_frame` 推一帧纯红 / 纯绿 / 纯蓝，确认：
   - 红绿是否互换（决定 `LedChannelOrder`）；
   - 是否有通道缺失（说明不是 RGB 三通道）。
3. 逐颗定位：推「只有第 N 颗亮」的帧（N = 0..59），确认 LED 序号与环上物理位置的对应关系。
4. 断点：推一帧后立刻拔电重插，看灯环是否保持最后一帧（验证「设备无内置引擎、只保持最后收到的帧」）。
5. 节奏：推彩虹效果，观察实际刷新率与目标 tick 是否一致，必要时调小 `BASE_INTERVAL_TICKS`。
6. 长时间稳定性：连续推 10 分钟，看固件是否掉线、是否需要重新 `open()`。

## 7. 守护进程侧（已实现）

模块：`crates/lcl-daemon/src/ring_service.rs`，由守护进程单独起一条线程。

```rust
pub fn run(
    stop: &AtomicBool,
    devices_enabled: bool,
    snapshot: impl Fn() -> Ring88Config,
    publish: impl Fn(Ring88Status),
)
```

行为：

- **独立线程**：只碰灯环 PID（`0x0416:0x8050`），不开显示接口，不发显示/复位命令。
- **三档语义**：
  - `enabled = false`：**不接管**。不打开设备，也不发任何数据，灯保持设备最后收到的画面。
    想熄灯请用下一档。
  - `enabled = true` + `effect.mode = Off`：接管并推一帧全黑，即熄灯。
  - `enabled = true` + 其它模式：接管并持续推帧。
- **渲染一次、缓存**：配置里的效果没变就复用已渲染的帧，不重复渲染；
  效果变了就重新渲染并从第一帧开始。
- **绝对时间点调度**：帧间隔取自 `Animation::interval_hundredths`（百分之一 tick，
  1 tick = 0.625 ms），按 deadline 推帧而不是「推完再睡」，不会累积误差。
- **只用 `push_frame`**：不用 `push_animation`（它会阻塞整段动画，期间换不了配置、也停不下来）。
- **掉线退避**：写失败就丢掉句柄、记错误，5 秒后重开；设备没插时同样 5 秒一次重试，不会空转。
- **`stop` 可快速生效**：所有睡眠按 50 ms 分片，置位后最多 50 ms 退出。
- **`devices_enabled = false`**：整条线不启动，一个设备都不开。
- **状态上报**：只在状态变化时上报；`external_display` 恒为 `true`（8.8 灯环是外接面板上的显示）。

单位换算集中在 `lcl_devices::ring88`：

```rust
duration_from_hundredths(100)        // = 625 µs（1 tick）
ticks_from_hundredths(4_000)         // = 40 tick
lcl_effects::ring88::interval_ticks(&animation)  // Animation → tick
```

上层（`service.rs`）的接线方式：

```rust
let ring = {
    let (shared, stop) = (Arc::clone(&shared), Arc::clone(&stop));
    std::thread::spawn(move || {
        crate::ring_service::run(
            &stop,
            devices_enabled,
            || shared.lock().unwrap().config.ring88.clone(),
            |status| shared.lock().unwrap().ring88 = status,
        )
    })
};
```

## 8. 测试

```powershell
cargo test -p lcl-devices -p lcl-effects -p lcl-daemon
```

覆盖内容：

- `lcl-devices::ring88`：常量自洽（180 字节 = 3 包 × 60 字节 = 60 颗 LED）、
  包头（命令号 17 / 序号 0-20-40 / `[2..4]` 为 0）、每颗 LED 落在正确的包里、
  R,G,B 与 G,R,B 两种顺序的差异只落在前两个通道、一帧恰好 180 个颜色字节。
- `lcl-effects::ring88`：6 种模式都能渲染出 60 颗 LED 的整帧、
  不支持的模式返回 `unsupported`、熄灯与 `disabled` 产出全黑帧、
  亮度档换算、彩虹方向反转的镜像关系、速度与帧间隔的关系、
  `supported_parameters()` 与渲染器实际用到的参数一致、非法输入被拒绝。
- `lcl-daemon::ring_service`：配置指纹随效果变化、状态不变就不上报、
  tick 与毫秒的换算、渲染出来的帧长度都是 60。

这些测试全部是纯计算，**不接触任何硬件**。
