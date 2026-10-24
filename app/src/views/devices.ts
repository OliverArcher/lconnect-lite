import { api, type DeviceInfo, type WirelessDevice } from "../api";
import { deviceAlias, identifyDevice, renameDevice } from "../device-actions";
import { h } from "../dom";
import { icon } from "../icons";
import { edit, store } from "../store";
import { confirmDialog, row, toast, toggle } from "../ui";
import type { View } from "./view";

const isCooler = (kind: string) => kind.includes("隐流");
/** 切换频道进行中时 busy 的取值（不是设备地址）。 */
const CHANNEL_BUSY = "channel";
const CHANNELS = Array.from({ length: 20 }, (_, i) => i * 2 + 1);

export function devices(): View {
  const subtitle = h("span", { class: "subtitle" });
  const mine = h("div", { class: "device-grid" });
  const nearby = h("div", { class: "list" });
  const lock = toggle("锁定绑定", (on) => {
    const ours = (store.status?.wireless ?? []).filter((w) => w.owner === "ours").map((w) => w.address);
    // 打开时锁定现在所有本机设备；关闭即清空列表。
    edit(on ? "锁定绑定" : "取消锁定绑定", (c) => (c.devices.locked = on ? ours : []), "lock");
  });
  // 和官方一样手动只给奇数频道（偶数留给多个发射器自动错开）；当前频道是偶数时也列出来。
  const channelSelect = h("select", { class: "select", "aria-label": "无线频道" }) as HTMLSelectElement;
  channelSelect.addEventListener("change", async () => {
    const cur = store.status?.transmitter?.[1];
    const next = Number(channelSelect.value);
    if (cur == null || next === cur) return;
    const ours = (store.status?.wireless ?? []).filter((w) => w.owner === "ours").length;
    const ok = await confirmDialog({
      title: `切换到频道 ${next}？`,
      body: `本机发射器和 ${ours} 个已绑定的设备会一起从频道 ${cur} 切到 ${next}，通常几秒完成，期间风扇保持当前转速。有设备没跟上会自动切回频道 ${cur}。`,
      confirm: "切换",
    });
    if (!ok) {
      channelSelect.value = String(cur);
      return;
    }
    run("切换频道", CHANNEL_BUSY, () => api.setChannel(next), 90);
  });
  let busy: string | null = null;
  let lastKey = "";
  let introDone = false;
  const identifying = new Set<string>();

  const root = h(
    "div",
    { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "page-title" }, h("h1", {}, "设备"), subtitle)),
    h("section", { style: "display: flex; flex-direction: column; gap: 12px" }, h("h2", {}, "本机控制的设备"), mine),
    h(
      "section",
      { style: "display: flex; flex-direction: column; gap: 12px" },
      h("div", { class: "card-head" }, h("h2", {}, "附近的无线设备"), h("span", { class: "scan" }, h("span", { class: "dot dot-warn" }), "持续扫描中")),
      nearby,
    ),
    h(
      "section",
      { style: "display: flex; flex-direction: column; gap: 12px" },
      h("h2", {}, "选项"),
      h(
        "div",
        { class: "list" },
        row("设备名字", "名字只存在这台电脑上，按设备 MAC 记住；换位置或换机箱槽位都不影响。改名不向设备发送。"),
        row("锁定绑定", "只控制现在这些设备，新绑定的不自动加入、离线的不自动清理。只在电脑这边生效，不向设备发命令", lock),
        row("无线频道", "附近有多套联力无线设备、或者和 Wi-Fi 互相干扰时换一个。本机绑定的设备会一起切过去，有设备没跟上会自动切回原频道", channelSelect),
      ),
    ),
  );

  async function run(label: string, address: string, op: () => Promise<void>, maxSecs = 15) {
    busy = address;
    lastKey = "";
    draw();
    toast(`${label}中…（最多 ${maxSecs} 秒）`, { key: "device-op", ms: maxSecs * 1000 });
    try {
      await op();
      toast(`${label}成功`, { key: "device-op" });
    } catch (e) {
      toast(`${label}失败：${e}`, { error: true, key: "device-op", ms: 8000 });
    } finally {
      busy = null;
      lastKey = "";
      draw();
    }
  }

  async function unbind(w: WirelessDevice, name: string) {
    const ok = await confirmDialog({
      title: `解绑 ${name}？`,
      body: isCooler(w.kind) ? "解绑后冷头的泵改回由 USB 控制，屏幕不受影响。需要时可以在“附近的无线设备”里重新绑定。" : "解绑后这组风扇不再听本机控制，会回到默认转速和灯效。需要时可以在“附近的无线设备”里重新绑定。",
      confirm: "解绑",
      danger: true,
    });
    if (ok) run("解绑", w.address, () => api.unbind(w.address));
  }

  function card(iconName: string, color: string, name: string, sub: string, badge: { text: string; on: boolean }, facts: [string, string][], foot?: Node) {
    const ic = icon(iconName);
    ic.style.color = color;
    return h(
      "div",
      { class: "card device" },
      h("div", { class: "device-top" }, h("div", { class: "device-icon" }, ic), h("div", { class: "device-name" }, h("span", { style: "font-weight: 600" }, name), h("span", { class: "small muted mono" }, sub)), h("span", { class: badge.on ? "badge" : "badge badge-off" }, badge.text)),
      facts.length ? h("dl", { class: "facts", style: "margin: 0" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])) : null,
      foot ?? null,
    );
  }

  function draw() {
    const st = store.status;
    const locked = store.config?.devices.locked ?? [];
    const key = JSON.stringify([st?.wireless, st?.devices, st?.transmitter, st?.mb_pwm_percent != null, st?.ring88, store.config?.ring88.enabled, locked, busy, store.offline != null, [...identifying], store.config?.devices.aliases]);
    if (key === lastKey) return; // 内容没变就不重建，免得打断点击
    lastKey = key;

    lock.checked = locked.length > 0;
    const cur = st?.transmitter?.[1];
    const options = cur != null && !CHANNELS.includes(cur) ? [cur, ...CHANNELS].sort((a, b) => a - b) : CHANNELS;
    channelSelect.replaceChildren(
      ...(cur == null ? [h("option", { value: "" }, "—")] : []),
      ...options.map((c) => h("option", { value: String(c) }, busy === CHANNEL_BUSY && c === cur ? `频道 ${c}（切换中…）` : c === 8 ? `频道 ${c}（默认）` : `频道 ${c}`)),
    );
    channelSelect.value = cur == null ? "" : String(cur);
    channelSelect.disabled = cur == null || busy != null;
    const wireless = st?.wireless ?? [];
    const usb: DeviceInfo[] = (st?.devices ?? []).filter((d) => d.connection.startsWith("USB"));
    const coolerRf = wireless.find((w) => isCooler(w.kind));
    subtitle.textContent = st?.transmitter ? `无线发射器 ${st.transmitter[0]} · 频道 ${st.transmitter[1]}` : store.offline ? "后台服务未连接" : "没有找到无线收发器";

    const cards: HTMLElement[] = [];
    for (const d of usb) {
      if (d.name.includes("隐流")) {
        const wirelessCtl = coolerRf?.owner === "ours";
        cards.push(
          card("pump", "var(--c-pump)", d.name, "泵 · 水温 · 灯框 · 屏幕", { text: "USB", on: true }, [
            ["控制方式", wirelessCtl ? "无线（屏幕仍走 USB）" : "USB 直连"],
            ["无线模块", coolerRf ? (wirelessCtl ? `已绑定本机 · rx ${coolerRf.rx}` : coolerRf.owner === "other" ? "属于其他发射器" : "未绑定") : "没有收到"],
          ], wirelessCtl && coolerRf ? footFor(coolerRf, "隐流二代 无线模块", false, locked) : undefined),
        );
      } else {
        cards.push(
          card("radio", "var(--c-cpu)", d.name, d.address, { text: "USB", on: true }, [
            ["频道", st?.transmitter ? String(st.transmitter[1]) : "—"],
            ["主板 PWM", st?.mb_pwm_percent != null ? `${Math.round(st.mb_pwm_percent)}%` : "没有信号"],
          ]),
        );
      }
    }
    for (const w of wireless.filter((x) => x.owner === "ours" && !isCooler(x.kind))) {
      const model = w.fan_count ? `UNI FAN ${w.kind} ×${w.fan_count}` : w.kind;
      const name = deviceAlias(w.address, store.config?.devices.aliases) || model;
      cards.push(card("fan", "var(--c-fan)", name, w.address, { text: w.excluded ? "不受控" : "无线", on: !w.excluded }, [["型号", model], ["接收槽位", `rx ${w.rx} · 频道 ${w.channel}`]], footFor(w, name, true, locked)));
    }
    if (store.config?.ring88) {
      const enabled = store.config.ring88.enabled;
      const displayPresent=st?.ring88?.display_present===true;
      const ringPresent=st?.ring88?.present===true;
      const ringConnected=st?.ring88?.connected===true;
      cards.push(card("ring88", "var(--c-gpu)", "Universal Screen 8.8", "8.8 屏幕与灯环 USB 独立检测 · 画面由 Libre Panel 管理", { text: displayPresent?"屏幕已识别":ringPresent?"灯环已识别":"未检测到", on: displayPresent || ringPresent }, [["屏幕USB 1CBE:A088",displayPresent?"已识别（不认领）":"未检测到"],["灯环USB 0416:8050",ringPresent?(enabled?(ringConnected?"控制中":"接管重试中") : "已识别·未接管"):(st?.ring88?.error??"未检测到")]], h("a", { class: "btn btn-sm btn-soft", href: "#/lighting" }, "灯效…")));
    }
    mine.replaceChildren(...(cards.length ? cards : [h("p", { class: "muted" }, store.offline ? "后台服务没有运行。" : "没有找到设备。") ]));
    // 第一次拿到设备数据时卡片依次浮现；之后内容变化重建卡片不再播放。
    if (!introDone && st) {
      introDone = true;
      mine.classList.add("stagger");
      setTimeout(() => mine.classList.remove("stagger"), 700);
    }

    const others = wireless.filter((w) => w.owner !== "ours");
    nearby.replaceChildren(
      ...(others.length
        ? others.map((w) => {
            const name = isCooler(w.kind) ? "隐流二代 无线模块" : w.fan_count ? `UNI FAN ${w.kind} ×${w.fan_count}` : w.kind;
            const btn = h("button", { type: "button", class: "btn btn-sm btn-soft", disabled: busy != null || w.owner === "other" }, busy === w.address ? "绑定中…" : "绑定到本机");
            btn.addEventListener("click", () => run("绑定", w.address, () => api.bind(w.address)));
            return h(
              "div",
              { class: "nearby" },
              h("div", { style: "flex: 1 1 260px; display: flex; flex-direction: column; gap: 2px; min-width: 0" }, h("span", {}, name), h("span", { class: "small muted" }, `${w.address} · ${w.owner === "other" ? `属于其他发射器 ${w.master}` : "未绑定"}`)),
              h("span", { class: "small muted", style: "flex: 0 1 auto; text-align: right" }, w.owner === "other" ? "先在另一台电脑上解绑" : isCooler(w.kind) ? "绑定后泵改由无线控制，屏幕仍走 USB" : "绑定后由本机控制转速和灯效"),
              btn,
            );
          })
        : [h("div", { class: "nearby muted small" }, store.offline ? "后台服务没有运行。" : "附近没有可以绑定的设备")]),
    );
  }

  function footFor(w: WirelessDevice, name: string, withSync: boolean, locked: string[]) {
    const unbindBtn = h("button", { type: "button", class: "btn btn-sm btn-danger", disabled: busy != null }, busy === w.address ? "处理中…" : "解绑…");
    unbindBtn.addEventListener("click", () => unbind(w, name));
    const renameBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost" }, icon("rename"), "命名…");
    renameBtn.addEventListener("click", async () => {
      const ok = await renameDevice(w.address, deviceAlias(w.address, store.config?.devices.aliases), name);
      if (ok) draw();
    });
    // 识别只给后台确认支持单独控制的 TL 风扇组（supports_control === true）；冷头无线模块没有 FanGroup，不提供入口。
    const fanGroup = store.status?.fan_groups.find((g) => g.address === w.address);
    let identifyBtn: HTMLButtonElement | null = null;
    if (fanGroup?.supports_control === true) {
      const identifiable = w.owner === "ours";
      identifyBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost" }, icon("locate"), "识别");
      identifyBtn.disabled = !identifiable || identifying.has(w.address);
      identifyBtn.title = identifiable ? "让这台组闪灯" : "只能识别本机绑定的设备";
      identifyBtn.lastChild!.textContent = identifying.has(w.address) ? "识别中…" : "识别";
      identifyBtn.addEventListener("click", async () => {
        if (!identifiable || identifying.has(w.address)) return;
        identifying.add(w.address);
        draw();
        try {
          await identifyDevice(w.address, name);
        } finally {
          window.setTimeout(() => {
            identifying.delete(w.address);
            draw();
          }, 3000);
        }
      });
    }
    const left = h("div", { style: "display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center" });
    if (withSync) {
      const sync = toggle(`${name} 主板灯光同步`, (on) => run(on ? "开启主板灯光同步" : "关闭主板灯光同步", w.address, () => api.setMbLightSync(w.address, on)));
      sync.checked = w.mb_light_sync;
      sync.disabled = busy != null;
      left.append(h("label", { class: "inline-switch small" }, sync, "主板灯光同步"));
    }
    if (locked.length) {
      const ctl = toggle(`${name} 受控`, (on) => edit(on ? `控制 ${name}` : `不再控制 ${name}`, (c) => {
        const set = new Set(c.devices.locked);
        if (on) set.add(w.address);
        else set.delete(w.address);
        c.devices.locked = [...set];
      }, "lock"));
      ctl.checked = !w.excluded;
      left.append(h("label", { class: "inline-switch small" }, ctl, "受控"));
    }
    left.append(renameBtn);
    if (identifyBtn) left.append(identifyBtn);
    return h("div", { class: "device-foot" }, left, unbindBtn);
  }

  return { root, update: draw };
}
