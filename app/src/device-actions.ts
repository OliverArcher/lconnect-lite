import { api } from "./api";
import { rename, store } from "./store";
import { promptDialog, toast } from "./ui";

/** 设备在界面上的名字：用户起过名字用名字，否则用型号。地址永远作为副标题显示。 */
export function deviceAlias(address: string, aliases: Record<string, string> | null | undefined): string {
  return aliases?.[address]?.trim() ?? "";
}

/** 改名只写本机配置（后台服务的专用命令），不向设备发送；改完重新读配置。 */
export async function renameDevice(address: string, current: string, fallback: string): Promise<boolean> {
  const name = await promptDialog({
    title: "给这台设备起个名字",
    placeholder: fallback,
    confirm: "保存",
    value: current,
  });
  if (!name) return false;
  if (name === current) return false;
  const ok = await rename(address, name);
  if (ok) toast(`已命名为“${name}”`, { key: "rename" });
  return ok;
}

/** 让设备闪灯，用来把名字和实物对上。命令只是“定位闪灯”，界面不声称已确认到具体位置。 */
export async function identifyDevice(address: string, label: string): Promise<void> {
  try {
    await api.identify(address);
    toast(`已向 ${label} 发送识别命令，对应设备会闪一会儿`, { key: "identify" });
  } catch (e) {
    toast(`识别失败：${e}`, { error: true, key: "identify", ms: 8000 });
  }
}
