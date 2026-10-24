import {
  api,
  type EffectParams,
  type GroupLighting,
  type Lighting,
  type LightingCaps,
  type LightingPreview,
  type LightingScene,
  type Rgb,
  type RgbEffect,
  type RgbRegion,
} from "../api";
import { deviceAlias } from "../device-actions";
import { h, s } from "../dom";
import { icon } from "../icons";
import { animate, ledAt, LEDS_PER_FAN, PUMP_LEDS, previewFor } from "../lighting-preview";
import { modeName } from "../modes";
import { conceal, reveal } from "../motion";
import { ring88Panel } from "./ring88";
import { commit, store } from "../store";
import { colorPicker, confirmDialog, promptDialog, segmented, toast, toggle } from "../ui";
import type { View } from "./view";

type ZoneId = "top" | "bottom" | "pump";
const ZN: Record<ZoneId, string> = { top: "上灯带", bottom: "下灯带", pump: "冷头灯框" };
const PALETTE: Rgb[] = [[242, 163, 58], [255, 90, 110], [255, 214, 10], [91, 224, 122], [74, 164, 255], [168, 107, 255], [244, 241, 234]];
const SPEEDS = ["最慢", "慢", "中", "快", "最快"];
const BRIGHTS = ["20%", "40%", "60%", "80%", "100%"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

function effect(mode: string, colors: Rgb[], brightness = 4, speed = 2): RgbEffect {
  return { mode, colors, speed, brightness, direction: "Clockwise", scope: "All", disabled: false };
}
const AMBER: Rgb = [242, 163, 58];
/** 内置场景。夜间用最低一档亮度（0 档在冷头上等于关灯）。 */
const BUILTIN: (LightingScene & { dot: string })[] = [
  { name: "彩虹", dot: "conic-gradient(#ff5a5a, #ffc24a, #5be07a, #4ab8ff, #a86bff, #ff5a5a)", fans: [{ effect: effect("Rainbow", []), flip: false }], pump: effect("Rainbow", []) },
  { name: "琥珀", dot: "#f2a33a", fans: [{ effect: effect("Static", [AMBER, AMBER, AMBER], 3), flip: false }], pump: effect("Static", [AMBER], 3) },
  { name: "夜间", dot: "#7a5320", fans: [{ effect: effect("Breathing", [AMBER, AMBER, AMBER], 1, 0), flip: false }], pump: effect("Static", [AMBER], 1) },
  { name: "关灯", dot: "transparent", fans: [{ effect: effect("Off", []), flip: false }], pump: effect("Off", []) },
];

/** 风扇的上、下灯带各取一个效果（“整体”时两边是同一个）。 */
function fanZones(fans: RgbRegion[]): { top: RgbEffect; bottom: RgbEffect; flip: boolean } {
  const find = (scope: string) => fans.find((r) => r.effect.scope === scope) ?? fans.find((r) => r.effect.scope === "All") ?? fans[0];
  const first = find("Top");
  if (!first) return { top: effect("Off", []), bottom: effect("Off", []), flip: false };
  return { top: structuredClone(find("Top").effect), bottom: structuredClone(find("Bottom").effect), flip: fans.some((r) => r.flip) };
}

/** 两条灯带一样就存成一个“整体”区域，不一样就存成上、下两个。 */
function joinFans(top: RgbEffect, bottom: RgbEffect, flip: boolean): RgbRegion[] {
  const strip = (e: RgbEffect) => ({ ...e, scope: "All" as const });
  if (same(strip(top), strip(bottom))) return [{ effect: strip(top), flip }];
  return [
    { effect: { ...top, scope: "Top" }, flip },
    { effect: { ...bottom, scope: "Bottom" }, flip },
  ];
}

type Selection = { kind: "group"; address: string } | { kind: "pump" };

export function lighting(): View {
  /** 每个风扇组的灯效能力，按需拉取。 */
  const capsByGroup = new Map<string, LightingCaps>();
  let pumpParams: EffectParams[] | null = null;
  let fanFallbackCount = 3;

  let sel: Selection | null = null;
  let autoPicked = false;
  let zoneSel: ZoneId[] = ["top", "bottom"];
  let fanDraft: { address: string; enabled: boolean; regions: RgbRegion[] } | null = null;
  let pumpDraft: RgbEffect | null = null;
  let pumpTouched = false;
  let slot = 0;
  let preview: LightingPreview | null = null;
  let previewKey = "";
  let open = false;
  let active = -1;

  const cfg = () => store.config;
  const aliases = () => cfg()?.devices.aliases;
  const entryOf = (address: string): GroupLighting | undefined => (cfg()?.lighting.groups ?? []).find((g) => g.address === address);

  /** 界的组列表：本机绑定的风扇组 + 配置里已经存在但暂时离线的组。 */
  function groupList(): { address: string; label: string; count: number }[] {
    const seen = new Set<string>();
    const out: { address: string; label: string; count: number }[] = [];
    for (const g of store.status?.fan_groups ?? []) {
      seen.add(g.address);
      const alias = deviceAlias(g.address, aliases());
      out.push({ address: g.address, label: alias || `${g.kind} ×${g.rpm.length || g.pwm.length}`, count: g.rpm.length || g.pwm.length });
    }
    for (const g of cfg()?.lighting.groups ?? []) {
      if (seen.has(g.address)) continue;
      const alias = deviceAlias(g.address, aliases());
      out.push({ address: g.address, label: alias || `风扇组 ${g.address.slice(-5)}`, count: 0 });
    }
    return out;
  }

  const fanCountOf = (address: string | null): number => {
    if (!address) return 1;
    const g = store.status?.fan_groups.find((x) => x.address === address);
    const n = g?.rpm.length || capsByGroup.get(address)?.fan_count || fanFallbackCount;
    return Math.max(1, Math.min(4, n));
  };
  const currentAddress = () => (sel?.kind === "group" ? sel.address : null);
  const fanCount = () => fanCountOf(currentAddress());

  const sentRegions = (address: string): RgbRegion[] => structuredClone(entryOf(address)?.regions ?? cfg()?.lighting.fans ?? []);
  const sentEnabled = (address: string): boolean => entryOf(address)?.enabled ?? cfg()?.lighting.enabled ?? false;
  const fansDirty = () => {
    const a = currentAddress();
    if (!a || !fanDraft) return false;
    return fanDraft.enabled !== sentEnabled(a) || !same(fanDraft.regions, sentRegions(a));
  };
  const pumpDirty = () => !!pumpDraft && !!cfg() && pumpTouched && !same(pumpDraft, cfg()!.lighting.pump);

  const zoneEffect = (id: ZoneId): RgbEffect | null => {
    if (id === "pump") return pumpDraft;
    if (!fanDraft) return null;
    return fanZones(fanDraft.regions)[id];
  };
  const paramsOf = (id: ZoneId, mode: string): EffectParams | undefined => {
    const list = id === "pump" ? pumpParams : capsFor(currentAddress())?.fans;
    return list?.find((p) => p.mode === mode);
  };
  const colorCount = (id: ZoneId, e: RgbEffect) => {
    const p = paramsOf(id, e.mode);
    if (!p || p.max_colors === 0) return 0;
    return id !== "pump" && p.per_fan_colors ? fanCount() : p.max_colors;
  };
  /** 让颜色数量、方向落在效果允许的范围里。 */
  function fit(id: ZoneId, e: RgbEffect) {
    const p = paramsOf(id, e.mode);
    if (!p) return;
    const want = Math.max(colorCount(id, e), p.min_colors);
    while (e.colors.length < want) e.colors.push(e.colors.at(-1) ?? PALETTE[e.colors.length % PALETTE.length]);
    if (want > 0 && e.colors.length > want) e.colors.length = want;
    if (p.directions.length && !p.directions.includes(e.direction)) e.direction = p.directions[0];
  }

  function capsFor(address: string | null): LightingCaps | undefined {
    return address ? capsByGroup.get(address) : undefined;
  }

  /** 这台组当前能真正做到什么：只有后台明确 supports_control === true 才算可写。 */
  function groupCap(address: string | null): "control" | "readonly" | "offline" {
    if (!address) return "offline";
    const g = store.status?.fan_groups.find((x) => x.address === address);
    if (!g) return "offline";
    return g.supports_control === true ? "control" : "readonly";
  }

  // ---------- 选择 ----------
  function select(next: Selection) {
    closeList();
    sel = next;
    zoneSel = next.kind === "pump" ? ["pump"] : ["top", "bottom"];
    slot = 0;
    loadDraft();
    if (next.kind === "group" && !capsByGroup.has(next.address)) loadCaps(next.address);
    redraw();
  }

  /** 把当前选择的草稿从配置里重新读一份（切换选择、撤销、离开再回来时）。 */
  function loadDraft() {
    if (!cfg()) return;
    if (!sel) {
      const first = groupList()[0];
      sel = first ? { kind: "group", address: first.address } : { kind: "pump" };
    }
    if (sel.kind === "group") {
      fanDraft = { address: sel.address, enabled: sentEnabled(sel.address), regions: sentRegions(sel.address) };
      zoneSel = zoneSel.filter((z) => z !== "pump");
      if (!zoneSel.length) zoneSel = ["top", "bottom"];
    } else {
      fanDraft = null;
    }
    // 冷头灯框有未发送的改动时保留草稿，别因为切组就丢掉。
    if (!pumpTouched) pumpDraft = cfg() ? structuredClone(cfg()!.lighting.pump) : null;
  }

  // ---------- 修改（只改草稿，按“应用”才写配置） ----------
  function apply(label: string, mutate: (e: RgbEffect, id: ZoneId) => void, bothStrips = false) {
    if (sel?.kind === "pump") {
      if (!pumpDraft) return;
      mutate(pumpDraft, "pump");
      fit("pump", pumpDraft);
      pumpTouched = true;
      redraw();
      return;
    }
    if (!fanDraft) return;
    if (!fanDraft.enabled) return;
    if (groupCap(fanDraft.address) !== "control") return;
    const z = fanZones(fanDraft.regions);
    const zones: Record<"top" | "bottom", RgbEffect> = { top: z.top, bottom: z.bottom };
    const ids = bothStrips ? (["top", "bottom"] as ZoneId[]) : zoneSel.filter((id) => id !== "pump");
    for (const id of ids.length ? ids : (["top", "bottom"] as ZoneId[])) {
      const key = id === "top" ? "top" : "bottom";
      mutate(zones[key], key);
      fit(key, zones[key]);
    }
    fanDraft.regions = joinFans(zones.top, zones.bottom, z.flip);
    void label;
    redraw();
  }

  function commitFans() {
    if (!cfg() || !fanDraft) return Promise.resolve();
    const next = structuredClone(cfg()!);
    const entry: GroupLighting = { address: fanDraft.address, enabled: fanDraft.enabled, regions: structuredClone(fanDraft.regions) };
    const groups = next.lighting.groups ?? [];
    const i = groups.findIndex((g) => g.address === fanDraft!.address);
    if (i >= 0) groups[i] = entry;
    else groups.push(entry);
    next.lighting.groups = groups;
    return commit(next, `${groupLabel(fanDraft.address)} 的灯效`, `light-${fanDraft.address}`, ["lighting"]);
  }

  async function sendPump() {
    if (!cfg() || !pumpDraft) return;
    const next = structuredClone(cfg()!);
    next.lighting.pump = structuredClone(pumpDraft);
    pumpTouched = false;
    await commit(next, "冷头灯框（泵会短暂降速）", "light-pump", ["lighting"]);
    redraw();
  }

  function revertPump() {
    if (!cfg()) return;
    pumpDraft = structuredClone(cfg()!.lighting.pump);
    pumpTouched = false;
    redraw();
  }

  function groupLabel(address: string): string {
    const g = groupList().find((x) => x.address === address);
    return g?.label ?? (deviceAlias(address, aliases()) || `${address.slice(-5)} 风扇组`);
  }

  function applyScene(scene: LightingScene) {
    if (!fanDraft) return;
    if (groupCap(fanDraft.address) !== "control") {
      toast("后台没有确认这台组支持灯效控制，现在只读", { error: true, key: "scene" });
      return;
    }
    const flip = fanZones(fanDraft.regions).flip;
    fanDraft.regions = scene.fans.map((r) => ({ ...structuredClone(r), flip }));
    fanDraft.enabled = true;
    const z = fanZones(fanDraft.regions);
    fit("top", z.top);
    fit("bottom", z.bottom);
    fanDraft.regions = joinFans(z.top, z.bottom, z.flip);
    redraw();
    toast(`已载入场景“${scene.name}”，点“应用”后生效`, { key: "scene" });
  }

  // ---------- 顶部 ----------
  const groupChips = h("div", { class: "group-chips" });
  const sceneRow = h("div", { style: "display: flex; flex-wrap: wrap; align-items: center; gap: 8px" });
  const saveScene = h("button", { type: "button", class: "chip", style: "border-style: dashed; color: var(--muted)" }, "+ 保存为场景");
  saveScene.addEventListener("click", async () => {
    if (!cfg() || !fanDraft || !pumpDraft) return;
    const name = await promptDialog({ title: "保存当前灯效为场景", placeholder: "比如：游戏、看片", confirm: "保存" });
    if (!name) return;
    const next = structuredClone(cfg()!);
    next.lighting.scenes = [...(next.lighting.scenes ?? []).filter((x) => x.name !== name), { name, fans: structuredClone(fanDraft.regions), pump: structuredClone(pumpDraft) }];
    commit(next, `保存场景“${name}”`, "light-scene", ["lighting"]);
  });
  let scenesKey = "";
  function drawScenes() {
    const user = cfg()?.lighting.scenes ?? [];
    const key = JSON.stringify(user.map((x) => x.name));
    if (key === scenesKey) return;
    scenesKey = key;
    const chip = (sc: LightingScene, dot: string, removable: boolean) => {
      const b = h("button", { type: "button", class: "chip" }, h("span", { class: "swatch", style: `background: ${dot}; ${dot === "transparent" ? "box-shadow: inset 0 0 0 1.5px #4a5158" : ""}` }), sc.name);
      b.addEventListener("click", () => applyScene(sc));
      if (!removable) return b;
      b.title = "右键删除";
      b.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        if (!(await confirmDialog({ title: `删除场景“${sc.name}”？`, body: "只删除这个保存的场景，不影响当前灯效。", confirm: "删除", danger: true })) || !cfg()) return;
        const next = structuredClone(cfg()!);
        next.lighting.scenes = next.lighting.scenes.filter((x) => x.name !== sc.name);
        commit(next, `删除场景“${sc.name}”`, "light-scene", ["lighting"]);
      });
      return b;
    };
    const dotOf = (sc: LightingScene) => {
      const c = sc.fans[0]?.effect.colors[0];
      return c ? toHex(c) : "var(--surface-3)";
    };
    sceneRow.replaceChildren(
      h("span", { class: "subtitle", style: "margin-right: 2px" }, "场景"),
      ...BUILTIN.map((sc) => chip(sc, sc.dot, false)),
      ...user.map((sc) => chip(sc, dotOf(sc), true)),
      saveScene,
    );
  }

  // ---------- 设备图 ----------
  const stage = h("div", { class: "stage" });
  const stageInner = h("div", { class: "stage-inner" });
  stage.append(stageInner);
  let leds: { el: SVGElement; glow: SVGElement; kind: "fan" | "pump"; index: number }[] = [];
  let outlineBoxes: { top: SVGRectElement; bottom: SVGRectElement; pump: SVGRectElement } | null = null;
  let builtFans = 0;

  function buildStage() {
    const n = fanCount();
    builtFans = n;
    const W = 32 + n * 120;
    const H = 334;
    const along = (pts: number[][], count: number) => {
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
        const a = (k / count) * total, b = ((k + 1) / count) * total;
        return [at(a + 0.5), at((a + b) / 2), at(b - 0.5)].map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
      });
    };
    const line = (pts: number[][]) => pts.map((p) => p.join(",")).join(" ");
    const outline = s("g", { fill: "none", stroke: "#262a2f", "stroke-width": 1.2 });
    const tracks = s("g", { fill: "none", stroke: "#202327", "stroke-width": 5, "stroke-linejoin": "round", "stroke-linecap": "round" });
    const glow = s("g", { filter: "url(#led-glow)", opacity: 0.8 });
    const crisp = s("g", {});
    leds = [];
    const addLed = (pts: string, kind: "fan" | "pump", index: number) => {
      const g = s("polyline", { points: pts, fill: "none", stroke: "transparent", "stroke-width": 10, "stroke-linecap": "round" });
      const c = s("polyline", { points: pts, fill: "none", stroke: "transparent", "stroke-width": 3.5 });
      glow.append(g);
      crisp.append(c);
      leds.push({ el: c, glow: g, kind, index });
    };
    for (let f = 0; f < n; f++) {
      const x = 16 + f * 120;
      outline.append(s("rect", { x, y: 16, width: 120, height: 120, rx: 5 }), s("circle", { cx: x + 60, cy: 76, r: 46 }));
      const top = [[x + 3, 34], [x + 16, 21], [x + 104, 21], [x + 117, 34]];
      const bot = [[x + 3, 118], [x + 16, 131], [x + 104, 131], [x + 117, 118]];
      tracks.append(s("polyline", { points: line(top) }), s("polyline", { points: line(bot) }));
      along(top, 13).forEach((p, i) => addLed(p, "fan", f * LEDS_PER_FAN + i));
      along(bot, 13).forEach((p, i) => addLed(p, "fan", f * LEDS_PER_FAN + 13 + i));
    }
    const px = W / 2 - 60;
    outline.append(s("rect", { x: px, y: 176, width: 120, height: 120, rx: 9 }), s("rect", { x: px + 20, y: 196, width: 80, height: 80, rx: 2 }));
    // 冷头灯框 24 颗，每边 6 颗；起点和方向按左上角顺时针示意，待实机核对。
    const frame = [[px + 8, 184], [px + 112, 184], [px + 112, 288], [px + 8, 288], [px + 8, 184]];
    tracks.append(s("polyline", { points: line(frame) }));
    along(frame, PUMP_LEDS).forEach((p, i) => addLed(p, "pump", i));
    const fanW = n * 120 + 8;
    const box = (x: number, y: number, w: number, hh: number) => s("rect", { class: "stage-outline", style: "opacity: 0", x, y, width: w, height: hh, rx: 8, fill: "var(--accent)", "fill-opacity": 0.07, stroke: "var(--accent)", "stroke-opacity": 0.7, "stroke-width": 1 });
    outlineBoxes = { top: box(12, 12, fanW, 30), bottom: box(12, 110, fanW, 30), pump: box(px - 6, 170, 132, 132) };
    const svg = s(
      "svg",
      { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "灯效预览" },
      s("defs", {}, s("filter", { id: "led-glow", x: "-20%", y: "-80%", width: "140%", height: "260%" }, s("feGaussianBlur", { stdDeviation: 4 }))),
      outlineBoxes.top,
      outlineBoxes.bottom,
      outlineBoxes.pump,
      outline,
      s("text", { x: W / 2, y: 234, "text-anchor": "middle", fill: "#6f767e", "font-size": 9 }, "屏幕"),
      tracks,
      glow,
      crisp,
      s("text", { x: W / 2, y: 160, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, `UNI FAN ×${n}`),
      s("text", { x: W / 2, y: 322, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, "隐流二代 LCD-S"),
    );
    const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`;
    const hit = (id: ZoneId, x: number, y: number, w: number, hh: number) => {
      const b = h("button", { type: "button", class: "stage-hit", "aria-label": ZN[id], style: `left: ${pct(x, W)}; top: ${pct(y, H)}; width: ${pct(w, W)}; height: ${pct(hh, H)}` });
      b.addEventListener("click", (e) => {
        if (id === "pump") {
          select({ kind: "pump" });
          return;
        }
        if (sel?.kind !== "group") {
          const first = groupList()[0];
          if (!first) return;
          select({ kind: "group", address: first.address });
        }
        const add = e.ctrlKey || e.metaKey || e.shiftKey;
        if (add) zoneSel = zoneSel.includes(id) ? zoneSel.filter((x) => x !== id) : [...zoneSel, id];
        else zoneSel = [id];
        slot = 0;
        redraw();
      });
      return b;
    };
    stageInner.replaceChildren(svg, hit("top", 12, 10, fanW, 34), hit("bottom", 12, 108, fanW, 34), hit("pump", px - 6, 170, 132, 132));
  }

  const stopAnim = animate((t) => {
    for (const l of leds) {
      const c = preview ? ledAt(l.kind === "fan" ? preview.fan : preview.pump, l.index, t) : null;
      const color = c ?? "transparent";
      if (l.el.getAttribute("stroke") !== color) {
        l.el.setAttribute("stroke", color);
        l.glow.setAttribute("stroke", color);
      }
    }
    paintStrip(t);
  });

  /** 预览：参数一变就重新渲染（缓存过的直接用）。 */
  function refreshPreview() {
    if (!pumpDraft) return;
    // 后端的预览接口只认 Lighting：把当前组的效果包进 fans，风扇数用这组的。
    const regions = fanDraft?.regions ?? cfg()?.lighting.fans ?? [];
    const enabled = fanDraft?.enabled ?? false;
    const l: Lighting = { enabled, fans: regions, pump: pumpDraft, scenes: [], groups: [] };
    const n = fanDraft ? fanCount() : fanFallbackCount;
    const key = JSON.stringify([l.fans, l.pump, n, enabled]);
    if (key === previewKey) return;
    previewKey = key;
    previewFor(l, enabled ? n : 0)
      .then((p) => {
        if (previewKey === key) preview = p;
      })
      .catch((e) => {
        if (previewKey === key) preview = null;
        console.warn("灯效预览失败", e);
      });
  }

  // ---------- 编辑区 ----------
  const title = h("h2", {});
  const sub = h("span", { class: "small muted" });
  const fxName = h("span", { style: "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" });
  const strip = h("span", { class: "strip" });
  const ddBtn = h("button", { type: "button", class: "dropdown-btn", "aria-haspopup": "listbox", "aria-expanded": "false" }, fxName, strip, icon("chevron"));
  const ddList = h("div", { class: "dropdown-list", role: "listbox", "aria-label": "效果" });
  ddList.hidden = true;
  const prevBtn = h("button", { type: "button", class: "btn btn-icon", "aria-label": "上一个效果" }, icon("left"));
  const nextBtn = h("button", { type: "button", class: "btn btn-icon", "aria-label": "下一个效果" }, icon("right"));
  const fxRow = h("div", { class: "irow" }, h("span", { class: "label" }, "效果"), h("div", { class: "control" }, h("div", { class: "dropdown" }, ddBtn, ddList), prevBtn, nextBtn));

  const slotsBox = h("div", { style: "display: flex; align-items: center; gap: 6px; width: 100%" });
  const custom = colorPicker({ label: "自定义颜色", size: 22, onInput: (hex) => setSlotColor(fromHex(hex)) });
  const dots = PALETTE.map((c) => {
    const b = h("button", { type: "button", class: "color-dot", style: `background: ${toHex(c)}`, "aria-label": `颜色 ${toHex(c)}` });
    b.addEventListener("click", () => setSlotColor(c));
    return b;
  });
  const colorRow = h(
    "div",
    { class: "irow", style: "padding: 12px 0" },
    h("span", { class: "label" }, "颜色"),
    h("div", { class: "control", style: "flex-direction: column; align-items: flex-start; gap: 10px" }, slotsBox, h("div", { style: "display: flex; flex-wrap: wrap; gap: 6px" }, ...dots, custom.el)),
  );

  const speedSeg = segmented(SPEEDS.map((n, i) => ({ value: i, label: n })), (v) => apply("速度", (e) => (e.speed = v), true), { label: "速度", small: true });
  const brightSeg = segmented(BRIGHTS.map((n, i) => ({ value: i, label: n })), (v) => apply("亮度", (e) => (e.brightness = v)), { label: "亮度", small: true });
  const dirSeg = segmented(
    [
      { value: "Clockwise", label: "顺时针" },
      { value: "CounterClockwise", label: "逆时针" },
    ] as { value: "Clockwise" | "CounterClockwise"; label: string }[],
    (v) => apply("方向", (e) => (e.direction = v)),
    { label: "方向", small: true },
  );
  const speedRow = h("div", { class: "irow" }, h("span", { class: "label" }, "速度"), h("div", { class: "control" }, speedSeg.el));
  const brightRow = h("div", { class: "irow" }, h("span", { class: "label" }, "亮度"), h("div", { class: "control" }, brightSeg.el));
  const dirRow = h("div", { class: "irow" }, h("span", { class: "label" }, "方向"), h("div", { class: "control" }, dirSeg.el));
  const note = h("span", { class: "small", style: "padding: 2px 0 8px 56px; color: var(--faint)" });
  const editBox = h("div", { style: "display: flex; flex-direction: column" }, fxRow, colorRow, speedRow, brightRow, dirRow, note);
  const emptyBox = h("div", { class: "disabled-note" });

  const fanStatus = h("span", { class: "sync-line" }, h("span", { class: "dot dot-ok" }), h("span", {}));
  const pumpDot = h("span", { class: "dot dot-ok" });
  const pumpStatus = h("span", { class: "sync-line", style: "color: var(--text-2)" }, pumpDot, h("span", {}));
  const applyBtn = h("button", { type: "button", class: "btn btn-primary", style: "flex: 2" }, "应用到这一组");
  const discardBtn = h("button", { type: "button", class: "btn", style: "flex: 1" }, "放弃改动");
  const fanActions = h("div", { style: "display: flex; gap: 8px" }, discardBtn, applyBtn);
  const revertBtn = h("button", { type: "button", class: "btn", style: "flex: 1" }, "还原");
  const sendBtn = h("button", { type: "button", class: "btn btn-primary", style: "flex: 2" }, "发送到冷头");
  const pumpActions = h("div", { style: "display: flex; gap: 8px" }, revertBtn, sendBtn);
  for (const el of [editBox, emptyBox, colorRow, speedRow, dirRow, pumpActions, fanActions]) el.classList.add("reveal");
  revertBtn.addEventListener("click", revertPump);
  sendBtn.addEventListener("click", sendPump);
  applyBtn.addEventListener("click", commitFans);
  discardBtn.addEventListener("click", () => {
    loadDraft();
    redraw();
  });

  const enabledSwitch = toggle("这一组由 LConnect Lite 控制", (on) => {
    if (!fanDraft) return;
    if (groupCap(fanDraft.address) !== "control") return;
    fanDraft.enabled = on;
    redraw();
  });

  const ringPanel = ring88Panel();
  let lightingTarget: "fans" | "ring" = "fans";
  const ringChip = h("button", { type: "button", class: "chip", "aria-pressed": "false" }, icon("ring88"), "通用屏灯框");
  const fanPanel = h("div", { class: "lighting-fan-panel" },
    sceneRow,
    h("section", { class: "row-grid", style: "align-items: stretch" },
      h("div", { class: "card stage-card" },
        h("div", { class: "card-head" }, h("span", { class: "small muted" }, "预览"), h("label", { class: "inline-switch small muted" }, enabledSwitch, "由 LConnect Lite 控制")),
        stage,
        h("div", { class: "card-head" }, h("span", { class: "small", style: "color: var(--faint)" }, "点灯带或冷头切换编辑对象"), h("span", { class: "small muted" }, "组内转速由风扇页设置")),
      ),
      h("aside", { class: "card inspector", "aria-label": "编辑所选区域" },
        h("div", { class: "inspector-head" }, title, sub), emptyBox, editBox,
        h("div", { class: "sync-box", role: "status" }, fanStatus, fanActions, pumpStatus, pumpActions),
      ),
    ),
  );
  const root = h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "page-title" }, h("h1", {}, "灯效"), h("span", { class: "subtitle" }, "配置风扇组、冷头灯框与通用屏灯框"))),
    h("div", { class: "group-strip" }, groupChips),
    fanPanel,
    ringPanel.root,
  );
  const selectLightingTarget = (target: "fans" | "ring") => {
    lightingTarget = target;
    ringChip.setAttribute("aria-pressed", String(target === "ring"));
    fanPanel.hidden = target !== "fans";
    ringPanel.root.hidden = target !== "ring";
    drawGroupChips();
    if (target === "ring") ringPanel.update();
  };
  ringChip.addEventListener("click", () => selectLightingTarget("ring"));
  ringPanel.root.hidden = true;

  // ---------- 效果下拉 ----------
  function modesForSelection(): string[] {
    const list = sel?.kind === "pump" ? pumpParams : capsFor(currentAddress())?.fans;
    if (!list) return [];
    const modes = list.map((p) => p.mode);
    // “关闭”放到最后，不占列表最显眼的位置。
    return [...modes.filter((m) => m !== "Off"), ...modes.filter((m) => m === "Off")];
  }
  const commonValue = <T,>(f: (e: RgbEffect) => T): T | null => {
    const vals = zoneSel.map((id) => zoneEffect(id)).filter((e): e is RgbEffect => e != null).map(f);
    return vals.length && vals.every((v) => same(v, vals[0])) ? vals[0] : null;
  };
  const pickMode = (m: string) => {
    closeList();
    apply(`效果：${modeName(m)}`, (e) => {
      e.mode = m;
      e.disabled = false;
    });
  };
  function openList() {
    const modes = modesForSelection();
    const cur = commonValue((e) => e.mode);
    active = Math.max(0, modes.indexOf(cur ?? ""));
    ddList.replaceChildren(
      h("span", { class: "dropdown-note" }, `${sel?.kind === "pump" ? "冷头灯框" : "这组风扇"} · ${modes.length} 种效果`),
      ...modes.map((m, i) => {
        const b = h("button", { type: "button", role: "option", class: i === active ? "dropdown-item active" : "dropdown-item", "aria-selected": String(m === cur) }, h("span", { class: "check" }, m === cur ? "✓" : ""), modeName(m));
        b.addEventListener("click", () => pickMode(m));
        return b;
      }),
    );
    reveal(ddList);
    open = true;
    ddBtn.setAttribute("aria-expanded", "true");
    (ddList.querySelector('[aria-selected="true"]') as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }
  function closeList() {
    if (!open) return;
    open = false;
    conceal(ddList);
    ddBtn.setAttribute("aria-expanded", "false");
  }
  ddBtn.addEventListener("click", () => (open ? closeList() : openList()));
  ddBtn.addEventListener("keydown", (e) => {
    const modes = modesForSelection();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + modes.length) % modes.length;
      ddList.querySelectorAll(".dropdown-item").forEach((el, i) => el.classList.toggle("active", i === active));
      ddList.querySelectorAll(".dropdown-item")[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      pickMode(modes[active]);
    } else if (e.key === "Escape") {
      closeList();
    }
  });
  const onDocClick = (e: MouseEvent) => {
    if (open && !(e.target as Element).closest(".dropdown")) closeList();
  };
  document.addEventListener("click", onDocClick);
  const stepMode = (d: number) => {
    const modes = modesForSelection();
    if (!modes.length) return;
    const i = modes.indexOf(commonValue((e) => e.mode) ?? "");
    pickMode(modes[(i < 0 ? 0 : i + d + modes.length) % modes.length]);
  };
  prevBtn.addEventListener("click", () => stepMode(-1));
  nextBtn.addEventListener("click", () => stepMode(1));

  // ---------- 颜色 ----------
  // TL 的“静态”“呼吸”是每只风扇一种颜色。默认按“统一颜色”显示一个色块、改一次几只一起变；
  // 只有主动切到“每只风扇”才显示带编号的色块。
  let split: boolean | null = null;
  let splitFor = "";
  const isPerFan = (id: ZoneId, e: RgbEffect) => id !== "pump" && !!paramsOf(id, e.mode)?.per_fan_colors;
  const perFanZones = () => zoneSel.filter((id) => {
    const e = zoneEffect(id);
    return e != null && isPerFan(id, e);
  });
  function splitOn() {
    const key = JSON.stringify([sel?.kind, currentAddress(), zoneSel]);
    if (key !== splitFor) {
      splitFor = key;
      split = null;
    }
    return split ?? false;
  }
  const mixedFans = () => perFanZones().some((id) => new Set(zoneEffect(id)!.colors.map(toHex)).size > 1);
  function slotCount() {
    const s = splitOn();
    return Math.max(0, ...zoneSel.map((id) => {
      const e = zoneEffect(id);
      if (!e) return 0;
      return isPerFan(id, e) && !s ? 1 : colorCount(id, e);
    }));
  }
  function setSlotColor(c: Rgb) {
    const s = splitOn();
    apply("颜色", (e, id) => {
      if (isPerFan(id, e) && !s) e.colors = e.colors.map(() => c);
      else if (slot < colorCount(id, e)) e.colors[slot] = c;
    });
  }
  const splitSeg = segmented(
    [
      { value: "same", label: "统一颜色" },
      { value: "each", label: "每只风扇" },
    ] as { value: "same" | "each"; label: string }[],
    (v) => {
      split = v === "each";
      slot = 0;
      // 切回统一：几只都用第一个颜色。
      if (!split) apply("统一颜色", (e, id) => {
        if (isPerFan(id, e)) e.colors = e.colors.map(() => e.colors[0]);
      });
      else redraw();
    },
    { label: "风扇颜色", small: true },
  );
  splitSeg.el.style.width = "170px";
  let slotsKey = "";
  function drawSlots() {
    const s = splitOn();
    const n = slotCount();
    if (slot >= n) slot = 0;
    const first = zoneSel.map((id) => zoneEffect(id)).find((e) => e && e.colors.length) ?? null;
    const perFan = perFanZones().length > 0;
    splitSeg.el.hidden = !perFan;
    splitSeg.set(s ? "each" : "same");
    const numbered = perFan && s;
    const mixed = perFan && !s && mixedFans();
    // 当前色块的颜色不在预设里时，自定义取色按钮显示为选中。
    const cur = first?.colors[slot];
    if (cur) custom.set(toHex(cur), !PALETTE.some((p) => toHex(p) === toHex(cur)));
    const key = JSON.stringify([n, slot, first?.colors, numbered, perFan, mixed]);
    if (key === slotsKey) return;
    slotsKey = key;
    // 只换色块，分段选择留在原地：挪动它会打断滑块的过渡动画。
    for (const c of [...slotsBox.children]) if (c !== splitSeg.el) c.remove();
    if (splitSeg.el.parentNode !== slotsBox) slotsBox.append(splitSeg.el);
    splitSeg.el.before(
      ...Array.from({ length: n }, (_, i) => {
        const c = first?.colors[i] ?? PALETTE[i % PALETTE.length];
        const label = numbered ? `风扇 ${i + 1} 的颜色` : n > 1 ? `颜色 ${i + 1}` : perFan ? "所有风扇的颜色" : "颜色";
        const b = h("button", { type: "button", class: "color-slot", "aria-pressed": String(i === slot), style: `background: ${toHex(c)}`, "aria-label": label, title: label }, numbered ? h("span", { class: "slot-num" }, String(i + 1)) : null);
        b.addEventListener("click", () => {
          slot = i;
          drawSlots();
        });
        return b;
      }),
      ...(mixed ? [h("span", { class: "small", style: "color: var(--faint); line-height: 1.3" }, "几只现在颜色不同，选一个颜色会统一")] : []),
    );
  }

  /** 下拉按钮里的预览条：风扇取各只的上灯带连成一条，冷头取整圈。 */
  function paintStrip(t: number) {
    const id = zoneSel[0];
    if (!id || !preview) return;
    const kids = strip.children;
    const n = id === "pump" ? PUMP_LEDS : fanCount() * 13;
    if (kids.length !== n) strip.replaceChildren(...Array.from({ length: n }, () => h("span")));
    for (let i = 0; i < n; i++) {
      const c = id === "pump" ? ledAt(preview.pump, i, t) : ledAt(preview.fan, Math.floor(i / 13) * LEDS_PER_FAN + (id === "bottom" ? 13 : 0) + (i % 13), t);
      (kids[i] as HTMLElement).style.background = c ?? "transparent";
    }
  }

  // ---------- 绘制 ----------
  function drawGroupChips() {
    const list = groupList();
    const items = list.map((g) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(lightingTarget === "fans" && sel?.kind === "group" && sel.address === g.address) }, icon("fan"), g.label, h("span", { class: "small muted" }, `×${g.count || 1}`));
      b.addEventListener("click", () => {
        selectLightingTarget("fans");
        select({ kind: "group", address: g.address });
      });
      return b;
    });
    const pump = h("button", { type: "button", class: "chip", "aria-pressed": String(lightingTarget === "fans" && sel?.kind === "pump") }, icon("pump"), "冷头灯框");
    pump.addEventListener("click", () => {
      selectLightingTarget("fans");
      select({ kind: "pump" });
    });
    ringChip.setAttribute("aria-pressed", String(lightingTarget === "ring"));
    groupChips.replaceChildren(...(items.length ? items : [h("span", { class: "small muted" }, "没有找到本机绑定的风扇组")]), pump, ringChip);
  }

  function redraw() {
    if (!cfg()) return;
    if (!sel) loadDraft();
    if (builtFans !== fanCount()) buildStage();
    drawGroupChips();
    drawScenes();

    const pumpMode = sel?.kind === "pump";
    enabledSwitch.parentElement!.hidden = pumpMode;
    if (fanDraft) enabledSwitch.checked = fanDraft.enabled;
    stage.style.opacity = fanDraft && !fanDraft.enabled && !pumpMode ? "0.45" : "";
    for (const [id, box] of Object.entries(outlineBoxes ?? {})) {
      const key = id as ZoneId;
      const on = zoneSel.includes(key) && (key === "pump" || (fanDraft?.enabled ?? false));
      box.style.opacity = on ? "1" : "0";
    }

    const cap = pumpMode ? "control" as const : groupCap(currentAddress());
    const editable = pumpMode
      ? !!pumpDraft
      : !!fanDraft && fanDraft.enabled && cap === "control" && !!capsFor(currentAddress());
    editBox.hidden = !editable;
    emptyBox.hidden = editable;
    emptyBox.textContent = pumpMode
      ? "正在读取冷头灯效能力…"
      : !fanDraft
        ? "没有可以编辑的风扇组"
        : cap === "offline"
          ? "这台组现在不在线，灯效只能查看，不能应用。"
          : cap === "readonly"
            ? "后台没有确认这台组支持单独的灯效控制（旧版后台或未验证的系列），这里只读。"
            : !fanDraft.enabled
              ? "这一组已关闭灯光控制，设备保持现有灯光。打开右上角的开关后可以编辑。"
              : "正在读取这组的灯效能力…";

    title.textContent = pumpMode ? ZN.pump : fanDraft ? groupLabel(fanDraft.address) : "编辑";
    sub.textContent = pumpMode
      ? "改动要单独发送，发送时泵会短暂降速"
      : cap === "control"
        ? "改动只作用于这一组，点“应用”后生效"
        : "只读：没有确认这台组支持灯效控制";
    enabledSwitch.disabled = !pumpMode && cap !== "control";

    if (editable) {
      const mode = commonValue((e) => e.mode);
      const modes = Array.from(new Set(zoneSel.map((id) => modeName(zoneEffect(id)!.mode))));
      fxName.textContent = mode ? modeName(mode) : `混合（${modes.join("、")}）`;
      const ps = zoneSel.map((id) => paramsOf(id, zoneEffect(id)!.mode));
      colorRow.hidden = slotCount() === 0;
      drawSlots();
      speedRow.hidden = !ps.some((p) => p?.supports_speed);
      speedSeg.set(commonValue((e) => e.speed));
      brightSeg.set(commonValue((e) => e.brightness));
      dirRow.hidden = !ps.every((p) => p && p.directions.length > 1);
      dirSeg.set(commonValue((e) => e.direction));
      note.textContent = !pumpMode && !speedRow.hidden ? "上下灯带共用一个速度（同一个无线设备）" : "";
    }

    const fansNow = fansDirty();
    fanStatus.firstElementChild!.className = fansNow ? "dot dot-warn" : "dot dot-ok";
    fanStatus.lastElementChild!.textContent = pumpMode
      ? "风扇：这组不适用"
      : cap !== "control"
        ? "风扇：只读（未确认支持）"
        : fansNow
          ? "风扇：有改动未应用"
          : "风扇：已应用";
    fanStatus.hidden = pumpMode;
    fanActions.hidden = !fansNow || pumpMode || cap !== "control";
    applyBtn.disabled = cap !== "control";

    const dirty = pumpDirty();
    pumpDot.className = dirty ? "dot dot-warn" : "dot dot-ok";
    pumpStatus.lastElementChild!.textContent = dirty ? "冷头灯框有改动未发送（发送时泵会降速约 7 秒）" : "冷头灯框：已同步";
    pumpActions.hidden = !dirty || !pumpMode;
    refreshPreview();
  }

  async function loadCaps(address: string) {
    try {
      const caps = await api.getGroupLightingCaps(address);
      capsByGroup.set(address, caps);
      fanFallbackCount = caps.fan_count || fanFallbackCount;
      if (fanDraft?.address === address && groupCap(address) === "control") {
        const z = fanZones(fanDraft.regions);
        fit("top", z.top);
        fit("bottom", z.bottom);
        fanDraft.regions = joinFans(z.top, z.bottom, z.flip);
      }
      redraw();
    } catch (e) {
      // 老版本后台没有这个命令：退回全局能力，灯效仍可编辑。
      try {
        const caps = await api.getLightingCaps();
        capsByGroup.set(address, caps);
        pumpParams ??= caps.pump;
        redraw();
      } catch {
        toast(`读取这组灯效能力失败：${e}`, { error: true, key: "caps" });
      }
    }
  }

  async function loadPumpCaps() {
    if (pumpParams) return;
    try {
      const caps = await api.getLightingCaps();
      pumpParams = caps.pump;
      fanFallbackCount = caps.fan_count || fanFallbackCount;
      redraw();
    } catch (e) {
      toast(`读取灯效能力失败：${e}`, { error: true, key: "caps" });
    }
  }

  function update() {
    ringPanel.update();
    if (!cfg()) return;
    // 配置第一次到达（或者本机后来才绑定上风扇组）：默认选第一组，而不是停在冷头上。
    if (!autoPicked) {
      autoPicked = true;
      const first = groupList()[0];
      if (first) sel = { kind: "group", address: first.address };
      loadDraft();
    }
    // 没改过就跟着后台走（撤销、导入、改名、在别的页面改了全局效果）。
    if (!sel || (!fansDirty() && !pumpDirty())) loadDraft();
    if (sel?.kind === "group" && !capsByGroup.has(sel.address)) void loadCaps(sel.address);
    void loadPumpCaps();
    redraw();
  }

  loadDraft();
  const firstGroup = groupList()[0];
  if (!sel) sel = firstGroup ? { kind: "group", address: firstGroup.address } : { kind: "pump" };
  loadDraft();
  // 已经有组就不用 update 里再自选一次（避免把这一秒里的改动冲掉）。
  autoPicked = sel?.kind === "group";
  if (sel.kind === "group") void loadCaps(sel.address);
  void loadPumpCaps();
  redraw();

  return {
    root,
    update,
    dispose() {
      stopAnim();
      ringPanel.dispose?.();
      document.removeEventListener("click", onDocClick);
    },
    async beforeLeave() {
      if (pumpDirty()) {
        const send = await confirmDialog({ title: "冷头灯框的改动还没发送", body: "发送时泵会短暂回到默认转速（约 7 秒）。不发送的话，冷头灯框保持原来的效果。", confirm: "发送并离开", cancel: "不发送" });
        if (send) await sendPump();
        else revertPump();
      }
      if (fansDirty()) {
        if (groupCap(currentAddress()) !== "control") {
          loadDraft();
        } else {
          const keep = await confirmDialog({ title: "风扇灯效还有没应用的改动", body: "离开前应用吗？不应用则丢弃这次改动。", confirm: "应用并离开", cancel: "丢弃改动" });
          if (keep) await commitFans();
          else loadDraft();
        }
      }
      return true;
    },
  };
}
