import type { Config, Mode, Point, TempSource } from "../api";
import { renderChart, scales, toSvgPoint, type ChartOptions } from "../chart";
import { activePreset, applyPreset, evalCurve, PRESETS } from "../curve";
import { fmt, h, s } from "../dom";
import { icon } from "../icons";
import { fold } from "../motion";
import { commit, store } from "../store";
import { row, segmented, slider } from "../ui";
import type { View } from "./view";

type Kind = "fan" | "pump";

/** 每条曲线的坐标范围、步长和硬件限制。 */
const SPEC = {
  fan: { yMin: 20, yMax: 100, yStep: 1, axis: { min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] }, unit: "%", name: "风扇", color: "var(--c-fan)", label: (v: number) => `${v}%` },
  pump: { yMin: 1600, yMax: 3200, yStep: 10, axis: { min: 1600, max: 3200, ticks: [1600, 2000, 2400, 2800, 3200] }, unit: "rpm", name: "泵", color: "var(--c-pump)", label: (v: number) => `${(v / 1000).toFixed(1)}k` },
} as const;
/** 横轴：水温一般在 20–55 °C；GPU 温度范围更大。 */
const X_COOLANT = { min: 20, max: 55, step: 0.5, gap: 0.5, ticks: [20, 30, 40, 50], name: "水温" };
const X_GPU = { min: 30, max: 90, step: 1, gap: 1, ticks: [30, 50, 70, 90], name: "GPU 温度" };
const MAX_POINTS = 12;
/** 键盘微调、加减按钮停手这么久后才提交，免得连按时每下都写一次配置。 */
const SETTLE_MS = 600;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const snap = (v: number, step: number) => Math.round(v / step) * step;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function cooling(): View {
  /** 页面上正在显示的配置：拖动或连按时先改它，停手后再提交。 */
  let draft: Config | null = store.config ? structuredClone(store.config) : null;
  let busy = false;
  let timer = 0;
  let advancedOpen = true;

  function submit(label: string, key: string) {
    clearTimeout(timer);
    busy = false;
    if (draft) commit(structuredClone(draft), label, key, ["cooling"]);
  }
  function later(label: string, key: string) {
    busy = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => submit(label, key), SETTLE_MS);
  }
  function change(label: string, key: string, mutate: (c: Config) => void) {
    if (!draft) return;
    mutate(draft);
    redraw();
    submit(label, key);
  }

  // ---------- 顶部 ----------
  const modeSeg = segmented<Mode>(
    [
      { value: "curve", label: "按温度曲线" },
      { value: "fixed", label: "固定转速" },
      { value: "motherboard", label: "跟随主板" },
    ],
    (m) => change(m === "curve" ? "按温度曲线控制" : m === "fixed" ? "固定转速" : "跟随主板", "mode", (c) => (c.cooling.mode = m)),
    { label: "控制方式" },
  );
  const presetChips = PRESETS.map((p) => {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": "false" }, p.name);
    b.addEventListener("click", () => {
      if (!draft) return;
      draft = applyPreset(draft, p);
      redraw();
      submit(`载入${p.name}预设`, "preset");
    });
    return b;
  });
  const presetRow = h("div", { style: "display: flex; flex-wrap: wrap; align-items: center; gap: 8px" }, h("span", { class: "subtitle", style: "margin-right: 4px" }, "从预设载入（只影响没有单独设置的组）"), ...presetChips);

  // ---------- 曲线卡片 ----------
  const editors = (["fan", "pump"] as Kind[]).map((k) => curveCard(k));
  const curveSection = h("section", { class: "row-grid" }, ...editors.map((e) => e.el));

  function curveCard(kind: Kind) {
    const spec = SPEC[kind];
    let selected: number | null = null;
    let dragging: number | null = null;
    let tableOpen = false;

    const pts = (): Point[] => (draft ? draft.cooling[kind === "fan" ? "fan_curve" : "pump_curve"].points : []);
    const setPts = (p: Point[]) => {
      if (draft) draft.cooling[kind === "fan" ? "fan_curve" : "pump_curve"].points = p;
    };
    const source = (): TempSource => (kind === "fan" ? draft?.cooling.fan_source ?? "coolant" : "coolant");
    const X = () => (source() === "gpu" ? X_GPU : X_COOLANT);
    const temp = () => (source() === "gpu" ? store.status?.gpu_temp_c : store.status?.coolant_c) ?? null;

    const sourceSeg =
      kind === "fan"
        ? segmented<TempSource>(
            [
              { value: "coolant", label: "水温" },
              { value: "gpu", label: "GPU 温度" },
            ],
            (next) => {
              if (!draft || next === draft.cooling.fan_source) return;
              // 两种温度的范围不同，按比例换算横坐标，曲线形状不变。
              const [from, to] = next === "gpu" ? [X_COOLANT, X_GPU] : [X_GPU, X_COOLANT];
              const k = (to.max - to.min) / (from.max - from.min);
              draft.cooling.fan_curve.points = draft.cooling.fan_curve.points.map(([x, y]): Point => [clamp(snap(to.min + (x - from.min) * k, to.step), to.min, to.max), y]);
              draft.cooling.fan_source = next;
              selected = null;
              redraw();
              submit(next === "gpu" ? "风扇改按 GPU 温度" : "风扇改按水温", "source");
            },
            { label: "风扇曲线依据", small: true },
          )
        : null;
    if (sourceSeg) sourceSeg.el.style.width = "200px";

    const nowTemp = h("span", { class: "big" });
    const nowOut = h("span", { class: "big", style: `color: ${spec.color}` });
    const nowExtra = h("span", { class: "small muted" });
    const svg = s("svg", { class: "chart chart-edit", tabindex: 0, role: "img", "aria-label": `${spec.name}曲线编辑区：拖动点调整，双击空白处添加，选中后方向键微调、Delete 删除` });
    const tableBtn = h("button", { type: "button", class: "btn btn-sm" }, "输入数值…");
    const tbody = h("tbody");
    const table = h(
      "table",
      { class: "points-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", { class: "th-x" }), h("th", {}, `${spec.name} (${spec.unit})`), h("th", {}))),
      tbody,
    );
    const addBtn = h("button", { type: "button", class: "btn btn-sm" }, "添加点");
    const tableBox = h("div", { class: "reveal", style:"display: flex; flex-direction: column; gap: 8px" }, table, h("div", {}, addBtn));
    tableBox.hidden = true;

    const el = h(
      "div",
      { class: "card curve-card" },
      h(
        "div",
        { class: "card-head" },
        h("div", { style: "display: flex; align-items: center; gap: 10px" }, h("span", { class: "stat-key", style: `width: 10px; height: 10px; border-radius: 3px; background: ${spec.color}` }), h("h2", {}, spec.name)),
        sourceSeg ? sourceSeg.el : h("span", { class: "small muted" }, "依据 水温"),
      ),
      h("div", { class: "curve-now" }, h("span", { class: "small muted" }, "现在"), nowTemp, h("span", { class: "muted" }, "→"), nowOut, nowExtra),
      svg,
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "small", style: "color: var(--faint)" }, "拖动点调整 · 双击添加 · 选中后方向键微调、Delete 删除"),
        tableBtn,
      ),
      tableBox,
    );

    function options(): ChartOptions {
      const t = temp();
      const st = store.status;
      const now = kind === "fan" ? st?.fan_percent : st?.pump_rpm;
      const p = pts()[selected ?? -1];
      return {
        width: 460,
        height: 250,
        x: { min: X().min, max: X().max, ticks: X().ticks, label: (v) => `${v}°` },
        y: { ...spec.axis, label: spec.label },
        points: pts(),
        color: spec.color,
        marker: t != null && now != null ? { x: t, y: now } : null,
        selected,
        tip: p ? `${p[0].toFixed(1)} °C · ${p[1]}${kind === "fan" ? "%" : " rpm"}` : null,
        editable: true,
      };
    }

    function drawChart() {
      renderChart(svg, options());
      const t = temp();
      const target = t != null ? evalCurve(pts(), t) : null;
      nowTemp.textContent = `${fmt(t, 1)} °C`;
      nowOut.textContent = target == null ? "—" : kind === "fan" ? `${Math.round(target)}%` : `${Math.round(target)} rpm`;
      const st = store.status;
      nowExtra.textContent = kind === "pump" && st?.pump_rpm != null ? `实测 ${st.pump_rpm}` : kind === "fan" && st?.boost_percent ? `前馈 +${fmt(st.boost_percent, 1)}` : "";
    }

    function drawTable() {
      if (tableBox.hidden || tbody.contains(document.activeElement)) return;
      el.querySelector(".th-x")!.textContent = `${X().name} (°C)`;
      const p = pts();
      tbody.replaceChildren(
        ...p.map(([x, y], i) => {
          const xi = h("input", { type: "number", class: "input input-num", min: X().min, max: X().max, step: X().step, value: x, "aria-label": `第 ${i + 1} 点${X().name}` });
          const yi = h("input", { type: "number", class: "input input-num", min: spec.yMin, max: spec.yMax, step: spec.yStep, value: y, "aria-label": `第 ${i + 1} 点${spec.name}` });
          const del = h("button", { type: "button", class: "btn btn-sm btn-ghost", disabled: p.length <= 2, "aria-label": `删除第 ${i + 1} 点` }, "删除");
          xi.addEventListener("change", () => editPoint(i, Number(xi.value), null, true));
          yi.addEventListener("change", () => editPoint(i, null, Number(yi.value), true));
          del.addEventListener("click", () => removePoint(i));
          return h("tr", {}, h("td", { class: "muted" }, String(i + 1)), h("td", {}, xi), h("td", {}, yi), h("td", {}, del));
        }),
      );
      addBtn.toggleAttribute("disabled", p.length >= MAX_POINTS);
    }

    /** 温度夹在相邻两点之间；数值也夹在相邻两点之间，保证曲线随温度不降。 */
    function constrain(i: number, x: number, y: number, p: Point[]): Point {
      const xLo = i > 0 ? p[i - 1][0] + X().gap : X().min;
      const xHi = i < p.length - 1 ? p[i + 1][0] - X().gap : X().max;
      const yLo = i > 0 ? p[i - 1][1] : spec.yMin;
      const yHi = i < p.length - 1 ? p[i + 1][1] : spec.yMax;
      return [clamp(snap(x, X().step), xLo, xHi), clamp(snap(y, spec.yStep), yLo, yHi)];
    }

    const label = () => `${spec.name}曲线`;

    function editPoint(i: number, x: number | null, y: number | null, now: boolean) {
      const p = structuredClone(pts());
      if (!p[i]) return;
      if (x != null && Number.isFinite(x)) {
        // 表格里改温度可能越过相邻点：改完重新排序，选中跟着这个点走。
        p[i] = [clamp(snap(x, X().step), X().min, X().max), p[i][1]];
        const moved = p[i];
        p.sort((a, b) => a[0] - b[0]);
        i = p.indexOf(moved);
        for (let j = 1; j < p.length; j++) {
          if (p[j][0] - p[j - 1][0] < X().gap) p[j][0] = p[j - 1][0] + X().gap;
          if (p[j][1] < p[j - 1][1]) p[j][1] = p[j - 1][1];
        }
      }
      if (y != null && Number.isFinite(y)) p[i] = constrain(i, p[i][0], y, p);
      selected = i;
      setPts(p);
      redraw();
      if (now) submit(label(), kind);
      else later(label(), kind);
    }

    function addPoint(x: number, y: number) {
      const p = structuredClone(pts());
      if (p.length >= MAX_POINTS) return;
      const sx = clamp(snap(x, X().step), X().min, X().max);
      if (p.some(([px]) => Math.abs(px - sx) < X().gap)) return;
      const np: Point = [sx, y];
      p.push(np);
      p.sort((a, b) => a[0] - b[0]);
      selected = p.indexOf(np);
      p[selected] = constrain(selected, sx, y, p);
      setPts(p);
      redraw();
      submit(`${label()}加了一个点`, kind);
    }

    function removePoint(i: number) {
      const p = structuredClone(pts());
      if (p.length <= 2) return;
      p.splice(i, 1);
      selected = null;
      setPts(p);
      redraw();
      submit(`${label()}删了一个点`, kind);
    }

    // 拖动：在 svg 上捕获指针，拖动中只重画，松手才提交。
    svg.addEventListener("pointerdown", (e) => {
      const g = (e.target as Element).closest(".chart-point");
      if (!g) {
        if (selected != null) {
          selected = null;
          drawChart();
        }
        return;
      }
      selected = Number(g.getAttribute("data-index"));
      dragging = selected;
      busy = true;
      svg.setPointerCapture(e.pointerId);
      svg.focus();
      drawChart();
    });
    svg.addEventListener("pointermove", (e) => {
      if (dragging == null) return;
      const { ix, iy } = scales(options());
      const { x, y } = toSvgPoint(svg, e);
      const p = structuredClone(pts());
      p[dragging] = constrain(dragging, ix(x), iy(y), p);
      setPts(p);
      drawChart();
    });
    const endDrag = () => {
      if (dragging == null) return;
      dragging = null;
      drawTable();
      submit(label(), kind);
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
    svg.addEventListener("dblclick", (e) => {
      if ((e.target as Element).closest(".chart-point")) return;
      const { ix, iy } = scales(options());
      const { x, y } = toSvgPoint(svg, e);
      addPoint(ix(x), iy(y));
    });
    svg.addEventListener("keydown", (e) => {
      if (selected == null) return;
      const [x, y] = pts()[selected] ?? [0, 0];
      const moves: Record<string, [number, number]> = { ArrowLeft: [-X().step, 0], ArrowRight: [X().step, 0], ArrowUp: [0, spec.yStep], ArrowDown: [0, -spec.yStep] };
      if (e.key in moves) {
        e.preventDefault();
        const [dx, dy] = moves[e.key];
        const k = e.shiftKey ? 10 : 1;
        const p = structuredClone(pts());
        p[selected] = constrain(selected, x + dx * k, y + dy * k, p);
        setPts(p);
        redraw();
        later(label(), kind);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removePoint(selected);
      } else if (e.key === "Escape") {
        selected = null;
        drawChart();
      }
    });
    tableBtn.addEventListener("click", () => {
      tableOpen = !tableOpen;
      tableBox.hidden = !tableOpen;
      tableBtn.textContent = tableOpen ? "收起数值" : "输入数值…";
      drawTable();
    });
    addBtn.addEventListener("click", () => {
      const p = pts();
      const i = selected ?? p.length - 1;
      const next = p[i + 1];
      // 加在选中点和下一个点中间；已经是最后一个就往右 5 °C。
      addPoint(next ? (p[i][0] + next[0]) / 2 : p[i][0] + 5, next ? (p[i][1] + next[1]) / 2 : p[i][1]);
    });

    return {
      el,
      draw() {
        if (dragging == null) drawChart();
        drawTable();
        sourceSeg?.set(source());
      },
      reset() {
        selected = null;
      },
    };
  }

  // ---------- 固定 / 跟随主板 ----------
  const fixedFan = slider({ label: "风扇固定转速", min: 20, max: 100, step: 1, format: (v) => `${v}%`, onCommit: (v) => change("风扇固定转速", "fixed-fan", (c) => (c.cooling.fixed_fan_percent = v)) });
  const fixedPump = slider({ label: "泵固定转速", min: 1600, max: 3200, step: 50, format: (v) => `${v} rpm`, onCommit: (v) => change("泵固定转速", "fixed-pump", (c) => (c.cooling.fixed_pump_rpm = v)) });
  const fanRow = row("风扇", null, fixedFan.input, fixedFan.out);
  const mbText = h("span", { class: "row-desc" });
  const mbRow = row("风扇跟随主板", mbText, h("span", { class: "row-value", style: "width: auto" }));
  const fixedList = h("div", { class: "list" }, fanRow, mbRow, row("泵", "固定转速；方屏冷头 1600–3200 rpm", fixedPump.input, fixedPump.out));

  // ---------- 高级 ----------
  const slew = slider({ label: "风扇变化限速", min: 1, max: 20, step: 1, format: (v) => `${v} %/秒`, onCommit: (v) => change("风扇变化限速", "slew", (c) => (c.cooling.fan_slew_percent_per_s = v)) });
  const cpuBoost = slider({ label: "CPU 负载前馈", min: 0, max: 30, step: 1, format: (v) => (v ? `+${v}%` : "关闭"), onCommit: (v) => change("CPU 负载前馈", "cpu-boost", (c) => (c.cooling.cpu_boost_percent = v)) });
  const gpuBoost = slider({ label: "GPU 负载前馈", min: 0, max: 30, step: 1, format: (v) => (v ? `+${v}%` : "关闭"), onCommit: (v) => change("GPU 负载前馈", "gpu-boost", (c) => (c.cooling.gpu_boost_percent = v)) });
  const pumpBoost = slider({
    label: "泵功耗前馈",
    min: 0,
    max: 1000,
    step: 50,
    format: (v) => (v ? `+${v} rpm` : "关闭"),
    onCommit: (v) => change("泵功耗前馈", "pump-boost", (c) => (c.cooling.pump_power_boost_rpm = v)),
  });
  const guardSeg = segmented(
    [
      { value: 0, label: "关闭" },
      { value: 85, label: "85 °C" },
      { value: 90, label: "90 °C" },
      { value: 95, label: "95 °C" },
    ],
    (v) => change("CPU 温度保护", "cpu-guard", (c) => (c.cooling.cpu_temp_limit_c = v)),
    { label: "CPU 温度保护", small: true },
  );
  // 读不到 CPU 温度 / 功耗时，这两项的说明后面附上原因。
  const pumpBoostDesc = h("span", { class: "row-desc" });
  const guardDesc = h("span", { class: "row-desc" });
  const advHead = h("button", { type: "button", class: "collapse-head", "aria-expanded": "true" }, "高级", icon("chevronUp"));
  // 前馈只在曲线模式下生效，其他模式不显示。
  const cpuRow = row("CPU 负载前馈", "CPU 满载时额外加的风扇转速，不等水温升起来", cpuBoost.input, cpuBoost.out);
  const gpuRow = row("GPU 负载前馈", "GPU 满载时额外加的风扇转速", gpuBoost.input, gpuBoost.out);
  const pumpBoostRow = row("泵功耗前馈", pumpBoostDesc, pumpBoost.input, pumpBoost.out);
  const guardRow = row("CPU 温度保护", guardDesc, guardSeg.el);
  const advBody = h(
    "div",
    {},
    row("风扇变化限速", "水温跳动时风扇每秒最多变化多少，避免忽快忽慢", slew.input, slew.out),
    pumpBoostRow,
    guardRow,
    cpuRow,
    gpuRow,
  );
  advBody.querySelectorAll(".row").forEach((r) => ((r as HTMLElement).style.borderTop = "1px solid var(--line)"));
  advHead.addEventListener("click", () => {
    advancedOpen = !advancedOpen;
    advHead.setAttribute("aria-expanded", String(advancedOpen));
    fold(advBody, advancedOpen);
  });
  // 切换控制方式时，新出现的区块淡入一次（display 从 none 变回来才会播放）。
  for (const el of [presetRow, curveSection, fixedList, fanRow, mbRow]) el.classList.add("reveal");

  const root = h(
    "div",
    { class: "page" },
    h(
      "header",
      { class: "page-head" },
      h("div", { class: "page-title" }, h("h1", {}, "水冷"), h("span", { class: "subtitle" }, "泵、前馈与保护在这里；风扇按组单独设置")),
      h(
        "div",
        { style: "display: flex; align-items: center; gap: 12px" },
        h("a", { href: "#/fans", class: "btn btn-ghost btn-sm" }, "风扇分组…"),
        h("span", { class: "subtitle" }, "控制方式"),
        modeSeg.el,
      ),
    ),
    presetRow,
    curveSection,
    fixedList,
    h("section", { class: "list" }, advHead, advBody),
  );

  function redraw() {
    if (!draft) return;
    const c = draft.cooling;
    modeSeg.set(c.mode);
    const preset = activePreset(draft);
    presetChips.forEach((b, i) => {
      const on = preset?.id === PRESETS[i].id;
      b.setAttribute("aria-pressed", String(on));
      b.textContent = on ? `${PRESETS[i].name} · 当前` : PRESETS[i].name;
    });
    const curve = c.mode === "curve";
    presetRow.hidden = !curve;
    curveSection.hidden = !curve;
    fixedList.hidden = curve;
    fanRow.hidden = c.mode !== "fixed";
    mbRow.hidden = c.mode !== "motherboard";
    cpuRow.hidden = !curve;
    gpuRow.hidden = !curve;
    const mb = store.status?.mb_pwm_percent;
    mbText.textContent = mb != null ? `主板 PWM 现在 ${fmt(mb)}%` : "没有采样到主板 PWM 信号（接收器需要接主板风扇口的 PWM 线），风扇暂用固定值";
    editors.forEach((e) => e.draw());
    fixedFan.set(c.fixed_fan_percent);
    fixedPump.set(c.fixed_pump_rpm);
    slew.set(c.fan_slew_percent_per_s);
    cpuBoost.set(c.cpu_boost_percent);
    gpuBoost.set(c.gpu_boost_percent);
    pumpBoost.set(c.pump_power_boost_rpm);
    guardSeg.set(c.cpu_temp_limit_c as 0 | 85 | 90 | 95);
    pumpBoostRow.hidden = !curve;
    const why = store.status?.cpu_sensor_error;
    const missing = why ? `。现在读不到 CPU 数据：${why}` : "";
    pumpBoostDesc.textContent = `CPU 功耗 50 W 起，到 200 W 时泵额外加这么多，负载一来就加速，不等水温升起来${missing}`;
    guardDesc.textContent = `CPU 封装温度到这里时泵拉满、风扇至少 80%，降 8 °C 后恢复；所有控制方式下都生效${missing}`;
  }

  function update() {
    // 后台配置变了（撤销、在概览页切了档位、托盘菜单）：没在编辑就跟着更新。
    if (store.config && !busy && !same(draft, store.config)) {
      draft = structuredClone(store.config);
      editors.forEach((e) => e.reset());
    }
    redraw();
  }

  redraw();
  return {
    root,
    update,
    dispose() {
      // 离开页面时还有没提交的微调：立刻提交，不丢改动。
      if (busy) submit("散热设置", "cooling-leave");
    },
  };
}
