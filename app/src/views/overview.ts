import { api } from "../api";
import { activePreset, applyPreset, PRESETS } from "../curve";
import { fmt, h, s } from "../dom";
import { animate, ledAt, LEDS_PER_FAN, PUMP_LEDS, previewFor } from "../lighting-preview";
import { modeName } from "../modes";
import { countTo } from "../motion";
import { commit, store, type History } from "../store";
import { segmented } from "../ui";
import type { Lighting, LightingPreview } from "../api";
import type { View } from "./view";

const GAUGE_MIN = 20;
const GAUGE_MAX = 50;
type SeriesKey = keyof History;
/** step：纵轴上下界取整的步长；unit 跟在数值后面。 */
const SERIES: { key: SeriesKey; name: string; color: string; minSpan: number; step: number; digits: number; unit: string }[] = [
  { key: "coolant", name: "水温", color: "var(--c-coolant)", minSpan: 2, step: 0.5, digits: 1, unit: "°C" },
  { key: "fan", name: "风扇", color: "var(--c-fan)", minSpan: 10, step: 5, digits: 0, unit: "%" },
  { key: "pump", name: "泵", color: "var(--c-pump)", minSpan: 200, step: 100, digits: 0, unit: " rpm" },
  { key: "cpu", name: "CPU", color: "var(--c-cpu)", minSpan: 20, step: 10, digits: 0, unit: "%" },
  { key: "gpu", name: "GPU", color: "var(--c-gpu)", minSpan: 10, step: 5, digits: 0, unit: "°C" },
];
/** 走势图显示哪种数据；用户的选择记在本机。 */
const SHOWN_KEY = "overview.series";
/** 走势图 viewBox 和绘图区上下边（曲线留出上下边距）；一共 120 秒。 */
const TL_W = 640;
const TL_H = 120;
const TL_TOP = 8;
const TL_BOTTOM = 112;
const HISTORY_SPAN = 120;

/** 从左下（135°）顺时针扫过 `deg` 度的圆弧。 */
function arc(cx: number, cy: number, r: number, deg: number) {
  const a0 = (135 * Math.PI) / 180;
  const a1 = ((135 + deg) * Math.PI) / 180;
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M ${p(a0)} A ${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${p(a1)}`;
}

function stat(name: string, color: string, unit: string) {
  const value = h("span", {}, "—");
  const sub = h("span", { class: "stat-sub" });
  const el = h(
    "div",
    { class: "stat" },
    h("span", { class: "stat-label" }, h("span", { class: "stat-key", style: `background: ${color}` }), name),
    h("span", { class: "stat-value" }, value, h("span", { class: "stat-unit" }, unit)),
    sub,
  );
  return { el, value, sub, unit: el.querySelector(".stat-unit") as HTMLElement };
}

function dial(name: string, color: string) {
  // 环的长度用 style 设置，CSS 过渡让它在两次读数之间平滑变化。
  const ring = s("circle", { class: "dial-ring", cx: 26, cy: 26, r: 21, fill: "none", stroke: color, "stroke-width": 6, "stroke-linecap": "round", transform: "rotate(-90 26 26)", style: "stroke-dasharray: 0 132" });
  const value = h("span", { class: "dial-value" }, "—");
  const sub = h("span", { class: "small muted" });
  let lastDash = "";
  const el = h(
    "div",
    { class: "dial reveal" },
    s("svg", { viewBox: "0 0 52 52", "aria-hidden": "true" }, s("circle", { cx: 26, cy: 26, r: 21, fill: "none", stroke: "#24292f", "stroke-width": 6 }), ring),
    h("div", { style: "display: flex; flex-direction: column; gap: 2px" }, h("span", { class: "small muted" }, name), value, sub),
  );
  return {
    el,
    /** `rpm` 为 null 时显示“—”；数字变化时滚动过去。 */
    set(frac: number | null, rpm: number | null | undefined, subText: string) {
      const dash = `${(Math.max(0, Math.min(1, frac ?? 0)) * 132).toFixed(2)} 132`;
      if (dash !== lastDash) ring.style.strokeDasharray = lastDash = dash;
      countTo(value, rpm, (v) => `${Math.round(v)} rpm`);
      if (sub.textContent !== subText) sub.textContent = subText;
    },
  };
}

export function overview(): View {
  const subtitle = h("span", { class: "subtitle" });
  const presets = segmented(
    PRESETS.map((p) => ({ value: p.id, label: p.name })),
    (id) => {
      const p = PRESETS.find((x) => x.id === id)!;
      if (store.config) commit(applyPreset(store.config, p), `${p.name}档位`, "preset", ["cooling"]);
    },
    { label: "散热档位" },
  );
  const custom = h("a", { href: "#/cooling", class: "btn btn-ghost btn-sm" }, "自定义…");
  presets.el.append(custom);

  // 水温表盘
  // 整条 270° 弧只画一次，用 dasharray 控制亮起的长度：CSS 过渡让指针在读数之间平滑移动。
  const gaugeArc = s("path", { class: "gauge-arc", d: arc(110, 110, 90, 270), pathLength: 100, fill: "none", stroke: "var(--c-coolant)", "stroke-width": 12, "stroke-linecap": "round", style: "stroke-dasharray: 0 200; stroke-opacity: 0" });
  let gaugeDash = "";
  const gaugeValue = s("tspan", {}, "—");
  const gaugeTrend = s("text", { x: 110, y: 156, "text-anchor": "middle", "font-size": 12, fill: "var(--muted)" });
  const gauge = s(
    "svg",
    { class: "gauge", viewBox: "0 0 220 200", role: "img", "aria-label": "水温表盘" },
    s("path", { d: arc(110, 110, 90, 270), fill: "none", stroke: "#24292f", "stroke-width": 12, "stroke-linecap": "round" }),
    gaugeArc,
    s("text", { x: 110, y: 78, "text-anchor": "middle", fill: "var(--muted)", "font-size": 13 }, "水温"),
    s("text", { x: 110, y: 128, "text-anchor": "middle", fill: "var(--text)", "font-size": 48, "font-weight": 600, style: "font-family: var(--font-display)" }, gaugeValue, s("tspan", { "font-size": 16, fill: "var(--muted)", dx: 4, style: "font-family: var(--font)" }, "°C")),
    gaugeTrend,
    s("text", { x: 40, y: 194, "text-anchor": "middle", fill: "var(--faint)", "font-size": 11 }, String(GAUGE_MIN)),
    s("text", { x: 180, y: 194, "text-anchor": "middle", fill: "var(--faint)", "font-size": 11 }, String(GAUGE_MAX)),
  );

  const pump = stat("泵速", "var(--c-pump)", "rpm");
  const fan = stat("冷排风扇", "var(--c-fan)", "%");
  const cpu = stat("CPU", "var(--c-cpu)", "%");
  const gpu = stat("GPU", "var(--c-gpu)", "°C");

  // 走势图：一次只看一种数据，纵轴就是它自己的刻度；选择记在本机。
  let current: SeriesKey = "coolant";
  try {
    const saved = localStorage.getItem(SHOWN_KEY);
    if (saved && SERIES.some((sr) => sr.key === saved)) current = saved as SeriesKey;
  } catch {
    /* 本机存储不可用时用默认值 */
  }
  const seriesButtons = SERIES.map((sr) => {
    const b = h("button", { type: "button", role: "radio", "aria-checked": "false" }, sr.name);
    b.addEventListener("click", () => {
      current = sr.key;
      try {
        localStorage.setItem(SHOWN_KEY, sr.key);
      } catch {
        /* 忽略 */
      }
      drawTimeline();
    });
    return b;
  });
  // 左边纵轴三格刻度，下面时间轴；指针悬停显示那一秒的读数。
  const timeline = s("svg", { viewBox: `0 0 ${TL_W} ${TL_H}`, preserveAspectRatio: "none", role: "img", "aria-label": "最近 2 分钟走势" });
  const tlY = h("div", { class: "tl-y" });
  const tlCursor = h("div", { class: "tl-cursor", hidden: true });
  const tlTip = h("div", { class: "tl-tip", hidden: true });
  const tlPlot = h("div", { class: "tl-plot" }, timeline, tlCursor, tlTip);
  let tlHover: number | null = null;
  tlPlot.addEventListener("pointermove", (e) => {
    const r = tlPlot.getBoundingClientRect();
    tlHover = Math.round(((r.right - e.clientX) / r.width) * (HISTORY_SPAN - 1));
    drawTimeline();
  });
  tlPlot.addEventListener("pointerleave", () => {
    tlHover = null;
    drawTimeline();
  });

  // 灯效卡片：三只风扇的上灯带连成一条，加冷头灯框一圈，播放真实的预览帧。
  const fanStrip = h("div", { class: "strip", style: "flex: 1; width: auto; height: 10px" });
  const pumpStrip = h("div", { class: "strip", style: "width: 72px; height: 10px" });
  const lightText = h("span", { class: "small muted" });
  let preview: LightingPreview | null = null;
  let previewKey = "";
  const stop = animate((t) => {
    if (!preview) return;
    paintStrip(fanStrip, (i) => ledAt(preview!.fan, Math.floor(i / 13) * LEDS_PER_FAN + (i % 13), t), fanStrip.childElementCount);
    paintStrip(pumpStrip, (i) => ledAt(preview!.pump, i, t), PUMP_LEDS);
  });

  // reveal：从隐藏变为显示时淡入一次（比如第一次拿到屏幕画面）。
  const lcdImg = h("img", { class: "mini-lcd reveal", alt: "冷头屏幕当前画面" });
  const lcdEmpty = h("div", { class: "mini-lcd reveal",style: "display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--faint)" }, "无画面");
  const lcdText = h("span", { class: "small muted" });
  const lcdBright = h("span", { class: "small muted" });
  let lastLcd = 0;

  const groupDials = new Map<string, ReturnType<typeof dial>>();
  const dialList = h("div", { class: "dials" });
  let dialLayoutKey = "";
  const pumpDial = dial("泵", "var(--c-pump)");

  const root = h(
    "div",
    { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "page-title" }, h("h1", {}, "概览"), subtitle), presets.el),
    h(
      "section",
      { class: "row-grid" },
      h(
        "div",
        { class: "card hero" },
        h("div", { class: "hero-top" }, gauge, h("div", { class: "stats" }, pump.el, fan.el, cpu.el, gpu.el)),
        h(
          "div",
          { class: "timeline" },
          h("div", { class: "card-head" }, h("span", { class: "small", style: "color: var(--text-2)" }, "最近 2 分钟"), h("div", { class: "series", role: "radiogroup", "aria-label": "走势图显示的数据" }, ...seriesButtons)),
          h(
            "div",
            { class: "tl-body" },
            tlY,
            tlPlot,
            h("div", { class: "tl-x" }, h("span", {}, "2 分钟前"), h("span", {}, "1 分钟前"), h("span", {}, "现在")),
          ),
        ),
      ),
      h(
        "div",
        { class: "side" },
        h(
          "a",
          { href: "#/lighting", class: "card card-link" },
          h("div", { class: "card-head" }, h("h2", {}, "灯效"), h("span", { class: "small", style: "color: var(--accent)" }, "调整")),
          h("div", { style: "display: flex; align-items: center; gap: 12px" }, fanStrip, pumpStrip),
          lightText,
        ),
        h(
          "a",
          { href: "#/screen", class: "card card-link", style: "flex-direction: row; align-items: center" },
          lcdImg,
          lcdEmpty,
          h("div", { style: "display: flex; flex-direction: column; gap: 6px; min-width: 0" }, h("h2", {}, "冷头屏幕"), lcdText, lcdBright),
        ),
      ),
    ),
    h(
      "section",
      { class: "card", "aria-label": "风扇和泵" },
      h("div", { class: "card-head" }, h("h2", {}, "风扇和泵"), h("span", { class: "small muted", id: "dial-sub" })),
      dialList,
    ),
  );
  lcdImg.hidden = true;
  for (let i = 0; i < 39; i++) fanStrip.append(h("span"));
  for (let i = 0; i < PUMP_LEDS; i++) pumpStrip.append(h("span"));

  function drawTimeline() {
    const base = SERIES.find((x) => x.key === current) ?? SERIES[0];
    // CPU 有温度历史时画温度，没有时画占用。
    const cpuTemp = base.key === "cpu" && store.history.cpu_temp.length >= 2;
    const sr = cpuTemp ? { ...base, minSpan: 10, step: 5, unit: "°C" } : base;
    seriesButtons.forEach((b, i) => {
      const on = SERIES[i].key === sr.key;
      b.setAttribute("aria-checked", String(on));
      b.style.color = on ? SERIES[i].color : "";
      b.style.borderColor = on ? SERIES[i].color : "";
    });
    const mid = (TL_TOP + TL_BOTTOM) / 2;
    const children: SVGElement[] = [TL_TOP, mid, TL_BOTTOM].map((y) => s("line", { x1: 0, x2: TL_W, y1: y, y2: y, stroke: "#1f2328", "vector-effect": "non-scaling-stroke" }));
    const v = cpuTemp ? store.history.cpu_temp : store.history[sr.key];
    // 上下界按步长取整，刻度是整齐的数；中间一格取两者中点。
    let lo = v.length ? Math.min(...v) : 0;
    let hi = v.length ? Math.max(...v) : sr.minSpan;
    if (hi - lo < sr.minSpan) {
      const m = (hi + lo) / 2;
      lo = m - sr.minSpan / 2;
      hi = m + sr.minSpan / 2;
    }
    lo = Math.floor(lo / sr.step) * sr.step;
    hi = Math.ceil(hi / sr.step) * sr.step;
    if ((hi - lo) / sr.step % 2 === 1) hi += sr.step;
    const y = (val: number) => TL_BOTTOM - ((val - lo) / (hi - lo)) * (TL_BOTTOM - TL_TOP);
    const label = (val: number) => `${val.toFixed(sr.step < 1 ? 1 : 0)}${sr.unit}`;
    tlY.replaceChildren(
      ...([[hi, TL_TOP], [(hi + lo) / 2, mid], [lo, TL_BOTTOM]] as const).map(([val, gy]) => h("span", { style: `top: ${(gy / TL_H) * 100}%` }, label(val))),
    );
    if (v.length >= 2) {
      // 不满 2 分钟时从右边开始画，最新的值总在最右。
      const step = TL_W / (HISTORY_SPAN - 1);
      const x = (i: number) => TL_W - (v.length - 1 - i) * step;
      const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(" ");
      children.push(
        s("polygon", { points: `${x(0).toFixed(1)},${TL_BOTTOM} ${pts} ${TL_W},${TL_BOTTOM}`, fill: sr.color, "fill-opacity": 0.1, stroke: "none" }),
        s("polyline", { points: pts, fill: "none", stroke: sr.color, "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }),
      );
    }
    timeline.replaceChildren(...children);
    if (tlHover != null && tlHover < v.length) {
      const val = v[v.length - 1 - tlHover];
      const left = 100 - (tlHover / (HISTORY_SPAN - 1)) * 100;
      tlCursor.hidden = false;
      tlCursor.style.left = `${left}%`;
      tlCursor.replaceChildren(h("span", { class: "tl-dot", style: `top: ${(y(val) / TL_H) * 100}%; background: ${sr.color}` }));
      tlTip.hidden = false;
      tlTip.replaceChildren(h("span", { class: "muted" }, tlHover === 0 ? "现在" : `${tlHover} 秒前`), h("b", {}, `${val.toFixed(sr.digits)}${sr.unit}`));
      // 提示框放在光标的另一侧，避免出界。
      tlTip.style.left = left > 55 ? "" : `calc(${left}% + 12px)`;
      tlTip.style.right = left > 55 ? `calc(${100 - left}% + 12px)` : "";
    } else {
      tlCursor.hidden = true;
      tlTip.hidden = true;
    }
  }

  async function refreshLighting() {
    const cfg = store.config;
    if (!cfg) return;
    const firstGroup = store.status?.fan_groups[0];
    const fanCount = firstGroup?.rpm.length ?? 3;
    // 概览只展示第一组：有按组覆盖就展示那组，否则展示全局。
    const override = firstGroup ? cfg.lighting.groups?.find((g) => g.address === firstGroup.address) : undefined;
    const regions = override?.regions ?? cfg.lighting.fans;
    const enabled = override?.enabled ?? cfg.lighting.enabled;
    const key = JSON.stringify([regions, enabled, cfg.lighting.pump, fanCount]);
    if (key === previewKey) return;
    previewKey = key;
    const l: Lighting = { enabled, fans: regions, pump: cfg.lighting.pump, scenes: [], groups: [] };
    const fx = (scope: string) => regions.find((r) => r.effect.scope === scope) ?? regions[0];
    const top = fx("Top"), bottom = fx("Bottom");
    const fanText = top && bottom && top !== bottom && top.effect.mode !== bottom.effect.mode ? `上 ${modeName(top.effect.mode)} · 下 ${modeName(bottom.effect.mode)}` : modeName(regions[0]?.effect.mode ?? "Off");
    lightText.textContent = enabled ? `风扇：${fanText} · 冷头：${modeName(l.pump.mode)}` : "未启用：设备保持现有灯光";
    try {
      preview = enabled ? await previewFor(l, fanCount) : null;
    } catch {
      preview = null;
    }
    if (!preview) {
      paintStrip(fanStrip, () => null, 39);
      paintStrip(pumpStrip, () => null, PUMP_LEDS);
    }
  }

  async function refreshLcd() {
    if (Date.now() - lastLcd < 3000 || store.offline) return;
    lastLcd = Date.now();
    try {
      const st = await api.getLcdState();
      lcdText.textContent = st.description || "—";
      if (st.preview_jpeg_base64 && store.config?.lcd.mode !== "unmanaged") {
        lcdImg.src = `data:image/jpeg;base64,${st.preview_jpeg_base64}`;
        lcdImg.hidden = false;
        lcdEmpty.hidden = true;
      } else {
        lcdImg.hidden = true;
        lcdEmpty.hidden = false;
      }
    } catch {
      /* 下次再试 */
    }
  }

  function update() {
    const st = store.status;
    const cfg = store.config;
    const hist = store.history;

    const preset = cfg ? activePreset(cfg) : null;
    presets.set(preset?.id ?? null);
    custom.style.color = cfg && !preset ? "var(--accent)" : "";
    const modeText = !cfg
      ? ""
      : cfg.cooling.mode === "fixed"
        ? "固定转速"
        : cfg.cooling.mode === "motherboard"
          ? "跟随主板"
          : preset
            ? `${preset.name}曲线`
            : cfg.cooling.fan_source === "gpu"
              ? "按 GPU 温度的自定义曲线"
              : "自定义曲线";
    const ownGroups = cfg?.cooling.groups?.length ?? 0;
    subtitle.textContent = store.offline
      ? "后台服务未连接"
      : [st?.last_error ? "有设备报错" : "所有设备在线", modeText && `按${modeText}控制`, ownGroups ? `${ownGroups} 组单独设置` : ""].filter(Boolean).join(" · ");

    const t = st?.coolant_c;
    countTo(gaugeValue, t, (v) => v.toFixed(1));
    const frac = t == null ? 0 : Math.min(Math.max((t - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN), 0), 1);
    const dash = `${(frac * 100).toFixed(2)} 200`;
    if (dash !== gaugeDash) {
      // 第一次有读数时直接落位，不从 0 扫上来。
      if (!gaugeDash || gaugeDash.startsWith("0.00 ")) gaugeArc.style.transition = "none";
      gaugeArc.style.strokeDasharray = dash;
      // 太短时圆头会画成一个点：和原来一样不显示。
      gaugeArc.style.strokeOpacity = frac > 0.005 ? "1" : "0";
      if (gaugeArc.style.transition) {
        void gaugeArc.getBoundingClientRect();
        gaugeArc.style.transition = "";
      }
      gaugeDash = dash;
    }
    const c = hist.coolant;
    if (c.length >= 10) {
      const d = c[c.length - 1] - c[0];
      const mins = Math.max(1, Math.round(c.length / 60));
      gaugeTrend.textContent = Math.abs(d) < 0.3 ? `稳定 · ${mins} 分钟 ${d >= 0 ? "+" : ""}${d.toFixed(1)}` : `${d > 0 ? "上升" : "下降"} · ${mins} 分钟 ${d > 0 ? "+" : ""}${d.toFixed(1)}`;
      gaugeTrend.setAttribute("fill", Math.abs(d) < 0.3 ? "var(--ok)" : d > 0 ? "var(--warm)" : "var(--c-pump)");
    } else {
      gaugeTrend.textContent = "";
    }

    const int = (v: number) => v.toFixed(0);
    countTo(pump.value, st?.pump_rpm, int);
    pump.sub.textContent = [st?.pump_target_rpm != null ? `目标 ${st.pump_target_rpm}` : "", st?.pump_boost_rpm ? `功耗前馈 +${Math.round(st.pump_boost_rpm)}` : ""].filter(Boolean).join(" · ");
    countTo(fan.value, st?.fan_percent, int);
    const rpms = st?.fan_groups.flatMap((g) => g.rpm) ?? [];
    fan.sub.textContent = [rpms.length ? `平均 ${Math.round(rpms.reduce((a, b) => a + b, 0) / rpms.length)} rpm` : "", st?.boost_percent ? `前馈 +${fmt(st.boost_percent, 1)}` : ""].filter(Boolean).join(" · ");
    // 有温度（传感器服务在运行）时主数字显示温度，占用和功耗放下面；没有时退回显示占用。
    if (st?.cpu_temp_c != null) {
      countTo(cpu.value, st.cpu_temp_c, int);
      cpu.unit.textContent = "°C";
      cpu.sub.textContent = st.cpu_guard ? "温度保护中：泵已拉满" : [`占用 ${fmt(st.cpu_usage)}%`, st.cpu_power_w != null ? `${fmt(st.cpu_power_w)} W` : ""].filter(Boolean).join(" · ");
    } else {
      countTo(cpu.value, st?.cpu_usage, int);
      cpu.unit.textContent = "%";
      cpu.sub.textContent = st?.cpu_sensor_error ? "占用 · 没有温度读数" : "占用";
    }
    cpu.sub.title = st?.cpu_temp_c == null ? st?.cpu_sensor_error ?? "" : "";
    cpu.sub.style.color = st?.cpu_guard ? "var(--warm)" : "";
    countTo(gpu.value, st?.gpu_temp_c, int);
    gpu.sub.textContent = st?.gpu_usage != null ? `占用 ${fmt(st.gpu_usage)}% · ${fmt(st.gpu_power_w)} W` : "没有读数";

    drawTimeline();

    const groups = st?.fan_groups ?? [];
    // 保留已配置但暂时离线的组，不能让一组掉线后另一组变成“风扇1”。
    const addresses = [...new Set([...(cfg?.cooling.groups ?? []).map((g) => g.address), ...groups.map((g) => g.address)])];
    const labels = addresses.map((address) => cfg?.devices.aliases[address] || groups.find((g) => g.address === address)?.kind || address);
    const layoutKey = JSON.stringify([addresses, labels]);
    if (layoutKey !== dialLayoutKey) {
      dialLayoutKey = layoutKey;
      groupDials.clear();
      addresses.forEach((address, i) => groupDials.set(address, dial(labels[i], "var(--c-fan)")));
      dialList.replaceChildren(...[...groupDials.values()].map((d) => d.el), pumpDial.el);
    }
    for (const address of addresses) {
      const g = groups.find((g) => g.address === address);
      const d = groupDials.get(address)!;
      const rpm = g?.rpm.length ? g.rpm.reduce((a, b) => a + b, 0) / g.rpm.length : null;
      const duty = g?.pwm.length ? g.pwm.reduce((a, b) => a + b, 0) / g.pwm.length / 255 : null;
      d.set(duty, rpm, g ? `组内 ${g.rpm.length} 只 · ${g.rpm.join(" / ")} rpm · ${Math.round((duty ?? 0) * 100)}%` : "离线 · 暂无转速读数");
    }
    const maxPump = 3200;
    pumpDial.set(st?.pump_rpm != null ? st.pump_rpm / maxPump : null, st?.pump_rpm, st?.pump_target_rpm != null ? `目标 ${st.pump_target_rpm}` : "");
    const sub = root.querySelector("#dial-sub");
    if (sub) sub.textContent = `${groups.length}/${addresses.length} 组在线 · ${rpms.length} 只风扇`;

    lcdBright.textContent = cfg ? `亮度 ${cfg.lcd.brightness}%` : "";
    refreshLighting();
    refreshLcd();
  }

  return { root, update, dispose: stop };
}

function paintStrip(strip: HTMLElement, color: (i: number) => string | null, n: number) {
  const kids = strip.children;
  for (let i = 0; i < n && i < kids.length; i++) (kids[i] as HTMLElement).style.background = color(i) ?? "transparent";
}
