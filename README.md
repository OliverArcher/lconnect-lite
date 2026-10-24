# LConnect Lite 0.3.0

联力 L-Connect 3 的轻量替代程序。本仓库 fork 自 [CreeperUX/lconnect-lite](https://github.com/CreeperUX/lconnect-lite)，基于上游 0.2.1 增加无线风扇组独立控制、设备管理和通用屏灯框入口，保留原有水冷功能。

## 相比上游的改动

- **无线风扇组独立调速**：一个无线设备对应一个控制项。每组可分别设置固定 PWM、温度曲线、采样源、采样点、采样周期、平滑、回差、降速延迟和升降速限制；组内统一转速控制。仅覆盖无线设备，不增加有线设备适配。
- **命名与定位**：设备名称按 MAC 保存，增加原生 RF Select 闪灯识别入口。修复命名对话框点击确定和 Enter 无法提交的问题。
- **按组灯效**：复用现有 TL 灯效渲染、压缩及上传，按组保存配置，并保留全部、上弧和下弧分区。
- **扁平的灯效设备选择**：风扇组、冷头灯框和“通用屏灯框”处于同一层级。通用屏底部只显示简洁检测状态。
- **概览显示所有风扇组**：按名称分别显示各组、组内转速及在线情况，保留已配置但暂时离线的组，修复旧概览只读取 `fan_groups[0]` 的问题。
- **8.8 通用屏灯框**：增加独立灯环模块与配置入口。灯环控制接口 `0416:8050` 与显示接口 `1CBE:A088` 分离；显示内容继续交给 [Libre Panel](https://github.com/syntensa/libre-panel)。灯环功能仍属实验性，尚未完成真机验收。
- **冷头内容宿主**：新增可选进程 `lcl-display-host`，负责主题、图片和 GIF 的渲染，经命名管道提交画面。后台仍持有唯一冷头 USB 句柄，避免屏幕与泵抢占设备。
- **配置与诊断**：配置按段合并、串行写入，降低页面并发覆盖风险；补充无线 RX 错误、记录变化日志。完整原始回包仅在显式设置 `LCL_RX_TRACE=1` 时输出，正常使用无需开启。

## 当前验证状态

TL120 ×1、TL140 ×3 两组已实测独立调速；后续调试出现过连接回报间歇缺失、转速/PWM 遥测冻结。最终用户报告恢复正常时，运行的是当前界面与 2026-10-22 21:00 历史后端的组合。该后端 SHA256：

```text
e8b847c67741d5a9913519025558e0b5e57bc4e1b4a3e775b932befc1de1b2af
```

**本次仅更新源码，没有发布安装包或 Release。仓库源码包含后续通用屏接口只读检测、独立显示宿主和诊断改动，不能将从本提交重新构建的后端直接视为上述历史二进制的逐字节复现，也不声明遥测问题已由某个补丁根治。** 未部署过的“仅 PWM 偏差超过阈值才发送”推测性补丁不包含在本次提交中。正在使用的正常安装目录不因本次源码上传而改变。

通用屏灯环、闪灯定位目标、冷头独立宿主和安装升级路径仍需分别验收。原项目硬件测试记录见 [docs/hardware-tests.md](docs/hardware-tests.md)，其中上游测试结果不代表新增路径已验证。

## 使用与边界

Windows x64；设备使用 WinUSB。不要让多个后台或官方 L-Connect 3 服务同时接管同一 USB 设备。

- 打开 `lcl-app.exe` 后，后台未运行时由界面明确启动；关闭界面不会退出后台，需从托盘退出。
- 固定值表示 PWM 百分比，不是精确 RPM 闭环。实际转速取设备回报；读数冻结不能单独证明调速下发失效。
- 每组统一调速，不提供组内各只风扇独立转速入口。首期可写能力限制为已识别的 TL V2 无线路径，其他型号只读识别。
- 8.8 画面由 Libre Panel 管理，本程序不打开、认领或复位其显示接口。
- 冷头媒体显示需要运行可选的 `lcl-display-host.exe`，它不直接打开 USB。
- CPU 温度和功耗依赖 `lcl-sensord` 与 PawnIO；普通便携使用不会自动安装或替换传感器系统服务。

配置：`%APPDATA%\LConnect Lite\config.toml`。后台日志：`%LOCALAPPDATA%\LConnect Lite\daemon.log`。登录前接管副本：`%ProgramData%\LConnect Lite\control.toml`。配置升级前请保留备份，旧版保存配置可能丢弃它不认识的字段。

## 开发与构建

需要 Rust MSVC 工具链、Visual Studio C++ Build Tools、Node.js 和 WebView2。第三方源码与许可保留在 `vendor/` 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

```powershell
cd app
npm ci
npm run check
npm run build
cd ..
cargo test --workspace
cargo build --release -p lcl-daemon -p lcl-sensord -p lcl-display-host
```

完整构建沿用上游 Tauri NSIS 方案：

```powershell
.\scripts\build-installer.ps1
```

输出 `target\release\bundle\nsis\LConnect Lite_0.3.0_x64-setup.exe`。脚本会从当前源码重新构建全部后端并打包，**不会自动选用上述历史后端**。安装器继承原项目每机安装、双语向导、PawnIO、传感器服务、计划任务和官方服务冲突处理钩子。本次没有构建、安装或发布该安装器，未来发布前须重新核对组件来源并测试升级与卸载行为。

只调界面可运行 `cd app; npm run dev`，浏览器中使用模拟数据。无设备服务模式：`lcl-daemon serve --no-devices`。协议与设计说明见 `docs/`。

## 许可与致谢

MIT，保留原作者和第三方许可。协议逻辑、灯效渲染、tinyuz 封装参考或移植自 [lian-li-linux](https://github.com/sgtaziz/lian-li-linux)，tinyuz 和 HDiffPatch 按原许可收录。感谢 CreeperUX 的原项目。与联力官方无关。
