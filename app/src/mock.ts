import type { Api, Config, FanGroupPolicy, Lighting, RgbEffect, RgbRegion, Status, ThemeMeta, Track, WirelessDevice } from "./api";
import { evalCurve, PRESETS } from "./curve";

/** 浏览器预览用的粗略灯效动画（真实界面由后端用灯效引擎渲染）。 */
function mockTrack(leds: number, effectOf: (led: number) => RgbEffect): Track {
  const n = 48;
  const frames: string[] = [];
  for (let f = 0; f < n; f++) {
    let s = "";
    for (let i = 0; i < leds; i++) {
      const e = effectOf(i);
      const k = (e.brightness + 1) / 5;
      const pos = ((i % 26) / 26 + f / n) % 1;
      let c: number[];
      if (e.mode === "Off" || e.disabled) c = [0, 0, 0];
      else if (e.mode === "Rainbow" || e.mode === "RainbowMorph") c = hsv(e.mode === "Rainbow" ? pos : f / n);
      else if (e.mode === "Breathing") c = (e.colors[0] ?? [255, 255, 255]).map((v) => v * (0.5 + 0.5 * Math.sin((f / n) * Math.PI * 2)));
      else if (e.mode === "Static") c = e.colors[Math.floor(i / 26) % Math.max(1, e.colors.length)] ?? e.colors[0] ?? [255, 255, 255];
      else c = (e.colors[Math.floor(pos * e.colors.length)] ?? [255, 255, 255]).map((v) => v * Math.max(0, 1 - Math.abs(pos - 0.5) * 2.4));
      s += c.map((v) => Math.round(v * k).toString(16).padStart(2, "0")).join("");
    }
    frames.push(s);
  }
  return { ms: 60, frames };
}

function hsv(h: number) {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

function fanZone(fans: RgbRegion[], led: number): RgbEffect {
  const bottom = led % 26 >= 13;
  const r = fans.find((x) => x.effect.scope === (bottom ? "Bottom" : "Top")) ?? fans[0];
  return r.effect;
}

function policy(address: string, over: Partial<FanGroupPolicy> = {}): FanGroupPolicy {
  return {
    address,
    mode: "curve",
    fixed_percent: 50,
    source: "cpu",
    curve: { points: [[35, 30], [50, 45], [70, 75], [85, 100]] },
    sample_interval_ms: 1000,
    smoothing_ms: 0,
    hysteresis_c: 1,
    fall_delay_s: 3,
    slew_up_percent_per_s: 10,
    slew_down_percent_per_s: 5,
    fallback_percent: 80,
    ...over,
  };
}

const TL120 = "ce:44:ef:e5:66:e1";
const TL140 = "6c:ca:75:aa:12:07";
/** 只在配置里出现过、现在离线的组：用来演示“组不在线也能编辑”。 */
const OFFLINE = "aa:bb:cc:dd:ee:01";

const rainbow: RgbEffect = { mode: "RainbowMorph", colors: [], speed: 2, brightness: 4, direction: "Clockwise", scope: "All", disabled: false };
const meteor: RgbEffect = { mode: "Meteor", colors: [[242, 163, 58], [74, 164, 255]], speed: 2, brightness: 4, direction: "Clockwise", scope: "All", disabled: false };
const breathing: RgbEffect = { mode: "Breathing", colors: [[74, 164, 255]], speed: 2, brightness: 4, direction: "Clockwise", scope: "All", disabled: false };

/** 浏览器里开发界面用的假后台：两组 TL 风扇（1 只 120、3 只 140）+ 一个离线组 + 一个别人的设备。 */
export function mockApi(): Api {
  let channel = 8;
  const balanced = PRESETS[1];
  let config: Config = {
    schema_version: 2,
    cooling: {
      mode: "curve",
      fixed_fan_percent: 50,
      fixed_pump_rpm: 2400,
      fan_curve: { points: structuredClone(balanced.fan) },
      fan_source: "coolant",
      pump_curve: { points: structuredClone(balanced.pump) },
      fan_slew_percent_per_s: 5,
      cpu_boost_percent: 0,
      gpu_boost_percent: 0,
      pump_power_boost_rpm: 600,
      cpu_temp_limit_c: 90,
      fan_overrides: [],
      groups: [policy(TL120, { mode: "fixed", fixed_percent: 42 }), policy(TL140), policy(OFFLINE, { source: "gpu", curve: { points: [[40, 35], [60, 55], [80, 90]] } })],
    },
    lighting: {
      enabled: true,
      fans: [{ effect: structuredClone(rainbow), flip: false }],
      pump: structuredClone(breathing),
      scenes: [],
      groups: [{ address: TL120, enabled: true, regions: [{ effect: structuredClone(meteor), flip: false }] }],
    },
    lcd: { mode: "dashboard", brightness: 80, rotation: 0, media_path: "", max_fps: 20, offline_clock: false, theme: "ring", theme_mode: "dark", accent: null },
    devices: {
      locked: [],
      channel: 8,
      aliases: { [TL140]: "顶部三只" },
    },
    ring88: { enabled: false, effect: { mode: "Rainbow", colors: [], speed: 2, brightness: 4, direction: "Clockwise", scope: "All", disabled: false } },
  };

  const wireless: WirelessDevice[] = [
    { address: TL120, kind: "TL 无线", owner: "ours", master: "6c:ca:75:e5:66:e4", fan_count: 1, rx: 2, channel: 8, mb_light_sync: false, excluded: false },
    { address: TL140, kind: "TL 无线", owner: "ours", master: "6c:ca:75:e5:66:e4", fan_count: 3, rx: 3, channel: 8, mb_light_sync: false, excluded: false },
    { address: "60:99:d8:e5:66:e1", kind: "隐流二代 方屏", owner: "unbound", master: "00:00:00:00:00:00", fan_count: 0, rx: 254, channel: 8, mb_light_sync: false, excluded: false },
    { address: "0a:11:22:33:44:55", kind: "TL 无线", owner: "other", master: "0a:aa:bb:cc:dd:ee", fan_count: 3, rx: 4, channel: 8, mb_light_sync: false, excluded: false },
  ];

  // 与 lcl-effects tl::parameters / h2::parameters 的规则一致（只用于浏览器预览）。
  const tlModes = ["Off", "Rainbow", "RainbowMorph", "Static", "Breathing", "Runway", "Meteor", "ColorCycle", "Staggered", "Tide", "Mixing", "Voice", "Door", "Render", "Ripple", "Reflect", "TailChasing", "Paint", "PingPong", "Stack", "CoverCycle", "Wave", "Racing", "Lottery", "Intertwine", "MeteorShower", "Collide", "ElectricCurrent", "Kaleidoscope", "Twinkle"];
  const dirModes = ["Rainbow", "Meteor", "ColorCycle", "Render", "TailChasing", "Stack", "CoverCycle", "Lottery", "MeteorShower", "Wave", "Paint", "Racing"];
  const tlColors = (m: string, fans: number) =>
    ["Off", "Rainbow", "RainbowMorph", "Voice", "Kaleidoscope", "Twinkle"].includes(m) ? 0
    : ["Static", "Breathing"].includes(m) ? fans
    : ["Runway", "Staggered", "Tide", "Mixing", "TailChasing", "Racing", "Lottery", "Intertwine"].includes(m) ? 2
    : ["ColorCycle", "CoverCycle"].includes(m) ? 3 : 4;
  const fanCaps = (fans: number) =>
    tlModes.map((mode) => {
      const colors = tlColors(mode, fans);
      return {
        mode,
        min_colors: ["Static", "Breathing"].includes(mode) ? fans : colors === 0 ? 0 : 1,
        max_colors: colors,
        per_fan_colors: ["Static", "Breathing"].includes(mode),
        directions: dirModes.includes(mode) ? (["Clockwise", "CounterClockwise"] as const).slice() : [],
        supports_speed: !["Off", "Static"].includes(mode),
      };
    });
  const pumpCaps = ["Off", "Rainbow", "RainbowMorph", "Static", "Breathing", "Runway", "Meteor", "TaiChi", "Twinkle", "Voice", "Pump", "Bounce"].map((mode) => {
    const max = ["Static", "Breathing", "Voice", "Pump"].includes(mode) ? 1 : ["Runway", "Meteor", "TaiChi", "Bounce"].includes(mode) ? 4 : 0;
    return {
      mode,
      min_colors: Math.min(max, 1),
      max_colors: max,
      per_fan_colors: false,
      directions: ["Rainbow", "Meteor", "TaiChi", "Voice", "Pump"].includes(mode) ? (["Clockwise", "CounterClockwise"] as const).slice() : [],
      supports_speed: !["Off", "Static"].includes(mode),
    };
  });

  let autostart = false;
  const started = Date.now();
  let pump = 2070;
  const boost = (usage: number, k: number) => Math.min(Math.max((usage - 10) / 90, 0), 1) * k;
  const clamp = (v: number) => Math.min(100, Math.max(20, v));

  /** 一组的瞬时目标：定速用固定值，曲线按自己的采样源查表，读不到用兜底。 */
  function groupTarget(p: FanGroupPolicy, temps: { coolant: number; cpu: number; gpu: number }): { target: number; error: string | null } {
    if (p.mode === "fixed") return { target: clamp(p.fixed_percent), error: null };
    if (p.mode === "motherboard") return { target: clamp(55), error: "没有采样到主板 PWM（RX 没接信号线？），按兜底转速运行" };
    const t = p.source === "cpu" ? temps.cpu : p.source === "gpu" ? temps.gpu : temps.coolant;
    if (t == null || Number.isNaN(t)) return { target: clamp(p.fallback_percent), error: "没有读数，按兜底转速运行" };
    return { target: clamp(evalCurve(p.curve.points, t) ?? p.fallback_percent), error: null };
  }

  return {
    async getStatus(): Promise<Status> {
      const t = (Date.now() - started) / 1000;
      const coolant = 29 + 3 * Math.sin(t / 30);
      const cpu = 18 + 14 * Math.max(0, Math.sin(t / 7)) + 4 * Math.random();
      const gpuUsage = 30 + 25 * Math.max(0, Math.sin(t / 11));
      const gpuTemp = 38 + gpuUsage * 0.3;
      const cpuTemp = 38 + cpu * 0.9;
      const temps = { coolant, cpu: cpuTemp, gpu: gpuTemp };
      const c = config.cooling;
      const add = c.mode === "curve" ? boost(cpu, c.cpu_boost_percent) + boost(gpuUsage, c.gpu_boost_percent) : 0;
      const pumpTarget = Math.round(c.mode === "curve" ? evalCurve(c.pump_curve.points, coolant) ?? c.fixed_pump_rpm : c.fixed_pump_rpm);
      pump += (pumpTarget + 80 - pump) * 0.15;

      const groups = [TL120, TL140].map((address) => {
        const p = config.cooling.groups.find((g) => g.address === address) ?? policy(address);
        const { target, error } = groupTarget(p, temps);
        const n = address === TL120 ? 1 : 3;
        const pct = clamp(target + add);
        return {
          address,
          kind: "TL 无线",
          rpm: Array.from({ length: n }, (_, i) => Math.round(pct * 21 + i * 2 + 6)),
          pwm: Array.from({ length: n }, () => Math.round((pct * 255) / 100)),
          target_percent: pct,
          source_error: error,
          supports_control: true,
        };
      });
      const fanPercent = groups[1].target_percent ?? 50;

      return {
        uptime_s: Math.round(t),
        mode: c.mode,
        coolant_c: coolant,
        coolant_raw_c: Math.round(coolant),
        cpu_usage: cpu,
        cpu_temp_c: cpuTemp,
        cpu_power_w: 30 + cpu * 4,
        cpu_guard: false,
        pump_boost_rpm: Math.max(0, Math.min(1, (cpu * 4 - 20) / 150)) * 600,
        gpu_temp_c: gpuTemp,
        gpu_usage: gpuUsage,
        gpu_power_w: 80 + gpuUsage * 4,
        mb_pwm_percent: null,
        boost_percent: add,
        pump_rpm: Math.round(pump),
        pump_target_rpm: pumpTarget,
        fan_percent: fanPercent,
        fan_groups: groups,
        ring88: { present: true, connected: true, display_present: true, error: null, external_display: true },
        devices: [
          { name: "隐流二代 LCD-S", connection: "USB", address: "60:99:d8:e5:66:e1" },
          { name: "L-Wireless 收发器", connection: "USB · 频道 8", address: "6c:ca:75:e5:66:e4" },
          { name: "TL 无线 × 1", connection: "无线 · 本机绑定", address: TL120 },
          { name: "TL 无线 × 3", connection: "无线 · 本机绑定", address: TL140 },
        ],
        wireless: wireless.map((w) => ({ ...w, excluded: w.owner === "ours" && config.devices.locked.length > 0 && !config.devices.locked.includes(w.address) })),
        transmitter: ["6c:ca:75:e5:66:e4", channel],
        last_error: null,
        memory_mb: 3.4,
      };
    },
    async getConfig() {
      return structuredClone(config);
    },
    async setConfig(next) {
      config = structuredClone(next);
    },
    async getLightingCaps() {
      return { fan_count: 3, fans: fanCaps(3), pump: pumpCaps };
    },
    async getGroupLightingCaps(address: string) {
      if (address === OFFLINE) throw new Error("这台组不在扫描列表里，读不到灯效能力");
      const fans = address === TL120 ? 1 : address === TL140 ? 3 : 3;
      return { fan_count: fans, fans: fanCaps(fans), pump: pumpCaps };
    },
    async identify(address: string) {
      const w = wireless.find((x) => x.address === address);
      if (!w) throw new Error("设备不在扫描列表里");
      if (w.owner !== "ours") throw new Error("这台设备属于其它发射器，不能让它闪灯");
      await new Promise((r) => setTimeout(r, 700));
    },
    async renameDevice(address: string, name: string) {
      const trimmed = name.trim();
      if (!trimmed) delete config.devices.aliases[address];
      else config.devices.aliases[address] = trimmed;
    },
    async readGif() {
      throw new Error("浏览器预览里读不了本地文件");
    },
    async getHistory() {
      return { coolant: [], pump: [], fan: [], cpu: [], gpu: [], cpu_temp: [] };
    },
    async getLcdState() {
      const descs = { unmanaged: "未控制（保持设备现有画面）", dashboard: "主题：光环表盘", image: "图片：示例.png", gif: "GIF：示例.gif（24 帧）" };
      return { description: descs[config.lcd.mode], error: null, preview_jpeg_base64: null };
    },
    async previewLighting(lighting: Lighting, fanCount: number) {
      return { fan: fanCount ? mockTrack(fanCount * 26, (i) => fanZone(lighting.fans, i)) : null, pump: mockTrack(24, () => lighting.pump) };
    },
    async themeList() {
      const t = (id: string, name: string, tier: ThemeMeta["tier"], light: boolean, hex: number): ThemeMeta => ({ id, name, tier, light, accent: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] });
      return [
        t("swiss", "瑞士网格", "flat", true, 0xe8402c), t("line", "单线", "flat", true, 0xf2a33a), t("block", "色块海报", "flat", true, 0xf2a33a),
        t("tiles", "数据卡片", "flat", true, 0xf2a33a), t("minimal", "极简大字", "flat", true, 0xf2a33a), t("gauges", "仪表组", "medium", true, 0xf2a33a),
        t("clock", "时钟", "medium", true, 0xf2a33a), t("retro", "复古液晶", "medium", false, 0x7dff9a), t("bars", "柱状条", "medium", true, 0xf2a33a),
        t("ring", "光环表盘", "fancy", true, 0xf2a33a), t("glass", "极光玻璃", "fancy", true, 0xff8a3d), t("infinity", "无限镜", "fancy", false, 0xff7a2f),
        t("neon", "霓虹", "fancy", false, 0xc03cff), t("liquid", "液面", "fancy", true, 0x3fd0ff), t("radar", "雷达", "fancy", false, 0x3cffb4),
      ];
    },
    async themePreview() {
      return null;
    },
    async bind(address) {
      const w = wireless.find((x) => x.address === address)!;
      await new Promise((r) => setTimeout(r, 1200));
      Object.assign(w, { owner: "ours", master: "6c:ca:75:e5:66:e4", rx: 1, channel: 8 });
    },
    async unbind(address) {
      const w = wireless.find((x) => x.address === address)!;
      await new Promise((r) => setTimeout(r, 1200));
      Object.assign(w, { owner: "unbound", master: "00:00:00:00:00:00", rx: 0 });
    },
    async setChannel(next) {
      await new Promise((r) => setTimeout(r, 1500));
      channel = next;
      for (const w of wireless) if (w.owner === "ours") w.channel = next;
    },
    async setMbLightSync(address, enabled) {
      wireless.find((x) => x.address === address)!.mb_light_sync = enabled;
    },
    async pickMedia(kind) {
      return kind === "gif" ? "C:\\模拟\\示例.gif" : "C:\\模拟\\示例.png";
    },
    async getAutostart() {
      return autostart;
    },
    async setAutostart(enabled) {
      autostart = enabled;
    },
    async exportConfig() {
      return "C:\\模拟\\lconnect-lite.toml";
    },
    async importConfig() {
      return null;
    },
    async startDaemon() {},
    async revealPath() {},
    async paths() {
      return { config: "%APPDATA%\\LConnect Lite\\config.toml", log: "%LOCALAPPDATA%\\LConnect Lite\\daemon.log" };
    },
  };
}
