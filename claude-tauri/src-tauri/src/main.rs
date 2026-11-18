#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

static RUNTIME_BUSY: AtomicBool = AtomicBool::new(false);
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        RUNTIME_BUSY.store(false, Ordering::Release);
    }
}
fn take_runtime_lock() -> Result<BusyGuard, String> {
    if EXIT_REQUESTED.load(Ordering::Acquire) {
        return Err("正在退出，请等待环境停止。".into());
    }
    let guard = RUNTIME_BUSY
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map(|_| BusyGuard)
        .map_err(|_| "虚拟环境正在执行另一项操作。".to_string())?;
    if EXIT_REQUESTED.load(Ordering::Acquire) {
        return Err("正在退出，请等待环境停止。".into());
    }
    Ok(guard)
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct WorkspaceConfig {
    yaml_path: String,
    node: String,
    workspace: String,
    region: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("workspace.json"))
        .map_err(|e| e.to_string())
}

fn runtime_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(runtime::development_runtime());
    }
    app.path()
        .resource_dir()
        .map(|p| p.join("runtime"))
        .map_err(|e| e.to_string())
}

fn config_from_legacy(raw: &[u8]) -> Option<WorkspaceConfig> {
    let value: serde_json::Value = serde_json::from_slice(raw).ok()?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned()
    };
    let region = field("persona");
    Some(WorkspaceConfig {
        yaml_path: field("clashYamlPath"),
        node: field("selectedNode"),
        workspace: field("workspace"),
        region: if region == "us" {
            "us".into()
        } else {
            "tw-taipei".into()
        },
    })
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<WorkspaceConfig, String> {
    let path = config_path(&app)?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("配置文件无法读取：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let legacy = std::env::var_os("APPDATA")
                .map(std::path::PathBuf::from)
                .map(|p| p.join("claude-desktop/config.json"))
                .and_then(|p| std::fs::read(p).ok())
                .and_then(|bytes| config_from_legacy(&bytes));
            Ok(legacy.unwrap_or_else(|| WorkspaceConfig {
                region: "tw-taipei".into(),
                ..Default::default()
            }))
        }
        Err(e) => Err(format!("配置文件无法读取：{e}")),
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: WorkspaceConfig) -> Result<(), String> {
    static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = SAVE_LOCK.lock().map_err(|_| "配置保存暂时不可用。")?;
    if !["tw-taipei", "us"].contains(&config.region.as_str()) {
        return Err("请选择有效的地区。".into());
    }
    if !config.node.is_empty() {
        validate_exit_node(&config)?;
    }
    let path = config_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("无效的配置目录")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| format!("保存配置失败：{e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("保存配置失败：{e}"))
}

fn node_names(path: &Path) -> Result<Vec<String>, String> {
    let data = std::fs::read(path).map_err(|e| format!("无法读取配置文件：{e}"))?;
    if data.len() > 10 * 1024 * 1024 {
        return Err("配置文件过大。".into());
    }
    let yaml: serde_yaml::Value =
        serde_yaml::from_slice(&data).map_err(|_| "YAML 格式无效。".to_string())?;
    let nodes = yaml
        .get("proxies")
        .and_then(|p| p.as_sequence())
        .ok_or("配置文件中没有 proxies 节点列表。")?;
    let names: Vec<String> = nodes
        .iter()
        .filter_map(|n| n.get("name").and_then(|v| v.as_str()))
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .collect();
    if names.is_empty() {
        return Err("配置文件中没有可用节点。".into());
    }
    Ok(names)
}

#[tauri::command]
fn inspect_config(path: String) -> Result<Vec<String>, String> {
    node_names(Path::new(&path))
}

fn validate_exit_node(config: &WorkspaceConfig) -> Result<(), String> {
    if config.node.is_empty() {
        return Err("请在「网络设置」选择出口节点并保存。".into());
    }
    let names = node_names(Path::new(&config.yaml_path))?;
    if !names.contains(&config.node) {
        return Err("保存的出口节点已不在当前配置文件中。请在「网络设置」重新选择节点并保存。".into());
    }
    Ok(())
}

#[derive(Serialize)]
struct NodeLatency {
    name: String,
    ms: Option<u64>,
    error: Option<String>,
}

fn node_endpoint(value: &serde_yaml::Value) -> Option<(String, u16)> {
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let host = value.get("server").and_then(|v| v.as_str())?.trim();
    let port = value.get("port").and_then(|v| v.as_u64())?;
    if host.is_empty()
        || port == 0
        || port > u16::MAX as u64
        || matches!(
            kind,
            "wireguard" | "direct" | "dns" | "reject" | "reject-drop" | "compatibility"
        )
    {
        return None;
    }
    Some((host.to_string(), port as u16))
}

fn tcp_latency(host: &str, port: u16, attempts: u8) -> Option<u64> {
    use std::net::ToSocketAddrs;
    let address = (host, port)
        .to_socket_addrs()
        .ok()?
        .find(|address| address.is_ipv4() || address.is_ipv6())?;
    (0..attempts)
        .filter_map(|_| {
            let begin = std::time::Instant::now();
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(2500))
                .ok()
                .map(|_| begin.elapsed().as_millis().min(u64::MAX as u128) as u64)
        })
        .min()
}

#[tauri::command]
async fn node_latency(
    path: String,
    node: Option<String>,
) -> Result<Vec<NodeLatency>, String> {
    let wanted = node.filter(|name| !name.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| format!("无法读取配置文件：{e}"))?;
        if data.len() > 10 * 1024 * 1024 {
            return Err("配置文件过大。".into());
        }
        let yaml: serde_yaml::Value =
            serde_yaml::from_slice(&data).map_err(|_| "YAML 格式无效。".to_string())?;
        let nodes = yaml
            .get("proxies")
            .and_then(|p| p.as_sequence())
            .ok_or("配置文件中没有 proxies 节点列表。")?;
        let targets: Vec<(String, serde_yaml::Value)> = nodes
            .iter()
            .filter_map(|entry| {
                let name = entry.get("name").and_then(|v| v.as_str())?.to_string();
                wanted
                    .as_ref()
                    .map_or(true, |selected| selected == &name)
                    .then(|| (name, entry.clone()))
            })
            .collect();
        if targets.is_empty() {
            return Err("没有可测速的节点。".into());
        }
        let handles: Vec<_> = targets
            .into_iter()
            .map(|(name, entry)| {
                std::thread::spawn(move || {
                    let Some((host, port)) = node_endpoint(&entry) else {
                        return NodeLatency {
                            name,
                            ms: None,
                            error: Some("无法测速".into()),
                        };
                    };
                    match tcp_latency(&host, port, 2) {
                        Some(ms) => NodeLatency {
                            name,
                            ms: Some(ms),
                            error: None,
                        },
                        None => NodeLatency {
                            name,
                            ms: None,
                            error: Some("超时".into()),
                        },
                    }
                })
            })
            .collect();
        Ok(handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect())
    })
    .await
    .map_err(|e| format!("测速中断：{e}"))?
}

#[tauri::command]
async fn choose_config() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Clash / Mihomo 配置", &["yaml", "yml"])
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn choose_workspace() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

fn network_groups(report: &serde_json::Value) -> Vec<serde_json::Value> {
    report
        .get("groups")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|group| {
            matches!(
                group.get("id").and_then(|v| v.as_str()),
                Some("network" | "consistency")
            )
        })
        .cloned()
        .collect()
}

fn recovery_checks_pass(report: &serde_json::Value) -> bool {
    if report.get("runtimeUp").and_then(|value| value.as_i64()) != Some(1) {
        return false;
    }
    let groups = network_groups(report);
    let items: Vec<_> = groups
        .iter()
        .flat_map(|group| {
            group
                .get("items")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
        })
        .collect();
    ["网络保护", "出口地区"].iter().all(|name| {
        items.iter().any(|item| {
            item.get("label").and_then(|v| v.as_str()) == Some(*name)
                && item.get("status").and_then(|v| v.as_str()) == Some("pass")
        })
    })
}

#[tauri::command]
async fn check_network(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(windows)]
    {
        let lock = take_runtime_lock()?;
        let resources = runtime_root(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            let running = runtime::run_wsl(&["--list", "--running", "--quiet"])?;
            if !runtime::output_text(&running)
                .lines()
                .any(|s| s.trim().eq_ignore_ascii_case("claude-vm"))
            {
                return Err("虚拟环境未运行，无法检查当前连接。".into());
            }
            runtime::sync_diagnostics(&resources)?;
            let result = runtime::run_wsl(&[
                "-d",
                "claude-vm",
                "-u",
                "root",
                "--",
                "python3",
                "/opt/scripts/check-network.py",
            ])?;
            if !result.status.success() {
                return Err("网络检查未能完成，请查看运行时日志。".into());
            }
            let raw = String::from_utf8_lossy(&result.stdout).replace('\0', "");
            let start = raw.find('{').ok_or("网络检查未返回结构化结果。")?;
            let report: serde_json::Value =
                serde_json::from_str(&raw[start..]).map_err(|_| "网络检查结果无法解析。")?;
            if report.get("runtimeUp").and_then(|v| v.as_i64()) != Some(1) {
                return Err("虚拟桌面未就绪，检查结果不完整。".into());
            }
            let groups = network_groups(&report);
            if groups.is_empty() {
                return Err("没有获取到网络检查结果。".into());
            }
            Ok(groups)
        })
        .await
        .map_err(|e| format!("网络检查中断：{e}"))?
    }
    #[cfg(not(windows))]
    Err("当前仅支持 Windows。".into())
}

#[derive(Serialize)]
struct LaunchOutcome {
    ok: bool,
    needs_stop: bool,
    error: String,
}

#[tauri::command]
async fn start_runtime(app: tauri::AppHandle) -> Result<LaunchOutcome, String> {
    #[cfg(windows)]
    {
        let lock = take_runtime_lock()?;
        let config = load_config(app.clone())?;
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("runtime");
        let resources = runtime_root(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            let mut operations = runtime::WslLaunch::new(config, directory, resources);
            match runtime::launch_with_progress(&mut operations, |stage| {
                let _ = app.emit("startup-progress", stage);
            }) {
                Ok(()) => LaunchOutcome {
                    ok: true,
                    needs_stop: false,
                    error: String::new(),
                },
                Err(error) => LaunchOutcome {
                    ok: false,
                    needs_stop: operations.was_spawned(),
                    error,
                },
            }
        })
        .await
        .map_err(|e| format!("启动操作中断：{e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("当前仅支持 Windows。".into())
    }
}

#[tauri::command]
async fn guard_status() -> Result<String, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let running = runtime::run_wsl(&["--list", "--running", "--quiet"])?;
            if !running.status.success()
                || !runtime::output_text(&running)
                    .lines()
                    .any(|s| s.trim().eq_ignore_ascii_case("claude-vm"))
            {
                return Err("虚拟环境未运行。".into());
            }
            runtime::read_guard_state()
        })
        .await
        .map_err(|e| format!("守卫状态检查中断：{e}"))?
    }
    #[cfg(not(windows))]
    Err("当前仅支持 Windows。".into())
}

#[tauri::command]
async fn restore_session(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let lock = take_runtime_lock()?;
        let resources = runtime_root(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            let running = runtime::run_wsl(&["--list", "--running", "--quiet"])?;
            if !running.status.success()
                || !runtime::output_text(&running)
                    .lines()
                    .any(|line| line.trim().eq_ignore_ascii_case("claude-vm"))
            {
                return Err("虚拟环境未运行。".into());
            }
            runtime::verify_existing_desktop()?;
            runtime::ensure_clipboard_bridge()?;
            runtime::ensure_guard_running(&resources)?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
            loop {
                if runtime::read_guard_state().is_ok_and(|state| state == "guarded") {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "网络保护尚未通过检查。请检查节点后点击刷新重试；原有会话仍在运行。".into(),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            runtime::sync_diagnostics(&resources)?;
            let output = runtime::run_wsl(&[
                "-d",
                "claude-vm",
                "-u",
                "root",
                "--",
                "python3",
                "/opt/scripts/check-network.py",
            ])?;
            if !output.status.success() {
                return Err("无法检查已有会话的网络状态，请稍后重试。".into());
            }
            let raw = String::from_utf8_lossy(&output.stdout).replace('\0', "");
            let report: serde_json::Value =
                serde_json::from_str(raw.trim()).map_err(|_| "无法解析已有会话的网络检查结果。")?;
            if !recovery_checks_pass(&report) {
                return Err("已有会话的网络保护或出口地区尚未通过检查，请核对网络后重试。".into());
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("恢复会话失败：{e}"))?
    }
    #[cfg(not(windows))]
    Err("当前仅支持 Windows。".into())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn request_exit(app: tauri::AppHandle) {
    if EXIT_REQUESTED.swap(true, Ordering::AcqRel) {
        return;
    }
    show_main_window(&app);
    let _ = app.emit("exit-pending", ());
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let result = loop {
            if RUNTIME_BUSY
                .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_ok()
            {
                let _lock = BusyGuard;
                #[cfg(windows)]
                let result = runtime::shutdown(&mut runtime::WslStop);
                #[cfg(not(windows))]
                let result: Result<(), String> = Ok(());
                break result;
            }
            if std::time::Instant::now() >= deadline {
                break Err("当前操作尚未结束，请稍后重试退出。".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        };
        match result {
            Ok(()) => app.exit(0),
            Err(error) => {
                EXIT_REQUESTED.store(false, Ordering::Release);
                show_main_window(&app);
                let _ = app.emit("exit-failed", error);
            }
        }
    });
}

#[tauri::command]
fn clipboard_read_text() -> Result<Option<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|_| "无法访问剪贴板。")?;
    match clipboard.get_text() {
        Ok(text) => Ok(Some(text)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(_) => Err("无法读取剪贴板。".into()),
    }
}

#[tauri::command]
fn clipboard_write_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|_| "无法写入剪贴板。".into())
}

#[tauri::command]
async fn stop_runtime() -> Result<(), String> {
    #[cfg(windows)]
    {
        let lock = take_runtime_lock()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            runtime::shutdown(&mut runtime::WslStop)
        })
        .await
        .map_err(|e| format!("停止操作中断：{e}"))?
    }
    #[cfg(not(windows))]
    Err("当前仅支持 Windows。".into())
}

#[tauri::command]
async fn reset_system(confirmation: String) -> Result<(), String> {
    if confirmation != "RESET_CLAUDE_ENVIRONMENT" {
        return Err("重置确认无效，未执行任何操作。".into());
    }
    #[cfg(windows)]
    {
        let lock = take_runtime_lock()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            runtime::shutdown(&mut runtime::WslStop)?;
            let registered = wsl(&["--list", "--quiet"])
                .map_err(|e| format!("无法检查虚拟环境：{e}"))?;
            if !registered.status.success() {
                return Err(format!("无法检查虚拟环境：{}", runtime::output_text(&registered)));
            }
            if !runtime::output_text(&registered)
                .lines()
                .any(|line| line.trim().eq_ignore_ascii_case("claude-vm"))
            {
                return Ok(());
            }
            let output = wsl(&["--unregister", "claude-vm"])
                .map_err(|e| format!("无法删除虚拟环境：{e}"))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(format!("删除虚拟环境失败：{}", runtime::output_text(&output)))
            }
        })
        .await
        .map_err(|e| format!("系统重置中断：{e}"))?
    }
    #[cfg(not(windows))]
    Err("当前仅支持 Windows。".into())
}

#[derive(Serialize)]
struct RuntimeStatus {
    wsl_available: bool,
    distro_registered: bool,
    session_running: bool,
    desktop_available: bool,
    runtime_resources_available: bool,
}

#[cfg(windows)]
fn wsl(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    Command::new("wsl.exe")
        .args(args)
        .creation_flags(0x08000000)
        .output()
}

#[tauri::command]
async fn runtime_status(app: tauri::AppHandle) -> RuntimeStatus {
    #[cfg(windows)]
    {
        let status = wsl(&["--status"])
            .map(|o| o.status.success())
            .unwrap_or(false);
        let registered = wsl(&["--list", "--quiet"])
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout).replace('\0', "");
                text.lines()
                    .any(|line| line.trim().eq_ignore_ascii_case("claude-vm"))
            })
            .unwrap_or(false);
        let session_running = wsl(&["--list", "--running", "--quiet"])
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout).replace('\0', "");
                text.lines()
                    .any(|line| line.trim().eq_ignore_ascii_case("claude-vm"))
            })
            .unwrap_or(false);
        let desktop = std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], 6080)),
            std::time::Duration::from_millis(300),
        )
        .is_ok();
        let ready = runtime_root(&app).is_ok_and(|resources| {
            resources.join("rootfs.tar.gz").is_file()
                && resources.join("assets").is_dir()
                && runtime::script_manifest(&resources.join("scripts")).is_ok()
        });
        RuntimeStatus {
            wsl_available: status,
            distro_registered: registered,
            session_running,
            desktop_available: desktop,
            runtime_resources_available: ready,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        RuntimeStatus {
            wsl_available: false,
            distro_registered: false,
            session_running: false,
            desktop_available: false,
            runtime_resources_available: false,
        }
    }
}

#[tauri::command]
async fn install_wsl() -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            use std::os::windows::process::CommandExt;
            let script = "$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\wsl.exe') -ArgumentList '--install','--no-distribution' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($p.ExitCode -in 0,3010,1641) { exit 0 }; exit 1 } catch { exit 1 }";
            let status = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script])
                .creation_flags(0x08000000).status().map_err(|e| format!("无法启动安装：{e}"))?;
            if status.success() { Ok(()) } else { Err("安装未完成，请确认已允许管理员授权并检查系统和网络。".into()) }
        }).await.map_err(|e| format!("安装中断：{e}"))?
    }
    #[cfg(not(windows))]
    Err("当前仅支持 Windows。".into())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            let open = MenuItem::with_id(app, "open", "打开 Claude Haven", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "quit", "退出并停止环境", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &exit])?;
            let icon = app.default_window_icon().ok_or("应用图标不可用")?.clone();
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Claude Haven")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "quit" => request_exit(app.clone()),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            install_wsl,
            load_config,
            save_config,
            inspect_config,
            node_latency,
            choose_config,
            choose_workspace,
            check_network,
            start_runtime,
            restore_session,
            stop_runtime,
            reset_system,
            guard_status,
            clipboard_read_text,
            clipboard_write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude Haven");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_without_returning_node_secrets() {
        let path =
            std::env::temp_dir().join(format!("claude-vm-nodes-{}.yaml", std::process::id()));
        std::fs::write(&path, "proxies:\n  - name: node-a\n    type: socks5\n    password: private\n  - name: 节点二\n    type: http\n").unwrap();
        let names = node_names(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(names, ["node-a", "节点二"]);
    }

    #[test]
    fn rejects_configs_without_nodes() {
        let path =
            std::env::temp_dir().join(format!("claude-vm-empty-{}.yaml", std::process::id()));
        std::fs::write(&path, "proxies: []\n").unwrap();
        assert!(node_names(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn network_report_does_not_mix_unrelated_groups() {
        let report = serde_json::json!({"groups": [{"id":"region"}, {"id":"network"}, {"id":"consistency"}]});
        let groups = network_groups(&report);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["id"], "network");
        assert_eq!(groups[1]["id"], "consistency");
    }

    #[test]
    fn recovery_requires_both_current_protection_and_supported_exit() {
        let mut report = serde_json::json!({"runtimeUp": 1, "groups": [{"id":"network", "items": [
            {"label":"网络保护", "status":"pass"}, {"label":"出口地区", "status":"pass"}
        ]}]});
        assert!(recovery_checks_pass(&report));
        report["groups"][0]["items"][1]["status"] = "warn".into();
        assert!(!recovery_checks_pass(&report));
        report["groups"][0]["items"][1]["status"] = "pass".into();
        report["runtimeUp"] = 0.into();
        assert!(!recovery_checks_pass(&report));
    }

    #[test]
    fn migrates_only_workspace_configuration_from_legacy_json() {
        let data = br#"{"clashYamlPath":"C:/x.yaml","selectedNode":"node","workspace":"C:/work","persona":"us","other":"private"}"#;
        let config = config_from_legacy(data).unwrap();
        assert_eq!(config.yaml_path, "C:/x.yaml");
        assert_eq!(config.node, "node");
        assert_eq!(config.workspace, "C:/work");
        assert_eq!(config.region, "us");
        assert!(!serde_json::to_string(&config).unwrap().contains("private"));
    }
}
