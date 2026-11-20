#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod runtime;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

static RUNTIME_BUSY: AtomicBool = AtomicBool::new(false);
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn enforce_single_instance() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let mutex_name: Vec<u16> = std::ffi::OsStr::new("Local\\ClaudeHaven.SingleInstance")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let title: Vec<u16> = std::ffi::OsStr::new("Claude Haven")
            .encode_wide()
            .chain(Some(0))
            .collect();
        // The first process may still be creating its Tauri window. Wait briefly
        // so a fast second launch can still bring that window back from the tray.
        let mut window = std::ptr::null_mut();
        for _ in 0..50 {
            window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
            if !window.is_null() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if !window.is_null() {
            unsafe {
                ShowWindow(window, SW_RESTORE);
                SetForegroundWindow(window);
            }
        }
        unsafe {
            CloseHandle(handle);
        }
        None
    } else {
        Some(handle)
    }
}

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
    timezone: String,
    language: EnvironmentLanguage,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
enum EnvironmentLanguage {
    #[default]
    #[serde(rename = "en-US")]
    English,
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
    #[serde(rename = "zh-TW")]
    TraditionalChinese,
}

fn valid_timezone_setting(value: &str) -> bool {
    value.is_empty() || value == "UTC" || (value.len() <= 128
        && value.contains('/')
        && value.split('/').all(|part| !part.is_empty()
            && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"_+-".contains(&c))))
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
    Some(WorkspaceConfig {
        yaml_path: field("clashYamlPath"),
        node: field("selectedNode"),
        workspace: field("workspace"),
        ..Default::default()
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
            Ok(legacy.unwrap_or_default())
        }
        Err(e) => Err(format!("配置文件无法读取：{e}")),
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: WorkspaceConfig) -> Result<(), String> {
    static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = SAVE_LOCK.lock().map_err(|_| "配置保存暂时不可用。")?;
    if !valid_timezone_setting(&config.timezone) {
        return Err("请选择有效的时区。".into());
    }
    if !config.node.is_empty() {
        validate_exit_node(&config)?;
    }
    let path = config_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("无效的配置目录")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| format!("保存配置失败：{e}"))?;
    replace_config_file(&temporary, &path)
}

#[cfg(windows)]
fn replace_config_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let replaced = unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        let error = std::io::Error::last_os_error();
        let _ = std::fs::remove_file(temporary);
        Err(format!("保存配置失败：{error}"))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_config_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(temporary, destination).map_err(|e| format!("保存配置失败：{e}"))
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
        return Err(
            "保存的出口节点已不在当前配置文件中。请在「网络设置」重新选择节点并保存。".into(),
        );
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
async fn node_latency(path: String, node: Option<String>) -> Result<Vec<NodeLatency>, String> {
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
    #[cfg(target_os = "macos")]
    {
        let lock = take_runtime_lock()?;
        let resources = runtime_root(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            runtime::sync_diagnostics(&resources)?;
            let output = runtime::macos::exec(&["python3", "/opt/scripts/check-network.py"])?;
            let report: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
            if report["runtimeUp"] != 1 { return Err("虚拟桌面未就绪。".into()); }
            Ok(network_groups(&report))
        }).await.map_err(|e| e.to_string())?

    }
    #[cfg(not(any(windows, target_os = "macos")))]
    Err("当前仅支持 Windows。".into())
}

#[derive(Serialize)]
struct LaunchOutcome {
    ok: bool,
    needs_stop: bool,
    error: String,
}

#[cfg(target_os = "macos")]
fn mac_vm_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map(|path| path.join("native-vm")).map_err(|e| e.to_string())
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
            let _bootstrap_lock = bootstrap::controller::lock_for_runtime(&app)?;
            let mut operations = runtime::WslLaunch::new(config, directory, resources);
            let result = runtime::launch_with_progress(&mut operations, |stage| {
                let _ = app.emit("startup-progress", stage);
            });
            let spawned = operations.was_spawned();
            if let Some(path) = wsl_ready_marker(&app) {
                if spawned {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(path, b"verified");
                } else if result.is_err() {
                    let _ = std::fs::remove_file(path);
                }
            }
            let needs_stop = result.is_err() && spawned
                && runtime::guard_session_running().unwrap_or(true);
            Ok(LaunchOutcome {
                ok: result.is_ok(),
                needs_stop,
                error: result.err().unwrap_or_default(),
            })
        })
        .await
        .map_err(|e| format!("启动操作中断：{e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        let lock = take_runtime_lock()?;
        let config = load_config(app.clone())?;
        let root = runtime_root(&app)?;
        let data = mac_vm_data(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            if !runtime::macos::registered(&data) {
                let _ = app.emit("startup-progress", "mac-first-start");
            }
            let progress_app = app.clone();
            let mut ops = runtime::MacLaunch::new(config, root, data, move |stage| {
                let _ = progress_app.emit("startup-progress", stage);
            });
            let result = runtime::launch_with_progress(&mut ops, |stage| { let _ = app.emit("startup-progress", stage); });
            Ok(LaunchOutcome { ok: result.is_ok(), needs_stop: result.is_err() && runtime::macos::running(), error: result.err().unwrap_or_default() })
        }).await.map_err(|e| e.to_string())?

    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("当前仅支持 Windows。".into())
    }
}

#[tauri::command]
async fn guard_status() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            if !runtime::guard_session_running()? {
                return Err("虚拟环境未运行。".into());
            }
            runtime::read_guard_details()
        })
        .await
        .map_err(|e| format!("守卫状态检查中断：{e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        runtime::read_guard_details()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
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
            if !runtime::guard_session_running()? {
                return Err("虚拟环境未运行。".into());
            }
            runtime::verify_existing_desktop()?;
            runtime::ensure_clipboard_bridge()?;
            runtime::ensure_guard_running(&resources)?;
            runtime::wait_for_guard()?;
            let config = load_config(app.clone())?;
            runtime::sync_workspace(Path::new(&config.workspace))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("恢复会话失败：{e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let lock = take_runtime_lock()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            runtime::verify_existing_desktop()?;
            runtime::ensure_clipboard_bridge()?;
            runtime::wait_for_guard()
        }).await.map_err(|e| e.to_string())?

    }
    #[cfg(not(any(windows, target_os = "macos")))]
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
                #[cfg(target_os = "macos")]
                let result = runtime::macos::stop();
                #[cfg(not(any(windows, target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        let lock = take_runtime_lock()?;
        tauri::async_runtime::spawn_blocking(move || { let _lock = lock; runtime::macos::stop() }).await.map_err(|e| e.to_string())?

    }
    #[cfg(not(any(windows, target_os = "macos")))]
    Err("当前仅支持 Windows。".into())
}

#[tauri::command]
async fn reset_system(_app: tauri::AppHandle, confirmation: String) -> Result<(), String> {
    if confirmation != "RESET_CLAUDE_ENVIRONMENT" {
        return Err("重置确认无效，未执行任何操作。".into());
    }
    #[cfg(windows)]
    {
        let lock = take_runtime_lock()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = lock;
            runtime::shutdown(&mut runtime::WslStop)?;
            let registered = runtime::run_wsl(&["--list", "--quiet"])
                .map_err(|e| format!("无法检查虚拟环境：{e}"))?;
            if !registered.status.success() {
                return Err(format!(
                    "无法检查虚拟环境：{}",
                    runtime::output_text(&registered)
                ));
            }
            if !runtime::output_text(&registered)
                .lines()
                .any(|line| line.trim().eq_ignore_ascii_case("claude-vm"))
            {
                return Ok(());
            }
            let output = runtime::run_wsl(&["--unregister", "claude-vm"])
                .map_err(|e| format!("无法删除虚拟环境：{e}"))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(format!(
                    "删除虚拟环境失败：{}",
                    runtime::output_text(&output)
                ))
            }
        })
        .await
        .map_err(|e| format!("系统重置中断：{e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        let lock = take_runtime_lock()?;
        let data = mac_vm_data(&_app)?;
        tauri::async_runtime::spawn_blocking(move || { let _lock = lock; runtime::macos::reset(&data) }).await.map_err(|e| e.to_string())?

    }
    #[cfg(not(any(windows, target_os = "macos")))]
    Err("当前仅支持 Windows。".into())
}

#[derive(Serialize)]
struct RuntimeStatus {
    platform: &'static str,
    wsl_available: bool,
    distro_registered: bool,
    session_running: bool,
    desktop_available: bool,
    runtime_resources_available: bool,
    host_probe: Option<bootstrap::probe::HostProbe>,
}

#[cfg(windows)]
fn wsl_ready_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("bootstrap").join("runtime-verified-v1"))
}

#[tauri::command]
async fn runtime_status(app: tauri::AppHandle) -> RuntimeStatus {
    #[cfg(windows)]
    {
        let previous_bootstrap = bootstrap::controller::snapshot(&app);
        let cached_registered = if !previous_bootstrap.reboot_required
            && wsl_ready_marker(&app).is_some_and(|p| p.is_file()) {
            runtime::run_wsl(&["--list", "--quiet"]).ok().filter(|o| o.status.success())
                .map(|o| runtime::output_text(&o).lines().any(|line| line.trim().eq_ignore_ascii_case("claude-vm")))
                .unwrap_or(false)
        } else { false };
        let host = if cached_registered { None } else { bootstrap::probe::probe_host().ok() };
        if let Some(probe) = host.as_ref() {
            let _ = bootstrap::controller::resume_after_reboot(&app, probe);
        }
        let registered = cached_registered || host
            .as_ref()
            .is_some_and(|probe| probe.distro("claude-vm").is_some());
        let status = !previous_bootstrap.reboot_required
            && (cached_registered || host.as_ref().is_some_and(|probe| probe.can_initialize()));
        let session_running = runtime::run_wsl(&["--list", "--running", "--quiet"])
            .map(|o| {
                let text = bootstrap::decode_windows_output(&o.stdout);
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
            platform: std::env::consts::OS,
            wsl_available: status,
            distro_registered: registered,
            session_running,
            desktop_available: desktop,
            runtime_resources_available: ready,
            host_probe: host,
        }
    }
    #[cfg(target_os = "macos")]
    {
        let ready = runtime_root(&app).is_ok_and(|r| runtime::macos::resources_ready(&r));
        RuntimeStatus {
            platform: std::env::consts::OS, wsl_available: runtime::macos::available(), distro_registered: mac_vm_data(&app).is_ok_and(|path| runtime::macos::registered(&path)), session_running: runtime::macos::running(), desktop_available: runtime::verify_existing_desktop().is_ok(), runtime_resources_available: ready, host_probe: None }

    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        RuntimeStatus {
            platform: std::env::consts::OS,
            wsl_available: false,
            distro_registered: false,
            session_running: false,
            desktop_available: false,
            runtime_resources_available: false,
            host_probe: None,
        }
    }
}

#[tauri::command]
async fn bootstrap_status(app: tauri::AppHandle) -> bootstrap::controller::BootstrapStatus {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || bootstrap::controller::status(&app))
            .await
            .unwrap_or_else(|error| bootstrap::controller::status_error(error.to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        bootstrap::controller::status_error("当前仅支持 Windows。".into())
    }
}

#[tauri::command]
fn bootstrap_snapshot(app: tauri::AppHandle) -> bootstrap::state::BootstrapSnapshot {
    bootstrap::controller::snapshot(&app)
}

#[tauri::command]
async fn bootstrap_start(
    app: tauri::AppHandle,
) -> Result<bootstrap::state::BootstrapSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || bootstrap::controller::start(app))
        .await
        .map_err(|error| format!("初始化任务中断：{error}"))?
}

#[tauri::command]
async fn bootstrap_retry(
    app: tauri::AppHandle,
) -> Result<bootstrap::state::BootstrapSnapshot, String> {
    bootstrap_start(app).await
}

#[tauri::command]
fn bootstrap_cancel() {
    bootstrap::controller::cancel();
}

#[tauri::command]
async fn bootstrap_select_msi(app: tauri::AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || bootstrap::controller::select_msi(&app))
        .await
        .map_err(|error| format!("选择安装包的任务已中断：{error}"))?
}

fn main() {
    #[cfg(windows)]
    let _single_instance = match enforce_single_instance() {
        Some(handle) => handle,
        None => return,
    };
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
            bootstrap_status,
            bootstrap_snapshot,
            bootstrap_start,
            bootstrap_retry,
            bootstrap_cancel,
            bootstrap_select_msi,
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
        .build(tauri::generate_context!())
        .expect("error while building Claude Haven")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
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
    fn migrates_only_workspace_configuration_from_legacy_json() {
        let data = br#"{"clashYamlPath":"C:/x.yaml","selectedNode":"node","workspace":"C:/work","persona":"us","other":"private"}"#;
        let config = config_from_legacy(data).unwrap();
        assert_eq!(config.yaml_path, "C:/x.yaml");
        assert_eq!(config.node, "node");
        assert_eq!(config.workspace, "C:/work");
        assert!(config.timezone.is_empty());
        assert!(!serde_json::to_string(&config).unwrap().contains("private"));
    }
}
