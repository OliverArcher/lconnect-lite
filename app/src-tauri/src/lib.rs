//! GUI 后端：把前端的 invoke 转成发给 lcl-daemon 的命名管道请求，另外负责文件对话框和拉起后台服务。

use lcl_core::gpu::Gpu;
use lcl_core::{ipc, Config, Request, Response, Status};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 命名管道调用是阻塞的，放到后台线程，避免卡住界面。
async fn call(req: Request) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || ipc::request(&req))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

fn unexpected(resp: Response) -> String {
    match resp {
        Response::Error { message } => message,
        other => format!("后台服务回复了意外的内容：{other:?}"),
    }
}

async fn expect_ok(req: Request) -> Result<(), String> {
    match call(req).await? {
        Response::Ok => Ok(()),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
async fn get_status() -> Result<Status, String> {
    match call(Request::GetStatus).await? {
        Response::Status { mut status } => {
            fill_gpu(&mut status);
            Ok(status)
        }
        other => Err(unexpected(other)),
    }
}

/// 后台服务只在控制需要时才读 GPU（nvml.dll 加载后卸不掉，约 20 MB）。
/// 它没给读数时由界面进程自己读来显示；界面关掉后整个进程连同 NVML 一起释放。
fn fill_gpu(status: &mut Status) {
    static GPU: OnceLock<Mutex<Option<Gpu>>> = OnceLock::new();
    if status.gpu_temp_c.is_some() {
        return;
    }
    let gpu = GPU.get_or_init(|| Mutex::new(Gpu::open()));
    if let Some(sample) = gpu.lock().unwrap().as_ref().map(Gpu::sample) {
        status.gpu_temp_c = sample.temp_c;
        status.gpu_usage = sample.usage;
        status.gpu_power_w = sample.power_w;
    }
}

#[tauri::command]
async fn get_config() -> Result<Config, String> {
    match call(Request::GetConfig).await? {
        Response::Config { config } => Ok(config),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
async fn set_config(config: Config) -> Result<(), String> {
    expect_ok(Request::SetConfig { config }).await
}

#[tauri::command]
async fn get_lighting_caps() -> Result<lcl_core::ipc::LightingCaps, String> {
    match call(Request::GetLightingCaps).await? {
        Response::LightingCaps { caps } => Ok(caps),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
async fn identify_device(address:String)->Result<(),String>{ expect_ok(Request::IdentifyDevice{address}).await }
#[tauri::command]
async fn rename_device(address:String,name:String)->Result<(),String>{ expect_ok(Request::RenameDevice{address,name}).await }
#[tauri::command]
async fn get_group_lighting_caps(address:String)->Result<lcl_core::ipc::LightingCaps,String>{
    match call(Request::GetGroupLightingCaps{address}).await? {Response::LightingCaps{caps}=>Ok(caps),other=>Err(unexpected(other))}
}

#[tauri::command]
async fn get_lcd_state() -> Result<lcl_core::ipc::LcdState, String> {
    match call(Request::GetLcdState).await? {
        Response::LcdState { state } => Ok(state),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
async fn get_history() -> Result<lcl_core::ipc::History, String> {
    match call(Request::GetHistory).await? {
        Response::History { history } => Ok(history),
        other => Err(unexpected(other)),
    }
}

/// 读 GIF 原文件给冷头屏幕页播放预览（屏幕上的实际画面只是隔一会儿抓的一帧，动不起来）。
#[tauri::command]
async fn read_gif(path: String) -> Result<String, String> {
    const MAX: u64 = 40 * 1024 * 1024;
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > MAX {
        return Err("GIF 太大，不预览".into());
    }
    std::fs::read(&path).map(|b| lcl_core::base64(&b)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn bind_device(address: String) -> Result<(), String> {
    expect_ok(Request::Bind { address }).await
}

#[tauri::command]
async fn unbind_device(address: String) -> Result<(), String> {
    expect_ok(Request::Unbind { address }).await
}

#[tauri::command]
async fn set_mb_light_sync(address: String, enabled: bool) -> Result<(), String> {
    expect_ok(Request::SetMbLightSync { address, enabled }).await
}

#[tauri::command]
async fn set_channel(channel: u8) -> Result<(), String> {
    expect_ok(Request::SetChannel { channel }).await
}

/// 一段预览动画：每帧是 "rrggbb…" 的十六进制串。
#[derive(Serialize)]
struct Track {
    ms: f32,
    frames: Vec<String>,
}

#[derive(Serialize)]
struct LightingPreview {
    fan: Option<Track>,
    pump: Option<Track>,
}

/// 预览最多取这么多帧：足够看清动画，又不让每次改参数都传一大包。
const PREVIEW_FRAMES: usize = 180;

/// 用和后台服务同一个渲染器算出灯效，界面拿来逐帧播放，所见即设备上的效果。
/// 在界面进程里算，不经过后台服务，拖动参数时不会打扰设备。
#[tauri::command]
async fn preview_lighting(lighting: lcl_core::config::Lighting, fan_count: usize) -> Result<LightingPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let track = |a: lcl_effects::Animation| {
            let (ms, frames) = a.preview_hex(PREVIEW_FRAMES);
            Track { ms, frames }
        };
        let fan = (fan_count > 0)
            .then(|| lcl_effects::tl::render(&lighting.fans, fan_count.min(4)))
            .transpose()
            .map_err(|e| format!("风扇灯效：{e:#}"))?
            .map(track);
        let pump = lcl_effects::h2::render(&lighting.pump, 24).map_err(|e| format!("冷头灯效：{e:#}"))?;
        Ok(LightingPreview { fan, pump: Some(track(pump)) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct ThemeMeta {
    id: &'static str,
    name: &'static str,
    /// "flat" / "medium" / "fancy"
    tier: &'static str,
    light: bool,
    accent: [u8; 3],
}

#[tauri::command]
fn theme_list() -> Vec<ThemeMeta> {
    use lcl_media::theme::{Tier, THEMES};
    THEMES
        .iter()
        .map(|t| ThemeMeta {
            id: t.id,
            name: t.name,
            tier: match t.tier {
                Tier::Flat => "flat",
                Tier::Medium => "medium",
                Tier::Fancy => "fancy",
            },
            light: t.light,
            accent: [(t.accent >> 16) as u8, (t.accent >> 8) as u8, t.accent as u8],
        })
        .collect()
}

/// 主题缩略图，返回 JPEG 的 base64。数据用示例值，时间用界面传来的本地时间（时, 分）。
#[tauri::command]
async fn theme_preview(id: String, dark: bool, accent: Option<[u8; 3]>, size: u32, time: (u8, u8)) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use lcl_media::theme::{find, render, rgb, Style, ThemeData};
        let info = find(&id);
        let data = ThemeData { time, ..ThemeData::sample() };
        let style = Style { dark, accent: accent.map_or(rgb(info.accent), |[r, g, b]| [r, g, b, 255]) };
        let jpeg = lcl_media::thumbnail(render(info.id, &data, &style), size).map_err(|e| format!("{e:#}"))?;
        Ok(lcl_core::base64(&jpeg))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 选屏幕要显示的图片或 GIF，返回路径；取消返回 None。
#[tauri::command]
async fn pick_media(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    let (name, exts): (&str, &[&str]) = if kind == "gif" {
        ("GIF 动图", &["gif"])
    } else {
        ("图片", &["png", "jpg", "jpeg", "bmp", "webp"])
    };
    let picked = app.dialog().file().add_filter(name, exts).blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn get_autostart() -> Result<bool, String> {
    match call(Request::GetAutostart).await? {
        Response::Autostart { enabled } => Ok(enabled),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
async fn set_autostart(enabled: bool) -> Result<(), String> {
    expect_ok(Request::SetAutostart { enabled }).await
}

/// 弹出保存对话框导出当前配置；用户取消返回 None。
#[tauri::command]
async fn export_config(app: AppHandle) -> Result<Option<String>, String> {
    let text = get_config().await?.to_toml().map_err(|e| format!("{e:#}"))?;
    let picked = app
        .dialog()
        .file()
        .add_filter("LConnect Lite 配置", &["toml"])
        .set_file_name("lconnect-lite.toml")
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// 弹出打开对话框，读入配置并交给后台服务应用；用户取消返回 None。
#[tauri::command]
async fn import_config(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("LConnect Lite 配置", &["toml"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let config = Config::from_toml(&text).map_err(|e| format!("{e:#}"))?;
    expect_ok(Request::SetConfig { config }).await?;
    Ok(Some(path.display().to_string()))
}

/// 启动和界面放在同一目录的 lcl-daemon.exe。
#[tauri::command]
fn start_daemon() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let daemon = exe.with_file_name("lcl-daemon.exe");
    std::process::Command::new(&daemon)
        .arg("serve")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动 {} 失败：{e}", daemon.display()))
}

#[derive(Serialize)]
struct Paths {
    config: String,
    log: String,
}

#[tauri::command]
fn paths() -> Paths {
    Paths {
        config: Config::path().display().to_string(),
        log: lcl_core::config::log_path().display().to_string(),
    }
}

/// 在资源管理器里选中配置文件或日志（`which` = "config" / "log"）；文件还不存在时打开所在文件夹。
#[tauri::command]
fn reveal_path(which: String) -> Result<(), String> {
    let path = match which.as_str() {
        "config" => Config::path(),
        "log" => lcl_core::config::log_path(),
        _ => return Err(format!("未知路径：{which}")),
    };
    let mut cmd = std::process::Command::new("explorer.exe");
    if path.exists() {
        cmd.arg(format!("/select,{}", path.display()));
    } else if let Some(dir) = path.parent() {
        cmd.arg(dir);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Tauri 只给窗口设了小图标（标题栏用），没有大图标时任务栏改用系统图标缓存里的 exe 图标，
/// 换过图标后那份缓存可能还是旧的，重启也不刷新。这里按窗口所在显示器的 DPI 从 exe 里取一张大图标设上。
fn set_taskbar_icon(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PrivateExtractIconsW, SendMessageW, HICON, ICON_BIG, SM_CXICON, WM_SETICON};
    let Ok(hwnd) = window.hwnd() else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    let path: Vec<u16> = exe.as_os_str().to_string_lossy().encode_utf16().chain([0]).collect();
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    // SAFETY: hwnd 是本进程刚创建的窗口；路径以 0 结尾；只取一个图标句柄，交给窗口持有。
    unsafe {
        let size = GetSystemMetricsForDpi(SM_CXICON, GetDpiForWindow(hwnd)).max(32);
        let mut icon: HICON = std::ptr::null_mut();
        if PrivateExtractIconsW(path.as_ptr(), 0, size, size, &mut icon, std::ptr::null_mut(), 1, 0) == 1 && !icon.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
        }
    }
}

// generate_context! 在编译时把图标打进程序当窗口 / 任务栏图标，但 rustc 不知道它读了这些文件：
// 只换图标时这个 crate 不会重编，任务栏还是旧图标。include_bytes 让图标变化触发重编。
const _ICON_DEPS: [&[u8]; 2] = [include_bytes!("../icons/icon.ico"), include_bytes!("../icons/icon.png")];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Experimental build: opening the window must not silently seize USB devices.
    // Users explicitly start the daemon from the offline banner after stopping
    // other controllers. An already-running daemon is connected normally.
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                set_taskbar_icon(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            set_config,
            get_lighting_caps,
            get_group_lighting_caps,
            identify_device,
            rename_device,
            get_lcd_state,
            get_history,
            read_gif,
            preview_lighting,
            theme_list,
            theme_preview,
            pick_media,
            bind_device,
            unbind_device,
            set_mb_light_sync,
            set_channel,
            get_autostart,
            set_autostart,
            export_config,
            import_config,
            start_daemon,
            paths,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("启动 LConnect Lite 界面失败");
}
