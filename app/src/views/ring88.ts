import type { Rgb, RgbEffect } from "../api";
import { h, s } from "../dom";
import { icon } from "../icons";
import { animate } from "../lighting-preview";
import { edit, store } from "../store";
import { colorPicker, segmented, toggle } from "../ui";
import type { View } from "./view";

const RING_LEDS = 60;
const PALETTE: Rgb[] = [[242, 163, 58], [255, 90, 110], [255, 214, 10], [91, 224, 122], [74, 164, 255], [168, 107, 255], [244, 241, 234]];
const SPEEDS = ["最慢", "慢", "中", "快", "最快"];
const BRIGHTS = ["20%", "40%", "60%", "80%", "100%"];
const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** 8.8 灯环目前只开放这几种效果，其余等硬件验证后再加。 */
const MODES: { mode: string; label: string; colors: number; speed: boolean; direction: boolean }[] = [
  { mode: "Off", label: "关闭", colors: 0, speed: false, direction: false },
  { mode: "Static", label: "静态", colors: 1, speed: false, direction: false },
  { mode: "Rainbow", label: "彩虹", colors: 0, speed: true, direction: false },
  { mode: "RainbowMorph", label: "彩虹渐变", colors: 0, speed: true, direction: false },
  { mode: "Breathing", label: "呼吸", colors: 1, speed: true, direction: false },
  { mode: "Wave", label: "波浪", colors: 0, speed: true, direction: true },
];

const rule = (mode: string) => MODES.find((m) => m.mode === mode) ?? MODES[0];

/** 亮度档 0–4 对应 0、25%、50%、75%、100%。 */
const brightnessOf = (b: number) => [0, 0.25, 0.5, 0.75, 1][Math.min(4, Math.max(0, Math.round(b)))];

function hsv(hh: number, k: number): Rgb {
  const f = (n: number) => {
    const kk = (n + hh * 6) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(kk, 4 - kk, 1))) * k);
  };
  return [f(5), f(3), f(1)];
}

/** 某一时刻某颗灯珠的颜色；全黑返回 null（预览里直接不画）。 */
function ringColor(e: RgbEffect, i: number, t: number): Rgb | null {
  if (!e || e.disabled || e.mode === "Off") return null;
  const k = brightnessOf(e.brightness);
  if (k <= 0) return null;
  const n = RING_LEDS;
  const idx = e.direction === "CounterClockwise" ? n - 1 - i : i;
  const pos = idx / n;
  const speed = 0.15 + e.speed * 0.15;
  if (e.mode === "Static") {
    const c = e.colors[0] ?? PALETTE[0];
    return c.map((v) => Math.round(v * k)) as Rgb;
  }
  if (e.mode === "Breathing") {
    const c = e.colors[0] ?? PALETTE[0];
    const p = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * speed * 0.5);
    return c.map((v) => Math.round(v * k * p)) as Rgb;
  }
  if (e.mode === "Rainbow") return hsv((pos + t * speed * 0.25) % 1, k);
  if (e.mode === "RainbowMorph") return hsv((t * speed * 0.12) % 1, k);
  if (e.mode === "Wave") {
    const w = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(pos * Math.PI * 4 - t * Math.PI * 2 * speed));
    return hsv((pos * 0.5 + t * 0.04) % 1, k * w);
  }
  return null;
}

/** 圆角矩形采样点（从左上角开始顺时针）。 */
function roundedRectPoints(x: number, y: number, w: number, hh: number, r: number): number[][] {
  const pts: number[][] = [];
  const arc = (cx: number, cy: number, from: number, to: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = from + ((to - from) * i) / 8;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  const HALF = Math.PI / 2;
  arc(x + w - r, y + r, -HALF, 0);
  arc(x + w - r, y + hh - r, 0, HALF);
  arc(x + r, y + hh - r, HALF, Math.PI);
  arc(x + r, y + r, Math.PI, Math.PI + HALF);
  pts.push(pts[0]);
  return pts;
}

/** 沿路径均匀取 RING_LEDS 段，每段给一段 3 点折线（端点 + 中点 + 端点）。 */
function ledSegments(pts: number[][], count: number): string[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(l);
    total += l;
  }
  const at = (d: number) => {
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) {
        const r = seg[i] ? Math.min(d / seg[i], 1) : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r];
      }
      d -= seg[i];
    }
    return pts[pts.length - 1];
  };
  return Array.from({ length: count }, (_, k) => {
    const a = (k / count) * total;
    const b = ((k + 1) / count) * total;
    return [at(a + 0.2), at((a + b) / 2), at(b - 0.2)].map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  });
}

export function ring88Panel(): View {
  let leds: { el: SVGElement; glow: SVGElement }[] = [];
  let lastKey = "";

  const banner = h(
    "div",
    { class: "banner banner-warn" },
    icon("alert"),
    h("div", { class: "banner-text" }, h("b", {}, "实验性功能"), h("span", {}, "灯环协议还没有在真机上验证过：效果、速度档和帧间隔可能和实物不一致。先用静态色确认能点亮，再试其他效果。")),
  );

  const statusDot = h("span", { class: "dot" });
  const statusText = h("span", {});
  const connectionLine = h("div", { class: "sync-line ring-connection", role: "status" }, statusDot, statusText);

  // ---------- 控件 ----------
  const enabledSwitch = toggle("由 LConnect Lite 控制灯环", (on) => {
    commit(on ? "开始控制灯环" : "停止控制灯环（保持现有灯光）", (r) => (r.enabled = on));
    draw();
  });

  const modeRow = h("div", { class: "ring-modes", role: "radiogroup", "aria-label": "效果" });
  const modeButtons = MODES.map((m) => {
    const b = h("button", { type: "button", class: "mode-card ring-mode", role: "radio", "aria-checked": "false" }, h("span", { class: "t" }, m.label));
    b.addEventListener("click", () => {
      commit(`灯环效果：${m.label}`, (r) => {
        r.effect.mode = m.mode;
        r.effect.disabled = false;
        const need = rule(m.mode).colors;
        if (need > 0 && r.effect.colors.length === 0) r.effect.colors = [PALETTE[0]];
        if (need === 0) r.effect.colors = [];
      });
      draw();
    });
    modeRow.append(b);
    return { b, m };
  });

  const brightSeg = segmented(BRIGHTS.map((n, i) => ({ value: i, label: n })), (v) => {
    commit("灯环亮度", (r) => (r.effect.brightness = v));
    draw();
  }, { label: "亮度", small: true });
  const speedSeg = segmented(SPEEDS.map((n, i) => ({ value: i, label: n })), (v) => {
    commit("灯环速度", (r) => (r.effect.speed = v));
    draw();
  }, { label: "速度", small: true });
  const dirSeg = segmented(
    [
      { value: "Clockwise", label: "顺时针" },
      { value: "CounterClockwise", label: "逆时针" },
    ] as { value: "Clockwise" | "CounterClockwise"; label: string }[],
    (v) => {
      commit("灯环方向", (r) => (r.effect.direction = v));
      draw();
    },
    { label: "方向", small: true },
  );

  const colorsRow = h("div", { class: "ring-colors" });
  const dots = PALETTE.map((c) => {
    const b = h("button", { type: "button", class: "color-dot", style: `background: ${toHex(c)}`, "aria-label": `颜色 ${toHex(c)}` });
    b.addEventListener("click", () => {
      commit("灯环颜色", (r) => (r.effect.colors = [c]));
      draw();
    });
    return b;
  });
  const custom = colorPicker({
    label: "灯环颜色",
    size: 24,
    onInput: (hex) => commitCustomColor(hex),
    onCommit: (hex) => commitCustomColor(hex),
  });
  colorsRow.append(...dots, custom.el);

  const speedRow = h("div", { class: "irow" }, h("span", { class: "label" }, "速度"), h("div", { class: "control" }, speedSeg.el));
  const dirRow = h("div", { class: "irow" }, h("span", { class: "label" }, "方向"), h("div", { class: "control" }, dirSeg.el));
  const brightRow = h("div", { class: "irow" }, h("span", { class: "label" }, "亮度"), h("div", { class: "control" }, brightSeg.el));
  const colorRow = h("div", { class: "irow" }, h("span", { class: "label" }, "颜色"), h("div", { class: "control" }, colorsRow));

  // ---------- 预览 ----------
  const svg = s("svg", { viewBox: "0 0 320 220", role: "img", "aria-label": "8.8 灯环预览（示意）" });
  const glow = s("g", { filter: "url(#ring-glow)", opacity: 0.85 });
  const crisp = s("g", {});
  const track = s("polyline", { points: "", fill: "none", stroke: "#202327", "stroke-width": 7, "stroke-linejoin": "round" });
  const shape = roundedRectPoints(28, 34, 264, 152, 44);
  track.setAttribute("points", shape.map((p) => p.join(",")).join(" "));
  leds = ledSegments(shape, RING_LEDS).map((points) => {
    const g = s("polyline", { points, fill: "none", stroke: "transparent", "stroke-width": 12, "stroke-linecap": "round" });
    const c = s("polyline", { points, fill: "none", stroke: "transparent", "stroke-width": 5, "stroke-linecap": "round" });
    glow.append(g);
    crisp.append(c);
    return { el: c, glow: g };
  });
  svg.append(
    s("defs", {}, s("filter", { id: "ring-glow", x: "-20%", y: "-30%", width: "140%", height: "160%" }, s("feGaussianBlur", { stdDeviation: 5 }))),
    s("rect", { x: 76, y: 78, width: 168, height: 64, rx: 10, fill: "#111417", stroke: "#262a2f" }),
    s("text", { x: 160, y: 115, "text-anchor": "middle", fill: "#6f767e", "font-size": 11 }, "8.8 屏幕画面（Libre Panel）"),
    track,
    glow,
    crisp,
  );

  const stage = h("div", { class: "stage ring-stage" }, h("div", { class: "stage-inner" }, svg));

  const stop = animate((t) => {
    const effect = store.config?.ring88?.effect;
    if (!effect) return;
    for (let i = 0; i < leds.length; i++) {
      const c = ringColor(effect, i, t / 1000);
      const color = c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : "transparent";
      const l = leds[i];
      if (l.el.getAttribute("stroke") !== color) {
        l.el.setAttribute("stroke", color);
        l.glow.setAttribute("stroke", color);
      }
    }
  });

  const root = h(
    "div",
    { class: "ring88-panel" },
    banner,
    h(
      "section",
      { class: "row-grid", style: "align-items: stretch" },
      h(
        "div",
        { class: "card stage-card" },
        h("div", { class: "card-head" }, h("span", { class: "small muted" }, "预览（示意）"), h("label", { class: "inline-switch small muted" }, enabledSwitch, "控制灯环")),
        stage,
        modeRow,
      ),
      h(
        "aside",
        { class: "card inspector", "aria-label": "灯环参数" },
        h("div", { class: "inspector-head" }, h("h2", {}, "参数"), h("span", { class: "small muted" }, "改动立即写入配置")),
        brightRow,
        speedRow,
        dirRow,
        colorRow,
        h("div", { class: "sync-box" }, h("span", { class: "small muted" }, "静态色只需要一帧；别的效果由后台逐帧下发，速度档决定帧间隔。")),
      ),
    ),
    connectionLine,
  );

  function commit(label: string, mutate: (r: { enabled: boolean; effect: RgbEffect }) => void) {
    if (!store.config?.ring88) return;
    edit(label, (c) => mutate(c.ring88), "ring88");
  }

  let customTimer = 0;
  function commitCustomColor(hex: string) {
    window.clearTimeout(customTimer);
    customTimer = window.setTimeout(() => {
      commit("灯环颜色", (r) => (r.effect.colors = [fromHex(hex)]));
      draw();
    }, 300);
  }

  function draw() {
    const cfg = store.config;
    const ring = cfg?.ring88;
    const st = store.status?.ring88;
    const effect = ring?.effect;
    if (!cfg || !ring || !effect) return;
    const key = JSON.stringify([ring, st]);
    if (key === lastKey) return;
    lastKey = key;

    enabledSwitch.checked = ring.enabled;
    for (const { b, m } of modeButtons) b.setAttribute("aria-checked", String(m.mode === effect.mode));
    const r = rule(effect.mode);
    brightSeg.set(effect.brightness);
    speedSeg.set(effect.speed);
    dirSeg.set(effect.direction);
    brightRow.hidden = effect.mode === "Off";
    speedRow.hidden = !r.speed;
    dirRow.hidden = !r.direction;
    colorRow.hidden = r.colors === 0;
    if (r.colors > 0) custom.set(toHex(effect.colors[0] ?? PALETTE[0]), !PALETTE.some((c) => toHex(c) === toHex(effect.colors[0] ?? PALETTE[0])));

    const displayPresent = st?.display_present === true;
    statusDot.className = displayPresent ? "dot dot-ok" : st ? "dot dot-bad" : "dot dot-warn";
    statusText.textContent = displayPresent ? "已检测到8.8通用屏幕" : "未检测到8.8通用屏幕";
  }

  draw();
  return {
    root,
    update: draw,
    dispose: stop,
  };
}
