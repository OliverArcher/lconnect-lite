import { invoke } from "@tauri-apps/api/core";
import { mockApi } from "./mock";

// 与 crates/lcl-core 的 Status / Config 一一对应。
export type Mode = "fixed" | "curve" | "motherboard";
/** 全局风扇曲线的温度源（保留下来的旧字段）。 */
export type TempSource = "coolant" | "gpu";
/** 单组曲线可选的采样源：水温 / GPU / CPU 封装温度。 */
export type GroupSource = TempSource | "cpu";
export type Point = [number, number];

export interface FanGroup {
  address: string;
  kind: string;
  rpm: number[];
  pwm: number[];
  /** 后台服务这一轮算出的目标占空比（%）；没有读数或不受控时为空。 */
  target_percent?: number | null;
  /** 这台组的采样源当前读不到数据的原因。 */
  source_error?: string | null;
  /** 这台组能否单独调速；不支持的组（未验证的系列、别的主机）界面上只读。 */
  supports_control?: boolean;
}
export interface WirelessDevice {
  address: string;
  kind: string;
  owner: "ours" | "unbound" | "other";
  master: string;
  fan_count: number;
  rx: number;
  channel: number;
  mb_light_sync: boolean;
  excluded: boolean;
}
export interface DeviceInfo { name: string; connection: string; address: string }

export interface Status {
  uptime_s: number;
  /** 8.8 灯环；没有这块硬件时为空。 */
  ring88?: Ring88Status | null;
  mode: Mode | null;
  /** 低通滤波后的水温，曲线用的就是它。 */
  coolant_c: number | null;
  /** 设备报告的原始水温（整数 °C）。 */
  coolant_raw_c: number | null;
  cpu_usage: number | null;
  /** CPU 封装温度和功耗（传感器服务 + PawnIO）；读不到时为 null，原因在 cpu_sensor_error。 */
  cpu_temp_c?: number | null;
  cpu_power_w?: number | null;
  cpu_sensor_error?: string | null;
  /** CPU 温度保护正在生效。 */
  cpu_guard?: boolean;
  /** 泵的功耗前馈当前加了多少 rpm。 */
  pump_boost_rpm?: number | null;
  gpu_temp_c: number | null;
  gpu_usage: number | null;
  gpu_power_w: number | null;
  mb_pwm_percent: number | null;
  boost_percent: number | null;
  pump_rpm: number | null;
  pump_target_rpm: number | null;
  fan_percent: number | null;
  fan_groups: FanGroup[];
  devices: DeviceInfo[];
  wireless: WirelessDevice[];
  /** [MAC, 频道] */
  transmitter: [string, number] | null;
  last_error: string | null;
  /** 后台服务自身的私有内存（MB）。 */
  memory_mb?: number | null;
}

export interface FanOverride {
  address: string;
  index: number;
  offset_percent: number;
  fixed_percent: number | null;
}

export interface Cooling {
  mode: Mode;
  fixed_fan_percent: number;
  fixed_pump_rpm: number;
  fan_curve: { points: Point[] };
  fan_source: TempSource;
  pump_curve: { points: Point[] };
  fan_slew_percent_per_s: number;
  cpu_boost_percent: number;
  gpu_boost_percent: number;
  /** CPU 功耗到 200 W 时泵额外加多少 rpm（50 W 以下不加）；0 关闭。 */
  pump_power_boost_rpm: number;
  /** CPU 温度保护上限（°C）；0 关闭。 */
  cpu_temp_limit_c: number;
  /** 旧版单风扇覆盖；界面已不再提供入口，只为读写旧配置保留。 */
  fan_overrides: FanOverride[];
  /** 每个无线风扇组一条独立策略（组内转速仍然统一）。 */
  groups: FanGroupPolicy[];
}

/**
 * 一组风扇的独立策略。组内所有风扇共用一个目标值，`address` 是组的无线地址（MAC）。
 * 没有对应条目的组沿用全局字段（`Cooling.mode` / `fan_curve` / `fixed_fan_percent`）。
 */
export interface FanGroupPolicy {
  address: string;
  mode: Mode;
  fixed_percent: number;
  source: GroupSource;
  curve: { points: Point[] };
  /** 采样间隔（毫秒）。 */
  sample_interval_ms: number;
  /** 读数的低通时间常数（毫秒），0 不平滑。 */
  smoothing_ms: number;
  /** 温度回差（°C），避免在拐点附近来回跳。 */
  hysteresis_c: number;
  /** 温度掉下来后等多久才降速（秒）。 */
  fall_delay_s: number;
  /** 升速限幅（%/秒）。 */
  slew_up_percent_per_s: number;
  /** 降速限幅（%/秒）。 */
  slew_down_percent_per_s: number;
  /** 读不到采样源时用的安全占空比（%）。 */
  fallback_percent: number;
}

/** 与 lcl-effects 的 RgbMode 变体名一致。 */
export type RgbMode = string;
export type RgbDirection = "Clockwise" | "CounterClockwise";
export type RgbScope = "All" | "Top" | "Bottom";
export type Rgb = [number, number, number];

export interface RgbEffect {
  mode: RgbMode;
  colors: Rgb[];
  /** 0-4 */
  speed: number;
  /** 0-4 */
  brightness: number;
  direction: RgbDirection;
  scope: RgbScope;
  disabled: boolean;
}

export interface RgbRegion { effect: RgbEffect; flip: boolean }

export interface LightingScene { name: string; fans: RgbRegion[]; pump: RgbEffect }

export interface Lighting {
  enabled: boolean;
  /** 全局风扇效果：没有被 `groups` 覆盖的组沿用这一份。 */
  fans: RgbRegion[];
  pump: RgbEffect;
  /** 用户保存的场景（后台服务不读）。 */
  scenes: LightingScene[];
  /** 按组覆盖的风扇效果。 */
  groups: GroupLighting[];
}

/** 一个无线风扇组的灯效；`regions` 的语义和全局 `fans` 一样（整体 / 上灯带 + 下灯带）。 */
export interface GroupLighting {
  address: string;
  enabled: boolean;
  regions: RgbRegion[];
}

export interface EffectParams {
  mode: RgbMode;
  min_colors: number;
  max_colors: number;
  per_fan_colors: boolean;
  directions: RgbDirection[];
  supports_speed: boolean;
}

export interface LightingCaps { fan_count: number; fans: EffectParams[]; pump: EffectParams[] }

/** 一段预览动画：每帧是 "rrggbb…" 串，每颗灯珠 6 个字符。 */
export interface Track { ms: number; frames: string[] }
/** 风扇是 fan_count × 26 颗（每只前 13 颗上灯带、后 13 颗下灯带），冷头灯框 24 颗。 */
export interface LightingPreview { fan: Track | null; pump: Track | null }

export type LcdMode ="unmanaged" | "dashboard" | "image" | "gif";

export type ThemeMode = "dark" | "light" | "auto";

export interface Lcd {
  mode: LcdMode;
  brightness: number;
  rotation: number;
  media_path: string;
  max_fps: number;
  offline_clock: boolean;
  /** 传感器主题 id。 */
  theme: string;
  theme_mode: ThemeMode;
  /** null 用主题默认色。 */
  accent: Rgb | null;
}

export interface ThemeMeta { id: string; name: string; tier: "flat" | "medium" | "fancy"; light: boolean; accent: Rgb }

export interface LcdState { description: string; error: string | null; preview_jpeg_base64: string | null }

/** 8.8 寸屏的灯环（实验性，协议尚未在硬件上验证）。 */
export interface Ring88 {
  enabled: boolean;
  effect: RgbEffect;
}

/** 8.8 灯环的运行状态；`external_display` 表示屏幕画面由外部程序（Libre Panel）在驱动。 */
export interface Ring88Status {
  /** 0416:8050 enumerated without claiming it. */
  present: boolean;
  /** LED interface is opened for control. */
  connected: boolean;
  /** 1CBE:A088 read-only display interface; content still belongs to LP. */
  display_present: boolean;
  error: string | null;
  external_display: boolean;
}

export interface Config {
  /** 配置结构版本；后台服务按它做迁移。 */
  schema_version: number;
  cooling: Cooling;
  lighting: Lighting;
  lcd: Lcd;
  devices: {
    locked: string[];
    channel?: number | null;
    /** 设备地址（MAC）→ 用户起的名字。 */
    aliases: Record<string, string>;
  };
  ring88: Ring88;
}

export interface Api {
  getStatus(): Promise<Status>;
  getConfig(): Promise<Config>;
  setConfig(config: Config): Promise<void>;
  getLightingCaps(): Promise<LightingCaps>;
  getLcdState(): Promise<LcdState>;
  /** 后台服务记下的最近 2 分钟读数（每秒一个，旧的在前）。 */
  /** 读 GIF 原文件（base64），冷头屏幕页播放预览用。 */
  readGif(path: string): Promise<string>;
  getHistory(): Promise<{ coolant: number[]; pump: number[]; fan: number[]; cpu: number[]; gpu: number[]; cpu_temp?: number[] }>;
  /** 用真实灯效引擎渲染预览（在界面进程里算，不碰设备）。 */
  previewLighting(lighting: Lighting, fanCount: number): Promise<LightingPreview>;
  themeList(): Promise<ThemeMeta[]>;
  /** 主题缩略图（JPEG base64）；浏览器预览里没有渲染器，返回 null。 */
  themePreview(id: string, dark: boolean, accent: Rgb | null, size: number): Promise<string | null>;
  bind(address: string): Promise<void>;
  unbind(address: string): Promise<void>;
  /** 让设备闪灯 / 报位置，用来对应界面上的名字。 */
  identify(address: string): Promise<void>;
  /** 给设备起一个本机名字（写入配置，不向设备发送）。 */
  renameDevice(address: string, name: string): Promise<void>;
  /** 某个风扇组的灯效能力（效果清单按这组的系列和风扇数算）。 */
  getGroupLightingCaps(address: string): Promise<LightingCaps>;
  setMbLightSync(address: string, enabled: boolean): Promise<void>;
  /** 把本机发射器和已绑定设备切到另一个频道；有设备没跟上会自动切回并报错。 */
  setChannel(channel: number): Promise<void>;
  /** 弹出打开对话框选图片或 GIF；取消时返回 null。 */
  pickMedia(kind: "image" | "gif"): Promise<string | null>;
  getAutostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  /** 弹出保存对话框，把当前配置导出为 TOML；用户取消时返回 null。 */
  exportConfig(): Promise<string | null>;
  /** 弹出打开对话框，读 TOML 并应用；用户取消时返回 null。 */
  importConfig(): Promise<string | null>;
  /** 启动和界面放在同一目录的 lcl-daemon.exe。 */
  startDaemon(): Promise<void>;
  paths(): Promise<{ config: string; log: string }>;
  /** 在资源管理器里选中配置文件或日志。 */
  revealPath(which: "config" | "log"): Promise<void>;
}

const inTauri = "__TAURI_INTERNALS__" in window;

export const isMock = !inTauri && import.meta.env.DEV;

/** 在 Tauri 里走命名管道；开发时直接用浏览器打开则用模拟数据。 */
export const api: Api = isMock
  ? mockApi()
  : {
      getStatus: () => invoke<Status>("get_status"),
      getConfig: () => invoke<Config>("get_config"),
      setConfig: (config) => invoke<void>("set_config", { config }),
      getLightingCaps: () => invoke<LightingCaps>("get_lighting_caps"),
      getLcdState: () => invoke<LcdState>("get_lcd_state"),
      getHistory: () => invoke("get_history"),
      readGif: (path) => invoke<string>("read_gif", { path }),
      previewLighting: (lighting, fanCount) => invoke<LightingPreview>("preview_lighting", { lighting, fanCount }),
      themeList: () => invoke<ThemeMeta[]>("theme_list"),
      themePreview: (id, dark, accent, size) => {
        const now = new Date();
        return invoke<string>("theme_preview", { id, dark, accent, size, time: [now.getHours(), now.getMinutes()] });
      },
      bind: (address) => invoke<void>("bind_device", { address }),
      unbind: (address) => invoke<void>("unbind_device", { address }),
      identify: (address) => invoke<void>("identify_device", { address }),
      renameDevice: (address, name) => invoke<void>("rename_device", { address, name }),
      getGroupLightingCaps: (address) => invoke<LightingCaps>("get_group_lighting_caps", { address }),
      setMbLightSync: (address, enabled) => invoke<void>("set_mb_light_sync", { address, enabled }),
      setChannel: (channel) => invoke<void>("set_channel", { channel }),
      pickMedia: (kind) => invoke<string | null>("pick_media", { kind }),
      getAutostart: () => invoke<boolean>("get_autostart"),
      setAutostart: (enabled) => invoke<void>("set_autostart", { enabled }),
      exportConfig: () => invoke<string | null>("export_config"),
      importConfig: () => invoke<string | null>("import_config"),
      startDaemon: () => invoke<void>("start_daemon"),
      paths: () => invoke<{ config: string; log: string }>("paths"),
      revealPath: (which) => invoke("reveal_path", { which }),
    };
