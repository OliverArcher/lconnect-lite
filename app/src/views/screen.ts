import { api, isMock, type LcdMode, type Rgb, type ThemeMeta, type ThemeMode } from "../api";
import { h } from "../dom";
import { icon } from "../icons";
import { edit, store } from "../store";
import { colorPicker, row, segmented, slider, toggle } from "../ui";
import "../screen.css";
import type { View } from "./view";

const MODES: { mode: LcdMode; name: string; desc: string; icon: string }[] = [
  { mode: "dashboard", name: "主题", desc: "水温、泵速、风扇、CPU、GPU、时间", icon: "gauge" },
  { mode: "image", name: "图片", desc: "PNG、JPG、WebP，自动裁成正方形", icon: "image" },
  { mode: "gif", name: "GIF 动图", desc: "最多 300 帧，最高 30 fps", icon: "play" },
  { mode: "unmanaged", name: "不控制", desc: "保持冷头现有画面", icon: "off" },
];
const IMAGE_EXT = /\.(png|jpe?g|bmp|webp)$/i;
const GIF_EXT = /\.gif$/i;
const PREVIEW_INTERVAL = 1500;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const TIERS: [ThemeMeta["tier"], string][] = [
  ["flat", "扁平"],
  ["medium", "适中"],
  ["fancy", "华丽"],
];
const ACCENTS: Rgb[] = [[242, 163, 58], [255, 122, 47], [232, 64, 44], [255, 90, 110], [168, 107, 255], [74, 164, 255], [63, 208, 255], [91, 224, 122]];
const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
/** 缩略图渲染边长：界面上约 110 px 显示，留出高分屏余量。 */
const THUMB = 224;
/** 跟随时间时 7:00–19:00 用亮色（和后台服务一致）。 */
const isDarkNow = (mode: ThemeMode) => (mode === "auto" ? !(new Date().getHours() >= 7 && new Date().getHours() < 19) : mode === "dark");

export function screen(): View {
  const cards = MODES.map((m) => {
    const b = h("button", { type: "button", class: "mode-card", role: "radio", "aria-checked": "false" }, icon(m.icon), h("span", { style: "display: flex; flex-direction: column; gap: 2px" }, h("span", { class: "t" }, m.name), h("span", { class: "d" }, m.desc)));
    b.addEventListener("click", () => pickMode(m.mode));
    return b;
  });

  const brightness = slider({ label: "屏幕亮度", min: 0, max: 100, step: 5, format: (v) => `${v}%`, onCommit: (v) => edit("屏幕亮度", (c) => (c.lcd.brightness = v), "lcd-bright") });
  const rotation = segmented([0, 90, 180, 270].map((r) => ({ value: r, label: `${r}°` })), (r) => edit(`屏幕旋转 ${r}°`, (c) => (c.lcd.rotation = r), "lcd-rot"), { label: "旋转", small: true });
  rotation.el.style.width = "240px";
  const fps = slider({ label: "GIF 最高帧率", min: 5, max: 30, step: 1, format: (v) => `${v} fps`, onCommit: (v) => edit("GIF 最高帧率", (c) => (c.lcd.max_fps = v), "lcd-fps") });
  const clock = toggle("离线时钟", (on) => edit(on ? "打开离线时钟" : "关闭离线时钟", (c) => (c.lcd.offline_clock = on), "lcd-clock"));
  const fpsRow = row("GIF 最高帧率", "帧太密的 GIF 会合并帧，降低 USB 占用", fps.input, fps.out);
  const settingsList = h(
    "div",
    { class: "list" },
    row("亮度", null, brightness.input, brightness.out),
    row("旋转", "冷头装的方向不正时调整", rotation.el),
    fpsRow,
    row("离线时钟", "后台服务停止后，屏幕显示时钟而不是停在最后一帧", clock),
  );

  const fileText = h("span", { class: "file-name" });
  const changeBtn = h("button", { type: "button", class: "btn btn-sm" }, icon("folder"), "选择文件…");
  const dropText = h("span", {});
  const drop = h("div", { class: "drop" }, icon("upload"), h("div", { style: "flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px" }, fileText, dropText), changeBtn);
  changeBtn.addEventListener("click", () => {
    const mode = store.config?.lcd.mode;
    choose(mode === "gif" ? "gif" : "image");
  });

  // ---------- 主题 ----------
  let themes: ThemeMeta[] = [];
  const tiles = new Map<string, { b: HTMLButtonElement; img: HTMLImageElement; key: string }>();
  const themeMode = segmented<ThemeMode>(
    [
      { value: "dark", label: "暗色" },
      { value: "light", label: "亮色" },
      { value: "auto", label: "跟随时间" },
    ],
    (m) => edit(m === "dark" ? "主题用暗色" : m === "light" ? "主题用亮色" : "主题跟随时间切换明暗", (c) => (c.lcd.theme_mode = m), "lcd-theme-mode"),
    { label: "明暗", small: true },
  );
  themeMode.el.style.width = "260px";
  const modeNote = h("span", { class: "row-desc" });
  const groups = h("div", { class: "theme-groups" });
  const defaultDot = h("button", { type: "button", class: "accent-dot accent-default", "aria-label": "用主题默认色" }, "默认");
  defaultDot.addEventListener("click", () => edit("强调色恢复默认", (c) => (c.lcd.accent = null), "lcd-accent"));
  const accentDots = ACCENTS.map((c) => {
    const b = h("button", { type: "button", class: "accent-dot", style: `background: ${toHex(c)}`, "aria-label": `强调色 ${toHex(c)}` });
    b.addEventListener("click", () => edit("强调色", (cfg) => (cfg.lcd.accent = c), "lcd-accent"));
    return b;
  });
  // 拖动取色时停手一会儿就应用。
  let customTimer = 0;
  const applyCustom = (hex: string) => {
    clearTimeout(customTimer);
    edit("强调色", (cfg) => (cfg.lcd.accent = fromHex(hex)), "lcd-accent");
  };
  const customAccent = colorPicker({
    label: "自定义强调色",
    size: 26,
    onInput: (hex) => {
      clearTimeout(customTimer);
      customTimer = window.setTimeout(() => applyCustom(hex), 400);
    },
    onCommit: applyCustom,
  });
  const themeSection = h(
    "section",
    { class: "card theme-card", "aria-label": "主题" },
    h("div", { class: "card-head" }, h("h2", {}, "主题"), h("div", { style: "display: flex; align-items: center; gap: 10px" }, modeNote, themeMode.el)),
    groups,
    h("div", { class: "accent-row" }, h("span", { class: "muted small" }, "强调色"), defaultDot, ...accentDots, customAccent.el),
  );

  function buildThemes() {
    groups.replaceChildren(
      ...TIERS.map(([tier, label]) =>
        h(
          "div",
          { class: "theme-group" },
          h("span", { class: "theme-tier" }, label),
          h(
            "div",
            { class: "theme-grid", role: "radiogroup", "aria-label": `${label}主题` },
            ...themes
              .filter((t) => t.tier === tier)
              .map((t) => {
                const img = h("img", { alt: "", loading: "lazy" });
                img.hidden = true;
                const b = h(
                  "button",
                  { type: "button", class: "theme-tile", role: "radio", "aria-checked": "false", title: t.light ? t.name : `${t.name}（只有暗色）` },
                  h("span", { class: "theme-thumb" }, img, h("span", { class: "theme-thumb-name" }, t.name)),
                  h("span", { class: "theme-name" }, t.name, t.light ? null : h("span", { class: "theme-badge" }, "暗")),
                );
                b.addEventListener("click", () => edit(`屏幕主题：${t.name}`, (c) => {
                  c.lcd.theme = t.id;
                  c.lcd.mode = "dashboard";
                }, "lcd-theme"));
                tiles.set(t.id, { b, img, key: "" });
                return b;
              }),
          ),
        ),
      ),
    );
  }

  // 缩略图按顺序一张张渲染（每张几十毫秒），外观变了才重渲。
  let queue: string[] = [];
  let rendering = false;
  async function pumpQueue() {
    if (rendering) return;
    rendering = true;
    while (queue.length) {
      const id = queue.shift()!;
      const tile = tiles.get(id);
      const l = store.config?.lcd;
      const t = themes.find((x) => x.id === id);
      if (!tile || !l || !t) continue;
      const dark = !t.light || isDarkNow(l.theme_mode);
      const key = JSON.stringify([dark, l.accent]);
      if (tile.key === key) continue;
      try {
        const jpeg = await api.themePreview(id, dark, l.accent, THUMB);
        tile.key = key;
        if (jpeg) {
          tile.img.src = `data:image/jpeg;base64,${jpeg}`;
          tile.img.hidden = false;
        }
      } catch {
        /* 下次外观变化时再试 */
      }
    }
    rendering = false;
  }
  function refreshThumbs() {
    queue = themes.map((t) => t.id);
    pumpQueue();
  }
  api.themeList()
    .then((list) => {
      themes = list;
      buildThemes();
      update();
    })
    .catch(() => {});

  const img = h("img", { alt: "冷头屏幕当前画面" });
  const empty = h("span", { style: "padding: 24px" });
  const lcdScreen = h("div", { class: "lcd-screen" }, img, empty);
  const caption = h("span", { class: "small muted", style: "display: flex; align-items: center; gap: 8px" });
  const errorText = h("span", { class: "small error-text", role: "status" });

  const root = h(
    "div",
    { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "page-title" }, h("h1", {}, "冷头屏幕"), h("span", { class: "subtitle" }, "480 × 480 · 改动立即推送到屏幕；8.8 寸屏的画面由 Libre Panel 负责"))),
    h(
      "div",
      { class: "banner banner-info" },
      icon("alert"),
      h(
        "div",
        { class: "banner-text" },
        h("b", {}, "冷头画面由单独的 lcl-display-host 进程提供"),
        h(
          "span",
          {},
          "内容渲染已经不在后台服务里：需要单独启动 lcl-display-host，它通过命名管道把 JPEG 交给后台服务，再由服务独占 H2 的 USB 句柄推屏。这个界面不会自动启动它，没启动时屏幕画面不会更新。8.8 寸屏的画面仍由 Libre Panel 管理。",
        ),
      ),
    ),
    h(
      "section",
      { class: "row-grid", style: "align-items: flex-start" },
      h("div", { class: "card lcd-card" }, h("div", { class: "lcd-bezel" }, lcdScreen), caption, errorText),
      h(
        "div",
        { class: "lcd-side" },
        h("div", { style: "display: flex; flex-direction: column; gap: 10px" }, h("h2", {}, "显示内容"), h("div", { class: "mode-cards", role: "radiogroup", "aria-label": "显示内容" }, ...cards)),
        drop,
        settingsList,
      ),
    ),
    themeSection,
  );
  img.hidden = true;

  async function choose(kind: "image" | "gif") {
    try {
      const path = await api.pickMedia(kind);
      if (path) setMedia(path);
    } catch (e) {
      errorText.textContent = `选择文件失败：${e}`;
    }
  }

  function setMedia(path: string) {
    const kind: LcdMode | null = GIF_EXT.test(path) ? "gif" : IMAGE_EXT.test(path) ? "image" : null;
    if (!kind) {
      errorText.textContent = "只支持 PNG、JPG、BMP、WebP 图片和 GIF 动图";
      return;
    }
    errorText.textContent = "";
    edit(`屏幕显示 ${fileName(path)}`, (c) => {
      c.lcd.mode = kind;
      c.lcd.media_path = path;
    }, "lcd-mode");
  }

  /** 图片、GIF 要先有文件：路径不对就先弹出选择框，取消则不切换。 */
  function pickMode(mode: LcdMode) {
    const cfg = store.config;
    if (!cfg || cfg.lcd.mode === mode) return;
    if (mode === "image" || mode === "gif") {
      const ok = mode === "gif" ? GIF_EXT.test(cfg.lcd.media_path) : IMAGE_EXT.test(cfg.lcd.media_path);
      if (!ok) return void choose(mode);
    }
    const name = MODES.find((m) => m.mode === mode)!.name;
    edit(mode === "unmanaged" ? "屏幕不再控制" : `屏幕显示${name}`, (c) => (c.lcd.mode = mode), "lcd-mode");
  }

  // 把文件拖进窗口：直接换成该图片或 GIF（只在桌面版里可用）。
  let unlisten: (() => void) | null = null;
  if (!isMock) {
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === "over" || p.type === "enter") drop.classList.add("over");
          else drop.classList.remove("over");
          if (p.type === "drop" && p.paths.length) setMedia(p.paths[0]);
        }),
      )
      .then((u) => (unlisten = u))
      .catch(() => {});
  }

  // GIF 模式直接播放原文件（裁成正方形、按旋转角度转，和屏幕上一致）；读不到时退回屏幕抓帧。
  let gifPath = "";
  let gifSrc: string | null = null;
  async function loadGif(path: string) {
    if (path === gifPath) return;
    gifPath = path;
    gifSrc = null;
    try {
      const data = await api.readGif(path);
      if (gifPath === path) gifSrc = `data:image/gif;base64,${data}`;
    } catch {
      /* 用屏幕抓帧 */
    }
    lastPreview = 0;
    refreshPreview();
  }

  let lastPreview = 0;
  async function refreshPreview() {
    if (Date.now() - lastPreview < PREVIEW_INTERVAL || store.offline) return;
    lastPreview = Date.now();
    const lcd = store.config?.lcd;
    if (lcd?.mode === "gif" && lcd.media_path) loadGif(lcd.media_path);
    try {
      const s = await api.getLcdState();
      const managed = lcd?.mode !== "unmanaged";
      errorText.textContent = s.error ?? "";
      const gif = lcd?.mode === "gif" && gifSrc != null;
      img.style.transform = gif && lcd.rotation ? `rotate(${lcd.rotation}deg)` : "";
      if (gif) {
        if (img.src !== gifSrc) img.src = gifSrc!;
        img.hidden = false;
        empty.hidden = true;
        caption.replaceChildren(h("span", { class: "dot dot-ok", style: "width: 6px; height: 6px" }), `动画预览 · ${s.description}`);
      } else if (s.preview_jpeg_base64 && managed) {
        img.src = `data:image/jpeg;base64,${s.preview_jpeg_base64}`;
        img.hidden = false;
        empty.hidden = true;
        caption.replaceChildren(h("span", { class: "dot dot-ok", style: "width: 6px; height: 6px" }), `屏幕上的实际画面 · ${s.description}`);
      } else {
        img.hidden = true;
        empty.hidden = false;
        empty.textContent = managed ? "正在准备画面…" : "不控制：屏幕保持冷头自己的画面";
        caption.textContent = s.description;
      }
    } catch {
      /* 下次再试 */
    }
  }

  function update() {
    const l = store.config?.lcd;
    if (l) {
      cards.forEach((b, i) => b.setAttribute("aria-checked", String(MODES[i].mode === l.mode)));
      const media = l.mode === "image" || l.mode === "gif";
      fileText.textContent = media && l.media_path ? fileName(l.media_path) : "把图片或 GIF 拖到窗口里，直接换成该内容";
      fileText.title = l.media_path;
      dropText.textContent = media && l.media_path ? "拖入新文件即可替换" : "";
      dropText.className = "small muted";
      changeBtn.lastChild!.textContent = media && l.media_path ? "更换…" : "选择文件…";
      brightness.set(l.brightness);
      rotation.set(l.rotation);
      fps.set(l.max_fps);
      fpsRow.hidden = l.mode !== "gif";
      clock.checked = l.offline_clock;
      settingsList.style.opacity = l.mode === "unmanaged" ? "0.5" : "";
      drawThemes(l.theme, l.theme_mode, l.accent);
    }
    refreshPreview();
  }

  let appearance = "";
  function drawThemes(selected: string, mode: ThemeMode, accent: Rgb | null) {
    for (const [id, t] of tiles) t.b.setAttribute("aria-checked", String(id === selected));
    themeMode.set(mode);
    const cur = themes.find((t) => t.id === selected);
    modeNote.textContent = cur && !cur.light ? `${cur.name}只有暗色` : "";
    defaultDot.setAttribute("aria-pressed", String(accent == null));
    if (cur) defaultDot.style.setProperty("--dot", toHex(cur.accent));
    const hex = accent ? toHex(accent) : null;
    accentDots.forEach((b, i) => b.setAttribute("aria-pressed", String(hex === toHex(ACCENTS[i]))));
    customAccent.set(hex ?? (cur ? toHex(cur.accent) : "#93e4ee"), hex != null && !ACCENTS.some((c) => toHex(c) === hex));
    // 明暗或强调色变了：缩略图重渲（跟随时间时每次进来按当前小时算）。
    const key = JSON.stringify([isDarkNow(mode), accent, themes.length]);
    if (key !== appearance) {
      appearance = key;
      refreshThumbs();
    }
  }

  return { root, update, dispose: () => unlisten?.() };
}
