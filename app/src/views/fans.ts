import { type FanGroup, type FanGroupPolicy, type GroupSource, type Mode, type Point } from "../api";
import { curveEditor, type CurveX } from "../curve-editor";
import { evalCurve } from "../curve";
import { deviceAlias, identifyDevice, renameDevice } from "../device-actions";
import { h } from "../dom";
import { icon } from "../icons";
import { commit, store } from "../store";
import { confirmDialog, row, segmented, slider, toast } from "../ui";
import type { View } from "./view";

const SOURCES: { value: GroupSource; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "coolant", label: "水温" },
  { value: "gpu", label: "GPU" },
];

/** 各采样源的横轴范围（和后台服务一致：水温 20–55、GPU 30–90、CPU 30–100）。 */
const AXES: Record<GroupSource, CurveX> = {
  coolant: { min: 20, max: 55, step: 0.5, gap: 0.5, ticks: [20, 30, 40, 50], name: "水温" },
  gpu: { min: 30, max: 90, step: 1, gap: 1, ticks: [30, 50, 70, 90], name: "GPU 温度" },
  cpu: { min: 30, max: 100, step: 1, gap: 1, ticks: [30, 50, 70, 90], name: "CPU 温度" },
};

const MODES: { value: Mode; label: string }[] = [
  { value: "curve", label: "按温度曲线" },
  { value: "fixed", label: "固定转速" },
  { value: "motherboard", label: "跟随主板" },
];

/** 与后台服务约定的组策略默认值：没有配置条目的组按这一份显示。 */
function defaults(address: string): FanGroupPolicy {
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
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clampSnap = (v: number, step: number) => Math.round(v / step) * step;

export function fans(): View {
  let drafts = new Map<string, FanGroupPolicy>();
  let cards = new Map<string, GroupCard>();
  let builtKey = "";
  let identifying = new Set<string>();

  const root = h("div", { class: "page" });
  const list = h("div", { class: "group-list" });
  const note = h("div", { class: "list-note" });
  root.append(
    h(
      "header",
      { class: "page-head" },
      h(
        "div",
        { class: "page-title" },
        h("h1", {}, "风扇"),
        h("span", { class: "subtitle" }, "按无线组单独设置：组内统一转速，采样源和采样点各用各的"),
      ),
      h("a", { href: "#/cooling", class: "btn btn-ghost btn-sm" }, "水冷与泵…"),
    ),
    note,
    list,
  );

  /** 组策略：配置里有就用配置，没有就用约定默认值（此时不算“改过”）。 */
  function policyOf(address: string): FanGroupPolicy {
    const fromConfig = (store.config?.cooling.groups ?? []).find((g) => g.address === address);
    return structuredClone(fromConfig ?? defaults(address));
  }

  function draftOf(address: string): FanGroupPolicy {
    let d = drafts.get(address);
    if (!d) {
      d = policyOf(address);
      drafts.set(address, d);
    }
    return d;
  }

  function isDirty(address: string): boolean {
    const d = drafts.get(address);
    return d ? !same(d, policyOf(address)) : false;
  }

  function aliasOf(address: string): string {
    return deviceAlias(address, store.config?.devices.aliases);
  }

  function statusOf(address: string): FanGroup | undefined {
    return store.status?.fan_groups.find((g) => g.address === address);
  }

  function labelOf(address: string): string {
    const alias = aliasOf(address);
    if (alias) return alias;
    const g = statusOf(address);
    if (g) return `${g.kind} ×${g.rpm.length || g.pwm.length}`;
    const p = (store.config?.cooling.groups ?? []).find((x) => x.address === address);
    return p ? "风扇组" : address;
  }

  function sourceTemp(source: GroupSource): number | null {
    const st = store.status;
    if (!st) return null;
    if (source === "coolant") return st.coolant_c;
    if (source === "gpu") return st.gpu_temp_c ?? null;
    return st.cpu_temp_c ?? null;
  }

  function apply(card: GroupCard) {
    if (!store.config) return;
    const offline = capOf(card.address) === "offline";
    const next = structuredClone(store.config);
    const i = next.cooling.groups.findIndex((g) => g.address === card.address);
    const policy = structuredClone(card.draft);
    if (i >= 0) next.cooling.groups[i] = policy;
    else next.cooling.groups.push(policy);
    const label = `${card.title()} 的风扇策略`;
    commit(next, label, `fan-group-${card.address}`, ["cooling"], { quiet: offline }).then((ok) => {
      // 离线组只写配置：不说“已生效”，等设备上线才可能下发。
      if (ok && offline) toast(`已保存到配置；${card.title()} 连上后才会下发`, { key: `fan-group-${card.address}` });
    });
  }

  function reset(card: GroupCard) {
    card.draft = policyOf(card.address);
    drafts.set(card.address, card.draft);
    card.refresh();
  }

  /** 组列表变了才重建卡片；否则只刷新数值，免得打断正在调的滑块。 */
  function syncGroups() {
    const addresses = new Set<string>();
    for (const g of store.status?.fan_groups ?? []) addresses.add(g.address);
    for (const g of store.config?.cooling.groups ?? []) addresses.add(g.address);
    const key = [...addresses].sort().join("|");
    if (key !== builtKey) {
      builtKey = key;
      const keep = new Map<string, FanGroupPolicy>();
      for (const a of addresses) keep.set(a, drafts.get(a) ?? policyOf(a));
      drafts = keep;
      cards = new Map();
      list.replaceChildren(
        ...[...addresses].sort().map((address) => {
          const card = groupCard(address);
          cards.set(address, card);
          return card.el;
        }),
      );
      if (!addresses.size) list.append(h("div", { class: "list-note empty" }, "还没有找到本机绑定的无线风扇组。"));
    }
    note.textContent =
      "组内所有风扇共用一个转速；组之间的曲线、采样源和采样点互不影响。读取不到的温度源会按各组的兜底转速运行。";
  }

  /** 这台组当前能做到什么：真正支持才算可调速；旧后台没这个字段时一律只读。 */
  function capOf(address: string): "control" | "readonly" | "offline" {
    const g = statusOf(address);
    if (!g) return "offline";
    return g.supports_control === true ? "control" : "readonly";
  }

  function groupCard(address: string): GroupCard {
    const draft = draftOf(address);
    let advancedOpen = false;
    const name = h("span", { class: "group-name" });
    const sub = h("span", { class: "small muted mono" });
    const badge = h("span", { class: "badge" });
    const readings = h("span", { class: "group-readings" });
    const errorLine = h("span", { class: "small error-text" });
    const footHint = h("span", { class: "small muted" });
    const applyBtn = h("button", { type: "button", class: "btn btn-sm btn-primary" }, "应用");
    const resetBtn = h("button", { type: "button", class: "btn btn-sm" }, "还原");
    const identifyBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost" }, icon("locate"), "识别");
    const renameBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost" }, icon("rename"), "命名");

    // ---------- 控制方式 ----------
    const modeSeg = segmented<Mode>(MODES, (m) => {
      draft.mode = m;
      refresh();
    }, { label: `${address} 的控制方式` });
    modeSeg.el.style.width = "100%";

    const fixed = slider({
      label: "固定转速",
      min: 20,
      max: 100,
      step: 1,
      format: (v) => `${v}%`,
      onCommit: (v) => {
        draft.fixed_percent = v;
        refresh();
      },
    });
    const fixedRow = row("固定转速", "组内所有风扇都用这个占空比", fixed.input, fixed.out);

    // ---------- 曲线 ----------
    const sourceSeg = segmented<GroupSource>(SOURCES, (s) => {
      if (s === draft.source) return;
      // 两种温度的范围不同，按比例换算横坐标，曲线形状不变。
      const from = AXES[draft.source];
      const to = AXES[s];
      const k = (to.max - to.min) / (from.max - from.min);
      draft.curve.points = draft.curve.points.map(([x, y]): Point => [clampSnap(to.min + (x - from.min) * k, to.step), y]);
      draft.source = s;
      editor.reset();
      refresh();
    }, { label: "采样源", small: true });
    sourceSeg.el.style.width = "220px";

    const editor = curveEditor({
      label: `${labelOf(address)} 的曲线`,
      x: () => AXES[draft.source],
      y: () => ({ min: 20, max: 100, step: 1, ticks: [20, 40, 60, 80, 100], name: "转速", unit: "%", color: "var(--c-fan)", label: (v) => `${v}%` }),
      points: () => draft.curve.points,
      onChange: (p) => {
        draft.curve.points = p;
        refresh();
      },
      now: () => {
        const t = sourceTemp(draft.source);
        if (t == null) return { x: null, y: null };
        return { x: t, y: evalCurve(draft.curve.points, t) };
      },
    });

    const curveBox = h(
      "div",
      { class: "group-curve" },
      h("div", { class: "group-curve-head" }, h("span", { class: "small muted" }, "采样源"), sourceSeg.el),
      editor.el,
    );

    const mbNote = h("span", { class: "row-desc" }, "风扇跟随接收器采到的主板 PWM 信号；接收器要接主板风扇口的 PWM 线。读不到时用下面的兜底转速。");
    const mbRow = row("跟随主板", mbNote);

    // ---------- 高级 ----------
    const sample = slider({ label: "采样间隔", min: 1000, max: 10000, step: 100, format: (v) => `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} 秒`, onCommit: (v) => { draft.sample_interval_ms = v; refresh(); } });
    const smoothing = slider({ label: "读数平滑", min: 0, max: 10000, step: 500, format: (v) => (v ? `${(v / 1000).toFixed(1)} 秒` : "关"), onCommit: (v) => { draft.smoothing_ms = v; refresh(); } });
    const hysteresis = slider({ label: "温度回差", min: 0, max: 5, step: 0.5, format: (v) => (v ? `${v} °C` : "关"), onCommit: (v) => { draft.hysteresis_c = v; refresh(); } });
    const fallDelay = slider({ label: "降速延迟", min: 0, max: 30, step: 1, format: (v) => (v ? `${v} 秒` : "关"), onCommit: (v) => { draft.fall_delay_s = v; refresh(); } });
    const slewUp = slider({ label: "升速限幅", min: 1, max: 100, step: 1, format: (v) => `${v} %/秒`, onCommit: (v) => { draft.slew_up_percent_per_s = v; refresh(); } });
    const slewDown = slider({ label: "降速限幅", min: 1, max: 100, step: 1, format: (v) => `${v} %/秒`, onCommit: (v) => { draft.slew_down_percent_per_s = v; refresh(); } });
    const fallback = slider({ label: "兜底转速", min: 80, max: 100, step: 5, format: (v) => `${v}%`, onCommit: (v) => { draft.fallback_percent = v; refresh(); } });

    const advHead = h("button", { type: "button", class: "collapse-head", "aria-expanded": "false" }, "采样与限速", icon("chevronUp"));
    const advBody = h(
      "div",
      { class: "list adv-body" },
      row("采样间隔", "多久读一次温度；最短 1 秒，和后台的最小采样周期一致", sample.input, sample.out),
      row("读数平滑", "温度抖动时把读数压平一点", smoothing.input, smoothing.out),
      row("温度回差", "升温到这个幅度才动，减少来回跳", hysteresis.input, hysteresis.out),
      row("降速延迟", "温度掉下来后等这么久才降速", fallDelay.input, fallDelay.out),
      row("升速限幅", "每秒钟最多升多少", slewUp.input, slewUp.out),
      row("降速限幅", "每秒钟最多降多少", slewDown.input, slewDown.out),
      row("兜底转速", "采样源读不到时的保护转速，最低 80%，不能调得更低", fallback.input, fallback.out),
    );
    advBody.hidden = true;
    advHead.addEventListener("click", () => {
      advancedOpen = !advancedOpen;
      advHead.setAttribute("aria-expanded", String(advancedOpen));
      advBody.hidden = !advancedOpen;
    });

    const head = h(
      "div",
      { class: "group-head" },
      h("div", { class: "device-icon" }, icon("fan")),
      h("div", { class: "group-title" }, name, sub),
      badge,
      h("div", { class: "group-actions" }, identifyBtn, renameBtn),
    );

    const el = h(
      "section",
      { class: "card group-card" },
      head,
      h("div", { class: "group-now" }, readings, errorLine),
      modeSeg.el,
      fixedRow,
      curveBox,
      mbRow,
      advHead,
      advBody,
      h("div", { class: "group-foot" }, footHint, h("div", { class: "group-foot-actions" }, resetBtn, applyBtn)),
    );

    identifyBtn.addEventListener("click", async () => {
      if (identifying.has(address)) return;
      identifying.add(address);
      refresh();
      try {
        await identifyDevice(address, labelOf(address));
      } finally {
        // 设备自己会闪一会儿；按钮至少显示 3 秒的运行态，避免连点。
        window.setTimeout(() => {
          identifying.delete(address);
          refresh();
        }, 3000);
      }
    });
    renameBtn.addEventListener("click", async () => {
      const current = aliasOf(address);
      const ok = await renameDevice(address, current, labelOf(address));
      if (ok) refresh();
    });
    applyBtn.addEventListener("click", () => apply(cardSelf));
    resetBtn.addEventListener("click", () => reset(cardSelf));

    const cardSelf: GroupCard = {
      address,
      el,
      draft,
      title: () => labelOf(address),
      refresh,
    };

    function refresh() {
      const g = statusOf(address);
      const cap = capOf(address);
      const editable = cap !== "readonly";
      name.textContent = labelOf(address);
      sub.textContent = `${address}${g ? ` · 组内 ${g.rpm.length || g.pwm.length} 只` : " · 离线"}`;
      badge.className = cap === "control" ? "badge" : "badge badge-off";
      badge.textContent = cap === "control" ? "可调速" : cap === "readonly" ? "只读" : "离线";

      // 运行读数：目标值 + 每只风扇的转速。
      const target = g?.target_percent;
      const rpms = g?.rpm ?? [];
      const parts: string[] = [];
      if (target != null) parts.push(`目标 ${Math.round(target)}%`);
      if (rpms.length) parts.push(`实测 ${rpms.map((r) => Math.round(r)).join(" / ")} rpm`);
      if (!g) parts.push("等待这台组上线");
      readings.textContent = parts.join(" · ");
      errorLine.textContent = g?.source_error ?? "";

      modeSeg.set(draft.mode);
      fixedRow.hidden = draft.mode !== "fixed";
      curveBox.hidden = draft.mode !== "curve";
      mbRow.hidden = draft.mode !== "motherboard";
      fixed.set(draft.fixed_percent);
      sourceSeg.set(draft.source);
      sample.set(draft.sample_interval_ms);
      smoothing.set(draft.smoothing_ms);
      hysteresis.set(draft.hysteresis_c);
      fallDelay.set(draft.fall_delay_s);
      slewUp.set(draft.slew_up_percent_per_s);
      slewDown.set(draft.slew_down_percent_per_s);
      fallback.set(draft.fallback_percent);
      if (draft.mode === "curve") editor.draw();

      const dirty = isDirty(address);
      applyBtn.disabled = !dirty || !editable;
      applyBtn.textContent = cap === "offline" ? "保存（待连接）" : "应用";
      resetBtn.disabled = !dirty;
      footHint.textContent =
        cap === "readonly"
          ? "后台没有确认这台组支持单独调速，这里只读；旧版后台需要升级"
          : dirty
            ? cap === "offline"
              ? "有没保存的改动（设备不在线，只写配置）"
              : "有没应用的改动"
            : cap === "offline"
              ? "离线：改动只存配置，不会下发"
              : "已应用";
      footHint.className = dirty ? "small" : "small muted";
      identifyBtn.disabled = identifying.has(address) || cap !== "control";
      identifyBtn.title = cap === "control" ? "让这台组闪灯" : cap === "offline" ? "设备不在线，不能识别" : "后台没有确认这台组支持定位闪烁";
      identifyBtn.lastChild!.textContent = identifying.has(address) ? "识别中…" : "识别";
      renameBtn.disabled = !g;

      // 只读组：整块控件禁用（保留读数）。
      const disabled = !editable;
      el.classList.toggle("is-readonly", disabled);
      modeSeg.el.style.pointerEvents = disabled ? "none" : "";
      el.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((n) => (n.disabled = disabled));
      el.querySelectorAll<HTMLButtonElement>(".seg button").forEach((n) => (n.disabled = disabled));
      editor.el.style.pointerEvents = disabled ? "none" : "";
      editor.el.style.opacity = disabled ? "0.55" : "";
    }

    refresh();
    return cardSelf;
  }

  interface GroupCard {
    address: string;
    el: HTMLElement;
    draft: FanGroupPolicy;
    title: () => string;
    refresh: () => void;
  }

  function update() {
    if (!store.config) {
      note.textContent = store.offline ? "后台服务没有运行。" : "正在读取配置…";
      return;
    }
    syncGroups();
    for (const card of cards.values()) {
      // 配置在别处变了（撤销、导入、水冷页改全局）：没改过的卡片跟着更新。
      if (!isDirty(card.address)) {
        const next = policyOf(card.address);
        if (!same(next, card.draft)) {
          card.draft = next;
          drafts.set(card.address, next);
        }
      }
      card.refresh();
    }
  }

  update();
  return {
    root,
    update,
    async beforeLeave() {
      const dirty = [...cards.values()].filter((c) => isDirty(c.address));
      if (!dirty.length) return true;
      const applyable = dirty.filter((c) => capOf(c.address) !== "readonly");
      const applyAll = await confirmDialog({
        title: "风扇策略还有没应用的改动",
        body: `有 ${dirty.length} 组改了但还没应用${applyable.length < dirty.length ? "（其中只读组的改动会直接丢弃）" : ""}。离开前应用这些改动吗？不应用则丢弃。`,
        confirm: applyable.length ? "应用并离开" : "丢弃改动",
        cancel: "丢弃改动",
      });
      if (applyAll) {
        for (const c of applyable) apply(c);
        for (const c of dirty) if (capOf(c.address) === "readonly") reset(c);
      } else {
        for (const c of dirty) reset(c);
      }
      return true;
    },
  };
}
