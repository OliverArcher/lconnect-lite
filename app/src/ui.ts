import { h } from "./dom";
import { icon } from "./icons";
import { playOut } from "./motion";

/** 分段选择（单选）。`set` 只更新显示，不触发回调。 */
export function segmented<T extends string | number>(
  options: { value: T; label: string }[],
  onPick: (v: T) => void,
  opts: { label: string; small?: boolean },
) {
  const buttons = options.map((o) => {
    const b = h("button", { type: "button", role: "radio", "aria-checked": "false" }, o.label);
    b.addEventListener("click", () => onPick(o.value));
    return b;
  });
  // 选中底色是一块单独的滑块，切换时从旧位置滑到新位置。
  const thumb = h("span", { class: "seg-thumb", "aria-hidden": "true" });
  const el = h("div", { class: opts.small ? "seg seg-sm" : "seg", role: "radiogroup", "aria-label": opts.label }, thumb, ...buttons);
  /** undefined 表示还没设置过。 */
  let current: T | null | undefined = undefined;
  let placed = false;
  let last = "";

  function place(animate: boolean) {
    const b = current == null ? undefined : buttons[options.findIndex((o) => o.value === current)];
    if (!el.offsetWidth) {
      // 不可见（隐藏或还没挂到页面上）：等 ResizeObserver 通知再放，放时不带动画。
      placed = false;
      return;
    }
    if (!b) {
      thumb.style.opacity = "0";
      return;
    }
    const pos = `${b.offsetLeft},${b.offsetTop},${b.offsetWidth},${b.offsetHeight}`;
    const snap = !animate || !placed;
    if (pos === last && !snap && thumb.style.opacity === "1") return;
    if (snap) thumb.style.transition = "none";
    thumb.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.height = `${b.offsetHeight}px`;
    thumb.style.opacity = "1";
    if (snap) {
      void thumb.offsetWidth; // 先落位，再恢复过渡
      thumb.style.transition = "";
    }
    last = pos;
    placed = true;
    el.classList.add("seg-slide");
  }
  if (typeof ResizeObserver === "function") {
    // 尺寸变化（显示出来、窗口缩放、选中项变粗体）只校正位置；位置没变就不打断正在播的滑动。
    const ro = new ResizeObserver(() => {
      const b = current == null ? undefined : buttons[options.findIndex((o) => o.value === current)];
      if (placed && b && `${b.offsetLeft},${b.offsetTop},${b.offsetWidth},${b.offsetHeight}` === last) return;
      place(false);
    });
    ro.observe(el);
    buttons.forEach((b) => ro.observe(b));
  }
  return {
    el,
    /** null 表示“混合”：一个都不选中。 */
    set(v: T | null) {
      buttons.forEach((b, i) => b.setAttribute("aria-checked", String(options[i].value === v)));
      // 每秒都会调用：值没变就不动滑块（之前隐藏着没放好的，这里补放一次）。
      if (v === current) {
        if (!placed) place(false);
        return;
      }
      const first = current === undefined;
      current = v;
      place(!first);
    },
  };
}

/**
 * 自定义取色按钮：圆形色环是自己画的，系统取色框透明地盖在上面接收点击（系统控件不认圆角，直接用会圆里套方）。
 * 当前颜色是自定义色时，色环中间显示这个颜色。取色框打开期间 set() 不回写，否则周期刷新会把正在选的颜色顶掉。
 */
export function colorPicker(opts: { label: string; size: number; onInput: (hex: string) => void; onCommit?: (hex: string) => void }) {
  const input = h("input", { type: "color", "aria-label": opts.label });
  const el = h("span", { class: "color-pick", "aria-pressed": "false", title: opts.label, style: `--size: ${opts.size}px` }, h("span", { class: "color-pick-fill" }), input);
  const mark = (hex: string, active: boolean) => {
    el.style.setProperty("--custom", active ? hex : "transparent");
    el.setAttribute("aria-pressed", String(active));
  };
  input.addEventListener("input", () => {
    mark(input.value, true);
    opts.onInput(input.value);
  });
  input.addEventListener("change", () => opts.onCommit?.(input.value));
  return {
    el,
    /** `active`：当前颜色不在预设里，显示为选中的自定义色。 */
    set(hex: string, active: boolean) {
      if (document.activeElement === input) return;
      input.value = hex;
      mark(hex, active);
    },
  };
}

/** 开关（带 role=switch 的复选框）。 */
export function toggle(label: string, onChange: (on: boolean) => void) {
  const el = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": label });
  el.addEventListener("change", () => onChange(el.checked));
  return el;
}

/** 设置行：左边名称和说明，右边控件。 */
export function row(title: string | Node, desc: string | Node | null, ...control: (Node | null)[]) {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row-text" }, typeof title === "string" ? h("span", {}, title) : title, desc ? h("span", { class: "row-desc" }, desc) : null),
    h("div", { class: "row-control" }, ...control),
  );
}

/** 滑块 + 数值显示。`onInput` 拖动时调用，`onCommit` 松手时调用。 */
export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const input = h("input", { type: "range", min: opts.min, max: opts.max, step: opts.step, "aria-label": opts.label });
  const out = h("span", { class: "row-value" });
  input.addEventListener("input", () => {
    out.textContent = opts.format(Number(input.value));
    opts.onInput?.(Number(input.value));
  });
  input.addEventListener("change", () => opts.onCommit(Number(input.value)));
  return {
    input,
    out,
    set(v: number) {
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = opts.format(Number(input.value));
    },
  };
}

// ---------- 提示条 ----------

let toastRoot: HTMLElement | null = null;

/** 底部提示条。带 `undo` 时显示“撤销”按钮；同一个 `key` 的新提示替换旧的。 */
export function toast(message: string, opts: { undo?: () => void; error?: boolean; key?: string; ms?: number } = {}) {
  toastRoot ??= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  // 同 key 的旧提示（正在离场的不算）：新提示原地替换它，只做淡入，不再从下面弹一次。
  const old = opts.key ? toastRoot.querySelector<HTMLElement>(`.toast[data-key="${opts.key}"]:not(.is-leaving)`) : null;
  const el = h(
    "div",
    { class: `toast${opts.error ? " error" : ""}${old ? " is-swap" : ""}`, "data-key": opts.key ?? null },
    opts.error ? colored(icon("alert"), "var(--bad)") : colored(icon("check"), "var(--ok)"),
    h("span", {}, message),
  );
  if (opts.undo) {
    const btn = h("button", { type: "button", class: "btn btn-sm" }, "撤销");
    btn.addEventListener("click", () => {
      dismissToast(el);
      opts.undo!();
    });
    el.append(btn);
  } else {
    el.style.paddingRight = "16px";
  }
  if (old) old.replaceWith(el);
  else toastRoot.append(el);
  setTimeout(() => dismissToast(el), opts.ms ?? (opts.undo ? 6000 : 3500));
}

/** 提示条离场：淡出下沉后再移除；已经在离场或已被替换的不再处理。 */
function dismissToast(el: HTMLElement) {
  if (!el.isConnected || el.classList.contains("is-leaving")) return;
  playOut(el, "is-leaving", () => el.remove());
}

function colored(svg: SVGSVGElement, color: string) {
  svg.style.color = color;
  return svg;
}

// ---------- 对话框 ----------

/** 关闭对话框：结果立即返回，背景和对话框淡出后再移除（离场期间不接收点击）。 */
function closeBackdrop(backdrop: HTMLElement) {
  // 紧接着可能再开一个对话框：先让出标题 id。
  backdrop.querySelector("#dlg-title")?.removeAttribute("id");
  backdrop.setAttribute("aria-hidden", "true");
  playOut(backdrop, "is-leaving", () => backdrop.remove());
}

/** 输入一行文字的对话框；取消返回 null。 */
export function promptDialog(opts: { title: string; placeholder?: string; confirm: string; value?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", class: "input", style: "font-family: var(--font); font-size: 14px", placeholder: opts.placeholder ?? "", value: opts.value ?? "", maxlength: 20 });
    const cancel = h("button", { type: "button", class: "btn" }, "取消");
    const ok = h("button", { type: "button", class: "btn btn-primary" }, opts.confirm);
    const dialog = h("form", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlg-title" }, h("h3", { id: "dlg-title" }, opts.title), input, h("div", { class: "dialog-actions" }, cancel, ok));
    const backdrop = h("div", { class: "backdrop" }, dialog);
    let closed = false;
    const close = (v: string | null) => {
      if (closed) return;
      closed = true;
      closeBackdrop(backdrop);
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    cancel.addEventListener("click", () => close(null));
    // Do not rely on implicit form-submit behavior in WebView2. The Save action
    // is an explicit button, and Enter in the field calls the same handler.
    const submit = () => {
      const v = input.value.trim();
      if (v) close(v);
    };
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    dialog.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    backdrop.addEventListener("click", (e) => e.target === backdrop && close(null));
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    input.focus();
  });
}

/** 确认对话框；按 Esc 或点背景等于取消。 */
export function confirmDialog(opts: { title: string; body: string; confirm: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = h("button", { type: "button", class: "btn" }, opts.cancel ?? "取消");
    const ok = h("button", { type: "button", class: opts.danger ? "btn btn-danger-solid" : "btn btn-primary" }, opts.confirm);
    const dialog = h(
      "div",
      { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlg-title" },
      h("h3", { id: "dlg-title" }, opts.title),
      h("p", {}, opts.body),
      h("div", { class: "dialog-actions" }, cancel, ok),
    );
    const backdrop = h("div", { class: "backdrop" }, dialog);
    const prev = document.activeElement as HTMLElement | null;
    let closed = false;
    const close = (v: boolean) => {
      if (closed) return;
      closed = true;
      closeBackdrop(backdrop);
      document.removeEventListener("keydown", onKey, true);
      prev?.focus();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (e) => e.target === backdrop && close(false));
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    ok.focus();
  });
}
