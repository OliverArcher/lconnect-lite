import type { Point } from "./api";
import { renderChart, scales, toSvgPoint, type ChartOptions } from "./chart";
import { fmt, h, s } from "./dom";

/** 曲线横轴（温度）。 */
export interface CurveX {
  min: number;
  max: number;
  /** 拖动/键盘的步长。 */
  step: number;
  /** 相邻两点之间至少隔多少（同一个单位）。 */
  gap: number;
  ticks: readonly number[];
  name: string;
}

/** 曲线纵轴（转速或占空比）。 */
export interface CurveY {
  min: number;
  max: number;
  step: number;
  ticks: readonly number[];
  /** 纵轴名称，用于数值表的表头。 */
  name: string;
  unit: string;
  color: string;
  label: (v: number) => string;
}

export interface CurveEditorOptions {
  /** 无障碍标签，比如“顶部三只的曲线”。 */
  label: string;
  x: () => CurveX;
  y: () => CurveY;
  points: () => Point[];
  /** 任何一次改动（拖动中也会调用）；由调用方决定什么时候真正保存。 */
  onChange: (points: Point[]) => void;
  /** 当前工作点；没有读数时返回 null。 */
  now?: () => { x: number | null; y: number | null };
  maxPoints?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const snap = (v: number, step: number) => Math.round(v / step) * step;

/**
 * 折线曲线编辑器：拖动、双击空白处加点、选中后方向键微调、Delete 删除，另有数值表。
 * 曲线强制随 X 不降（散热曲线温度越高转速不能越低），越界点会被相邻点夹住。
 */
export function curveEditor(o: CurveEditorOptions) {
  const maxPoints = o.maxPoints ?? 12;
  let selected: number | null = null;
  let dragging: number | null = null;
  let tableOpen = false;

  const nowX = h("span", { class: "big", style: `color: ${o.y().color}` });
  const nowArrow = h("span", { class: "muted" }, "→");
  const nowY = h("span", { class: "big" });
  const svg = s("svg", {
    class: "chart chart-edit",
    tabindex: 0,
    role: "img",
    "aria-label": `${o.label}：拖动点调整，双击空白处添加，选中后方向键微调、Delete 删除`,
  });
  const tbody = h("tbody");
  const table = h(
    "table",
    { class: "points-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", { class: "th-x" }), h("th", {}, `${o.y().name} (${o.y().unit})`), h("th", {}))),
    tbody,
  );
  const addBtn = h("button", { type: "button", class: "btn btn-sm" }, "添加点");
  const tableBtn = h("button", { type: "button", class: "btn btn-sm" }, "输入数值…");
  const tableBox = h("div", { class: "reveal", style: "display: flex; flex-direction: column; gap: 8px" }, table, h("div", {}, addBtn));
  tableBox.hidden = true;

  const el = h(
    "div",
    { class: "curve-editor" },
    h("div", { class: "curve-now" }, h("span", { class: "small muted" }, "现在"), nowX, nowArrow, nowY),
    svg,
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "small", style: "color: var(--faint)" }, "拖动点调整 · 双击添加 · 选中后方向键微调、Delete 删除"),
      tableBtn,
    ),
    tableBox,
  );

  const pts = () => o.points();
  const set = (p: Point[]) => o.onChange(p);

  function options(): ChartOptions {
    const x = o.x();
    const y = o.y();
    const n = o.now?.() ?? { x: null, y: null };
    const p = pts()[selected ?? -1];
    return {
      width: 460,
      height: 240,
      x: { min: x.min, max: x.max, ticks: x.ticks, label: (v) => `${v}°` },
      y: { min: y.min, max: y.max, ticks: y.ticks, label: y.label },
      points: pts(),
      color: y.color,
      marker: n.x != null && n.y != null ? { x: n.x, y: n.y } : null,
      selected,
      tip: p ? `${p[0].toFixed(1)} °C · ${Math.round(p[1])}${y.unit === "%" ? "%" : ` ${y.unit}`}` : null,
      editable: true,
    };
  }

  function drawChart() {
    renderChart(svg, options());
    const n = o.now?.() ?? { x: null, y: null };
    nowX.textContent = n.x == null ? "—" : `${fmt(n.x, 1)} °C`;
    nowY.textContent = n.y == null ? "—" : `${Math.round(n.y)}${o.y().unit === "%" ? "%" : ` ${o.y().unit}`}`;
  }

  function drawTable() {
    if (tableBox.hidden || tbody.contains(document.activeElement)) return;
    const x = o.x();
    const y = o.y();
    el.querySelector(".th-x")!.textContent = `${x.name} (°C)`;
    const p = pts();
    tbody.replaceChildren(
      ...p.map(([px, py], i) => {
        const xi = h("input", { type: "number", class: "input input-num", min: x.min, max: x.max, step: x.step, value: px, "aria-label": `第 ${i + 1} 点${x.name}` });
        const yi = h("input", { type: "number", class: "input input-num", min: y.min, max: y.max, step: y.step, value: py, "aria-label": `第 ${i + 1} 点${y.name}` });
        const del = h("button", { type: "button", class: "btn btn-sm btn-ghost", disabled: p.length <= 2, "aria-label": `删除第 ${i + 1} 点` }, "删除");
        xi.addEventListener("change", () => editPoint(i, Number(xi.value), null));
        yi.addEventListener("change", () => editPoint(i, null, Number(yi.value)));
        del.addEventListener("click", () => removePoint(i));
        return h("tr", {}, h("td", { class: "muted" }, String(i + 1)), h("td", {}, xi), h("td", {}, yi), h("td", {}, del));
      }),
    );
    addBtn.toggleAttribute("disabled", p.length >= maxPoints);
  }

  function redraw() {
    if (dragging == null) drawChart();
    drawTable();
  }

  /** 温度夹在相邻两点之间；数值也夹在相邻两点之间，保证曲线随温度不降。 */
  function constrain(i: number, xv: number, yv: number, p: Point[]): Point {
    const x = o.x();
    const y = o.y();
    const xLo = i > 0 ? p[i - 1][0] + x.gap : x.min;
    const xHi = i < p.length - 1 ? p[i + 1][0] - x.gap : x.max;
    const yLo = i > 0 ? p[i - 1][1] : y.min;
    const yHi = i < p.length - 1 ? p[i + 1][1] : y.max;
    return [clamp(snap(xv, x.step), xLo, xHi), clamp(snap(yv, y.step), yLo, yHi)];
  }

  function editPoint(i: number, xv: number | null, yv: number | null) {
    const x = o.x();
    const p = structuredClone(pts());
    if (!p[i]) return;
    if (xv != null && Number.isFinite(xv)) {
      // 表里改温度可能越过相邻点：改完重新排序，选中跟着这个点走。
      p[i] = [clamp(snap(xv, x.step), x.min, x.max), p[i][1]];
      const moved = p[i];
      p.sort((a, b) => a[0] - b[0]);
      i = p.indexOf(moved);
      for (let j = 1; j < p.length; j++) {
        if (p[j][0] - p[j - 1][0] < x.gap) p[j][0] = p[j - 1][0] + x.gap;
        if (p[j][1] < p[j - 1][1]) p[j][1] = p[j - 1][1];
      }
    }
    if (yv != null && Number.isFinite(yv)) p[i] = constrain(i, p[i][0], yv, p);
    selected = i;
    set(p);
    redraw();
  }

  function addPoint(xv: number, yv: number) {
    const x = o.x();
    const p = structuredClone(pts());
    if (p.length >= maxPoints) return;
    const sx = clamp(snap(xv, x.step), x.min, x.max);
    if (p.some(([px]) => Math.abs(px - sx) < x.gap)) return;
    const np: Point = [sx, clamp(snap(yv, o.y().step), o.y().min, o.y().max)];
    p.push(np);
    p.sort((a, b) => a[0] - b[0]);
    selected = p.indexOf(np);
    p[selected] = constrain(selected, sx, np[1], p);
    set(p);
    redraw();
  }

  function removePoint(i: number) {
    const p = structuredClone(pts());
    if (p.length <= 2) return;
    p.splice(i, 1);
    selected = null;
    set(p);
    redraw();
  }

  // 拖动：在 svg 上捕获指针，拖动中只重画。
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
    set(p);
    drawChart();
  });
  const endDrag = () => {
    if (dragging == null) return;
    dragging = null;
    drawTable();
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
    const [px, py] = pts()[selected] ?? [0, 0];
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-o.x().step, 0],
      ArrowRight: [o.x().step, 0],
      ArrowUp: [0, o.y().step],
      ArrowDown: [0, -o.y().step],
    };
    if (e.key in moves) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      const k = e.shiftKey ? 10 : 1;
      const p = structuredClone(pts());
      p[selected] = constrain(selected, px + dx * k, py + dy * k, p);
      set(p);
      redraw();
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
      redraw();
    },
    reset() {
      selected = null;
    },
  };
}
