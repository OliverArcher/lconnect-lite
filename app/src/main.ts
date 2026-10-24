import { api, isMock } from "./api";
import { h } from "./dom";
import { icon } from "./icons";
import { startPolling, store, subscribe } from "./store";
import { cooling } from "./views/cooling";
import { devices } from "./views/devices";
import { fans } from "./views/fans";
import { lighting } from "./views/lighting";
import { overview } from "./views/overview";
import { screen } from "./views/screen";
import { settings } from "./views/settings";
import type { View } from "./views/view";

const routes: Record<string, () => View> = { overview, cooling, fans, lighting, screen, devices, settings };
const NAV: [string, [string, string][]][] = [
  ["监控", [["overview", "概览"]]],
  ["控制", [["cooling", "水冷"], ["fans", "风扇"], ["lighting", "灯效"], ["screen", "冷头屏幕"]]],
  ["系统", [["devices", "设备"], ["settings", "设置"]]],
];

const nav = document.getElementById("nav")!;
// 选中项的底色是一块独立的指示块，切换页面时滑到新的导航项上。
const navIndicator = h("span", { class: "nav-indicator", "aria-hidden": "true" });
nav.prepend(navIndicator);
for (const [group, items] of NAV) {
  nav.append(h("span", { class: "nav-label" }, group));
  for (const [route, label] of items) nav.append(h("a", { href: `#/${route}`, class: "nav-item", "data-route": route }, icon(route), label));
}
const serviceLine = h("span", {});
const serviceDot = h("span", { class: "dot" });
const wirelessKv = h("span", {});
const memoryKv = h("span", {});
nav.append(
  h(
    "div",
    { class: "status-card" },
    h("div", { class: "status-line" }, serviceDot, serviceLine),
    h("div", { class: "kv" }, h("span", {}, "无线"), wirelessKv),
    h("div", { class: "kv" }, h("span", {}, "内存"), memoryKv),
  ),
);

const viewRoot = document.getElementById("view")!;
let current: View | null = null;
let currentRoute = "";

function routeName() {
  const name = location.hash.replace(/^#\//, "");
  return name in routes ? name : "overview";
}

async function navigate() {
  const name = routeName();
  if (name === currentRoute) return;
  // 当前页有没处理的改动：先问，选“留下”就把地址改回去。
  if (current?.beforeLeave && !(await current.beforeLeave())) {
    history.replaceState(null, "", `#/${currentRoute}`);
    return;
  }
  currentRoute = name;
  current?.dispose?.();
  current = routes[name]();
  // 新页面淡入并轻微上移（只在换页时播一次，每秒的 update 不会重播）。
  current.root.classList.add("view-enter");
  viewRoot.replaceChildren(current.root);
  current.update();
  document.querySelectorAll<HTMLAnchorElement>(".nav-item").forEach((a) => {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  placeNavIndicator();
  (document.querySelector(".main") as HTMLElement).scrollTop = 0;
}

let navPlaced = false;
function placeNavIndicator() {
  const a = nav.querySelector<HTMLElement>('.nav-item[aria-current="page"]');
  if (!a || !a.offsetHeight) return;
  if (!navPlaced) navIndicator.style.transition = "none";
  navIndicator.style.transform = `translateY(${a.offsetTop}px)`;
  navIndicator.style.height = `${a.offsetHeight}px`;
  if (!navPlaced) {
    void navIndicator.offsetWidth; // 第一次直接落位，不从顶上滑下来
    navIndicator.style.transition = "";
    navPlaced = true;
    nav.classList.add("has-indicator");
  }
}
// 字体加载完行高可能变化：再校正一次位置。
document.fonts?.ready.then(() => {
  navPlaced = false;
  placeNavIndicator();
});

const alertBox = document.getElementById("alert")!;

function updateChrome() {
  const st = store.status;
  if (store.offline) {
    serviceDot.className = "dot dot-bad";
    serviceLine.textContent = "后台服务未连接";
    wirelessKv.textContent = "—";
    memoryKv.textContent = "—";
    alertBox.hidden = false;
    // 每秒都会进来；内容没变就不重建，免得按钮在点击时被替换。
    if (alertBox.dataset.offline === "1") return;
    alertBox.dataset.offline = "1";
    const start = h("button", { type: "button", class: "btn btn-sm" }, icon("power"), "启动后台服务");
    start.addEventListener("click", () => api.startDaemon().catch((e) => (msg.textContent = String(e))));
    const msg = h("span", {}, "后台服务没有运行：风扇、泵和灯光保持最后的状态，界面上的改动也不会生效。");
    alertBox.replaceChildren(msg, start);
    return;
  }
  delete alertBox.dataset.offline;
  serviceDot.className = st?.last_error ? "dot dot-warn" : "dot dot-ok";
  serviceLine.textContent = isMock ? "模拟数据（浏览器预览）" : "后台服务运行中";
  const ours = st?.wireless.filter((w) => w.owner === "ours").length ?? 0;
  wirelessKv.textContent = st?.transmitter ? `频道 ${st.transmitter[1]} · ${ours} 台设备` : "未连接";
  memoryKv.textContent = st?.memory_mb != null ? `${st.memory_mb.toFixed(1)} MB` : "—";
  alertBox.hidden = !st?.last_error;
  if (st?.last_error && alertBox.textContent !== st.last_error) alertBox.replaceChildren(h("span", {}, st.last_error));
}

subscribe(() => {
  updateChrome();
  current?.update();
});
window.addEventListener("hashchange", navigate);
navigate();
startPolling();
