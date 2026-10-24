import { api, type Config, type Status } from "./api";
import { toast } from "./ui";

/** 走势图保留的样本数（每秒一个）。 */
const HISTORY_LEN = 120;

export interface History { coolant: number[]; pump: number[]; fan: number[]; cpu: number[]; gpu: number[]; cpu_temp: number[] }

export const store = {
  status: null as Status | null,
  config: null as Config | null,
  /** 连不上后台服务时的错误信息。 */
  offline: null as string | null,
  history: { coolant: [], pump: [], fan: [], cpu: [], gpu: [], cpu_temp: [] } as History,
};

const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn());
}

function push(arr: number[], v: number | null) {
  if (v == null) return;
  arr.push(v);
  if (arr.length > HISTORY_LEN) arr.shift();
}

export type Section = "cooling" | "lighting" | "lcd" | "devices" | "ring88";
const SECTIONS: readonly Section[] = ["cooling", "lighting", "lcd", "devices", "ring88"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function copySection(dst: Config, src: Config, k: Section) {
  switch (k) {
    case "cooling":
      dst.cooling = structuredClone(src.cooling);
      break;
    case "lighting":
      dst.lighting = structuredClone(src.lighting);
      break;
    case "lcd":
      dst.lcd = structuredClone(src.lcd);
      break;
    case "devices":
      dst.devices = structuredClone(src.devices);
      break;
    case "ring88":
      dst.ring88 = structuredClone(src.ring88);
      break;
  }
}

/**
 * 把 next 里“这次动过的段”合到 latest 上，其余段保留 latest 的。
 * `only` 明确指定动过的段；不传时按 baseline 和 next 的差异判断。
 * 整份配置写回去时靠这一步避免把别的页面刚写成功的段覆盖成旧值。
 */
function mergeSections(latest: Config, next: Config, baseline: Config | null, only?: readonly Section[]): Config {
  const out = structuredClone(latest);
  if (next.schema_version != null) out.schema_version = next.schema_version;
  const sections = only?.length ? only : SECTIONS;
  for (const k of sections) {
    if (only?.length || !baseline || !same(baseline[k], next[k])) copySection(out, next, k);
  }
  return out;
}

// ---------- 写盘队列 ----------
// 后台服务一次只处理一份配置，界面又允许连续拖动。这里的队列保证 setConfig 按提交顺序到达，
// 并且每个任务执行时都基于当时最新的 store.config 合并，而不是入队时的旧快照。
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

async function readConfig() {
  store.config = await api.getConfig();
  store.offline = null;
  emit();
}

/**
 * 写完以后以服务端为准（服务会规范化数值）。
 * 界面在排队期间可能又有了新的乐观改动：只把“比这次写入更新”的段叠回来，
 * 其余段用服务端的，避免新改动被服务端返回的旧值闪掉。
 */
async function syncAfterWrite(written: Config | null) {
  const server = await api.getConfig();
  store.offline = null;
  const current = store.config;
  store.config = written && current ? mergeSections(server, current, written) : server;
  emit();
}

/** 写失败：从服务端重新读，绝不拿旧快照覆盖别人已经写成功的配置。 */
async function recoverAfterFailure(written: Config | null) {
  try {
    const server = await api.getConfig();
    store.offline = null;
    const current = store.config;
    store.config = written && current ? mergeSections(server, current, written) : server;
    emit();
  } catch {
    /* 服务端也读不到：保留界面现状，下一次轮询会再试 */
  }
}

function queueWrite(build: () => Config | null, label: string, key: string, undo?: () => void, quiet = false): Promise<boolean> {
  return serial(async () => {
    const next = build();
    if (!next) return false;
    try {
      await api.setConfig(next);
      await syncAfterWrite(next);
      if (!quiet) toast(`已应用：${label}`, { key, undo });
      return true;
    } catch (e) {
      await recoverAfterFailure(next);
      toast(`${quiet ? "保存失败" : "应用失败"}：${e}`, { error: true, key });
      return false;
    }
  });
}

/** 撤销：只把这次动过的段还原回提交前的值，别的段保持现状。 */
function restore(base: Config, sections: readonly Section[], label: string, key: string): Promise<boolean> {
  return serial(async () => {
    const latest = store.config;
    if (!latest) return false;
    const next = structuredClone(latest);
    for (const k of sections) copySection(next, base, k);
    try {
      await api.setConfig(next);
      await syncAfterWrite(next);
      toast(`已撤销：${label}`, { key });
      return true;
    } catch (e) {
      await recoverAfterFailure(next);
      toast(`撤销失败：${e}`, { error: true, key });
      return false;
    }
  });
}

async function poll() {
  try {
    const status = await api.getStatus();
    if (!store.config) store.config = await api.getConfig();
    store.status = status;
    store.offline = null;
    push(store.history.coolant, status.coolant_c);
    push(store.history.pump, status.pump_rpm);
    push(store.history.fan, status.fan_percent);
    push(store.history.cpu, status.cpu_usage);
    push(store.history.gpu, status.gpu_temp_c);
    push(store.history.cpu_temp, status.cpu_temp_c ?? null);
  } catch (e) {
    store.offline = String(e);
    store.config = null;
  }
  emit();
}

export async function startPolling() {
  // 先拿后台服务记下的最近 2 分钟，走势图一打开就是满的；拿不到（服务没运行）就从空开始记。
  try {
    const h = await api.getHistory();
    for (const k of Object.keys(store.history) as (keyof History)[]) store.history[k] = (h[k] ?? []).slice(-HISTORY_LEN);
  } catch {
    /* 忽略 */
  }
  poll();
  setInterval(poll, 1000);
}

/** 写入后台服务，并以服务规范化后的版本为准（同样排在写盘队列里）。 */
export async function saveConfig(config: Config) {
  await serial(async () => {
    await api.setConfig(config);
    await syncAfterWrite(config);
  });
}

/** 重新读整份配置：改名、导入这类不经过 setConfig 的操作之后用。 */
export function reloadConfig(): Promise<void> {
  return serial(async () => {
    try {
      await readConfig();
    } catch (e) {
      toast(`读取配置失败：${e}`, { error: true, key: "config-reload" });
    }
  });
}

/**
 * 改设备名走专用命令（backend 只改这一个字段，不写整份配置），
 * 但也排进同一队列：否则排队中的 setConfig 会用旧名字把它盖回去。
 */
export function rename(address: string, name: string): Promise<boolean> {
  return serial(async () => {
    try {
      await api.renameDevice(address, name);
      await readConfig();
      return true;
    } catch (e) {
      toast(`重命名失败：${e}`, { error: true, key: "rename" });
      return false;
    }
  });
}

/**
 * 提交一份完整配置。`sections` 是这次实际改动的段（cooling / lighting / lcd / devices / ring88）：
 * 只有这些段会被写进去，其他段一律以执行时的最新配置为准。
 * 不传时按和当前配置的差异自动判断（适合调用方刚 clone 过配置的场合）。
 */
export function commit(
  next: Config,
  label: string,
  key = label,
  sections?: readonly Section[],
  opts?: { quiet?: boolean },
): Promise<boolean> {
  const baseline = store.config ? structuredClone(store.config) : null;
  if (!baseline) return Promise.resolve(false);
  const touched = sections?.length ? [...sections] : SECTIONS.filter((k) => !same(baseline[k], next[k]));
  if (!touched.length) return Promise.resolve(false);

  // 乐观更新：只替换这次动过的段。
  store.config = mergeSections(baseline, next, null, touched);
  emit();

  return queueWrite(
    () => {
      const latest = store.config;
      return latest ? mergeSections(latest, next, null, touched) : null;
    },
    label,
    key,
    () => {
      void restore(baseline, touched, label, key);
    },
    opts?.quiet,
  );
}

/**
 * 在当前配置上改一处并提交。改动函数作用在“执行时”的最新配置上，
 * 并且只把因此变化了的段写回去，避免覆盖别的页面在这期间写成功的段。
 */
export function edit(label: string, mutate: (c: Config) => void, key?: string): Promise<boolean> {
  const baseline = store.config ? structuredClone(store.config) : null;
  if (!baseline) return Promise.resolve(false);
  const preview = structuredClone(baseline);
  mutate(preview);
  const touched = SECTIONS.filter((k) => !same(baseline[k], preview[k]));
  if (!touched.length) return Promise.resolve(false);
  const toastKey = key ?? label;

  store.config = mergeSections(baseline, preview, null, touched);
  emit();

  return queueWrite(
    () => {
      // 执行时重新在最新配置上跑一次 mutate：这一段的其它字段若在排队期间被改过，也不会被旧快照盖回去。
      const latest = store.config;
      if (!latest) return null;
      const next = structuredClone(latest);
      mutate(next);
      return next;
    },
    label,
    toastKey,
    () => {
      void restore(baseline, touched, label, toastKey);
    },
  );
}
