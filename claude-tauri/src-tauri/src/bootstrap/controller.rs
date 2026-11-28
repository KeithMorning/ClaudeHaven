use super::download::{self, WslRelease};
use super::installer::{self, InstallOutcome};
use super::probe::{self, HostProbe};
use super::state::{
    BootstrapError, BootstrapErrorCode, BootstrapPhase, BootstrapSnapshot, DownloadProgress,
};
use super::store::{self, BootstrapLock};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct BootstrapStatus {
    pub host: Option<HostProbe>,
    pub snapshot: BootstrapSnapshot,
    pub probe_error: Option<String>,
}

pub fn status_error(error: String) -> BootstrapStatus {
    BootstrapStatus {
        host: None,
        snapshot: BootstrapSnapshot::default(),
        probe_error: Some(error),
    }
}

pub fn snapshot(app: &AppHandle) -> BootstrapSnapshot {
    state_path(app)
        .and_then(|path| {
            let state = store::load(&path)?;
            if !state.phase.is_active() {
                return Ok(state);
            }
            let Ok(_lock) = BootstrapLock::acquire() else {
                return Ok(state);
            };
            let mut state = store::load(&path)?;
            if state.phase.is_active() {
                if state.task_id.is_none() {
                    emit_snapshot(app, &path, &mut state, BootstrapPhase::Idle)?;
                } else {
                    emit_error(
                        app,
                        &path,
                        &mut state,
                        BootstrapPhase::Failed,
                        BootstrapErrorCode::Internal,
                        "上次配置已中断。可以重试，系统会先重新检查 WSL。".into(),
                        true,
                        None,
                        None,
                    )?;
                }
            }
            Ok(state)
        })
        .unwrap_or_default()
}

fn confirmed_reboot(previous: Option<&str>, current: Option<&str>) -> bool {
    let (Some(before), Some(now)) = (previous, current.and_then(|id| id.strip_prefix("cim:")))
    else {
        return false;
    };
    if let Some(before) = before.strip_prefix("cim:") {
        return before != now;
    }
    // Older builds stored wall-clock time in this field. Only a later actual boot proves a restart.
    before.ends_with('Z')
        && now
            .get(..19)
            .zip(before.get(..19))
            .is_some_and(|(boot, probe)| boot > probe)
}

pub fn lock_for_runtime(app: &AppHandle) -> Result<BootstrapLock, String> {
    let lock = BootstrapLock::acquire()?;
    if store::load(&state_path(app)?)?.reboot_required {
        return Err("请先重启 Windows，再启动虚拟环境。".into());
    }
    Ok(lock)
}

#[cfg(windows)]
pub fn clear_resolved_runtime_probe(app: &AppHandle, previous: &BootstrapSnapshot) -> Result<(), String> {
    let _lock = BootstrapLock::acquire()?;
    let path = state_path(app)?;
    let mut snapshot = store::load(&path)?;
    if snapshot.has_failed_runtime_probe()
        && snapshot.task_id == previous.task_id
        && snapshot.sequence == previous.sequence
    {
        snapshot.error = None;
        emit_snapshot(app, &path, &mut snapshot, BootstrapPhase::AlreadyReady)?;
    }
    Ok(())
}

pub fn resume_after_reboot(app: &AppHandle, host: &HostProbe) -> Result<(), String> {
    let path = state_path(app)?;
    let mut snapshot = store::load(&path)?;
    if snapshot.phase != BootstrapPhase::RebootRequired
        || !confirmed_reboot(
            snapshot.system_boot_id.as_deref(),
            host.system_boot_id.as_deref(),
        )
    {
        return Ok(());
    }
    let _lock = BootstrapLock::acquire()?;
    snapshot = store::load(&path)?;
    if snapshot.phase != BootstrapPhase::RebootRequired
        || !confirmed_reboot(
            snapshot.system_boot_id.as_deref(),
            host.system_boot_id.as_deref(),
        )
    {
        return Ok(());
    }
    snapshot.reboot_required = false;
    snapshot.error = None;
    snapshot.system_boot_id = host.system_boot_id.clone();
    if host
        .virtual_machine_platform
        .as_deref()
        .is_some_and(|state| state.eq_ignore_ascii_case("EnablePending"))
    {
        snapshot.reboot_required = true;
        let message = "Windows 组件仍等待重启。完成重启后重新打开 Claude Haven。";
        set_error(
            &mut snapshot,
            BootstrapPhase::RebootRequired,
            BootstrapErrorCode::RebootRequired,
            message.into(),
            true,
            Some(3010),
            None,
        );
    } else if host.can_initialize() {
        emit_snapshot(
            app,
            &path,
            &mut snapshot,
            BootstrapPhase::InfrastructureReady,
        )?;
        return Ok(());
    } else {
        let message = "已完成重启后的检查，WSL 2 仍未就绪。点击「配置 WSL 2」继续剩余步骤。";
        set_error(
            &mut snapshot,
            BootstrapPhase::NeedInstall,
            BootstrapErrorCode::RuntimeProbeFailed,
            message.into(),
            true,
            None,
            None,
        );
    }
    let phase = snapshot.phase.clone();
    emit_snapshot(app, &path, &mut snapshot, phase)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bootstrap")
        .join("state.json"))
}

#[cfg(windows)]
fn runtime_data_free_bytes(app: &AppHandle) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let mut path = app.path().app_data_dir().ok()?;
    while !path.exists() {
        if !path.pop() {
            return None;
        }
    }
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn runtime_data_free_bytes(_app: &AppHandle) -> Option<u64> {
    None
}

fn emit_snapshot(
    app: &AppHandle,
    path: &Path,
    snapshot: &mut BootstrapSnapshot,
    phase: BootstrapPhase,
) -> Result<(), String> {
    snapshot.sequence = snapshot.sequence.saturating_add(1);
    snapshot.phase = phase;
    store::save(path, snapshot)?;
    let _ = app.emit("bootstrap-progress", snapshot.clone());
    Ok(())
}

pub fn status(app: &AppHandle) -> BootstrapStatus {
    let host = probe::probe_host();
    let path = state_path(app);
    let snapshot = path
        .as_ref()
        .map(|path| {
            store::load(path).unwrap_or_else(|error| {
                let mut state = BootstrapSnapshot::default();
                state.phase = BootstrapPhase::Failed;
                state.error = Some(BootstrapError {
                    diagnostic_id: None,
                    code: BootstrapErrorCode::Internal,
                    phase: BootstrapPhase::Failed,
                    raw_exit_code: None,
                    hresult: None,
                    retryable: true,
                    user_message: error,
                    log_path: None,
                });
                state
            })
        })
        .unwrap_or_default();
    BootstrapStatus {
        host: host.as_ref().ok().cloned(),
        snapshot,
        probe_error: host.err(),
    }
}

fn set_error(
    snapshot: &mut BootstrapSnapshot,
    phase: BootstrapPhase,
    code: BootstrapErrorCode,
    message: String,
    retryable: bool,
    raw_exit_code: Option<i32>,
    log_path: Option<PathBuf>,
) {
    snapshot.error = Some(BootstrapError {
        diagnostic_id: snapshot
            .task_id
            .as_ref()
            .map(|id| format!("{id}-{}", snapshot.sequence.saturating_add(1))),
        code,
        phase: phase.clone(),
        raw_exit_code,
        hresult: raw_exit_code
            .filter(|code| *code < 0)
            .map(|code| format!("0x{:08X}", code as u32)),
        retryable,
        user_message: message,
        log_path,
    });
    snapshot.can_cancel = false;
    snapshot.phase = phase;
}

fn emit_error(
    app: &AppHandle,
    path: &Path,
    snapshot: &mut BootstrapSnapshot,
    phase: BootstrapPhase,
    code: BootstrapErrorCode,
    message: String,
    retryable: bool,
    raw_exit_code: Option<i32>,
    log_path: Option<PathBuf>,
) -> Result<(), String> {
    set_error(
        snapshot,
        phase.clone(),
        code,
        message,
        retryable,
        raw_exit_code,
        log_path,
    );
    emit_snapshot(app, path, snapshot, phase)
}

fn update_download(
    app: &AppHandle,
    path: &Path,
    snapshot: &mut BootstrapSnapshot,
    progress: DownloadProgress,
) {
    snapshot.download = Some(progress);
    snapshot.can_cancel = true;
    snapshot.sequence = snapshot.sequence.saturating_add(1);
    if store::save(path, snapshot).is_ok() {
        let _ = app.emit("bootstrap-progress", snapshot.clone());
    }
}

fn classify_host(
    host: &HostProbe,
    release: &WslRelease,
) -> Result<(), (BootstrapErrorCode, String)> {
    if !release.architecture.eq_ignore_ascii_case("x64") || !host
        .architecture
        .as_deref()
        .is_some_and(|arch| arch.eq_ignore_ascii_case("x64") || arch.eq_ignore_ascii_case("amd64"))
    {
        return Err((
            BootstrapErrorCode::UnsupportedArchitecture,
            "当前仅支持 Windows x64。".into(),
        ));
    }
    match host.windows_build {
        Some(build) if build < release.minimum_windows_build => {
            return Err((
                BootstrapErrorCode::UnsupportedWindows,
                format!(
                    "当前 Windows build 低于支持下限 {}。",
                    release.minimum_windows_build
                ),
            ))
        }
        None => {
            return Err((
                BootstrapErrorCode::UnsupportedWindows,
                "无法读取 Windows build，暂时不能确认是否满足 WSL 2 支持要求。".into(),
            ))
        }
        _ => {}
    }
    if host.claude_vm_wsl_version == Some(1) {
        return Err((BootstrapErrorCode::RuntimeProbeFailed, "已注册的 claude-vm 使用 WSL 1。为保护其中数据，应用不会自动转换或覆盖；请先备份并通过系统设置修复。".into()));
    }
    if host.hypervisor_present != Some(true) && host.virtualization_firmware_enabled == Some(false)
    {
        return Err((
            BootstrapErrorCode::VirtualizationDisabled,
            "固件虚拟化目前不可用。请在 BIOS/UEFI 中启用 Intel VT-x 或 AMD SVM，再重试。".into(),
        ));
    }
    Ok(())
}

pub fn start(app: AppHandle) -> Result<BootstrapSnapshot, String> {
    let _lock = BootstrapLock::acquire()?;
    CANCEL.store(false, Ordering::Release);
    let path = state_path(&app)?;
    let mut snapshot = store::load(&path)?;
    if snapshot.reboot_required {
        return Ok(snapshot);
    }
    snapshot.error = None;
    snapshot.reboot_required = false;
    snapshot.can_cancel = false;
    snapshot.download = None;
    let task_id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    snapshot.task_id = Some(task_id.clone());
    snapshot.last_start_id = Some(task_id);
    let release = download::release();
    emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::Probing)?;

    let host = match probe::probe_host() {
        Ok(host) => host,
        Err(error) => {
            emit_error(
                &app,
                &path,
                &mut snapshot,
                BootstrapPhase::Failed,
                BootstrapErrorCode::Internal,
                error.clone(),
                true,
                None,
                None,
            )?;
            return Err(error);
        }
    };
    snapshot.system_boot_id = host.system_boot_id.clone();
    if let Err((code, message)) = classify_host(&host, &release) {
        emit_error(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::Blocked,
            code,
            message.clone(),
            false,
            None,
            None,
        )?;
        return Err(message);
    }
    if host.can_initialize() {
        snapshot.resource_version = Some(release.version);
        snapshot.system_boot_id = host.system_boot_id.clone();
        emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::AlreadyReady)?;
        return Ok(snapshot);
    }
    if host.reboot_pending() {
        snapshot.reboot_required = true;
        let message = "VirtualMachinePlatform 正等待重启。重启 Windows 后重新打开 Claude Haven，即可继续检查。";
        emit_error(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::RebootRequired,
            BootstrapErrorCode::RebootRequired,
            message.into(),
            true,
            Some(3010),
            None,
        )?;
        return Ok(snapshot);
    }
    if let Some(error) = host.wsl_list_error.as_deref().filter(|error| {
        let code = error.to_ascii_uppercase();
        code.contains("E_ACCESSDENIED") || code.contains("0X80070005")
    }) {
        let message =
            format!("Windows 拒绝读取 WSL 发行版状态。请检查当前账户权限或组织策略。{error}");
        emit_error(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::Blocked,
            BootstrapErrorCode::PolicyBlocked,
            message.clone(),
            true,
            None,
            None,
        )?;
        return Err(message);
    }
    if runtime_data_free_bytes(&app).is_some_and(|bytes| bytes < 3 * 1024 * 1024 * 1024) {
        let message = "运行时数据磁盘可用空间不足 3 GB，暂不开始 WSL 初始化。请释放空间后重试。";
        emit_error(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::Blocked,
            BootstrapErrorCode::DiskSpaceLow,
            message.into(),
            true,
            None,
            None,
        )?;
        return Err(message.into());
    }

    snapshot.resource_version = Some(release.version.clone());
    snapshot.system_boot_id = host.system_boot_id.clone();
    emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::NeedInstall)?;
    let mut msi = snapshot
        .cache_path
        .as_deref()
        .filter(|path| path.is_file())
        .map(Path::to_path_buf);
    if !host.wsl_cli_available {
        let cache_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("bootstrap")
            .join("cache");
        if msi.is_none() {
            snapshot.can_cancel = true;
            emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::Downloading)?;
            match download::download_msi(&cache_dir, &CANCEL, |value| {
                update_download(&app, &path, &mut snapshot, value)
            }) {
                Ok(file) => msi = Some(file),
                Err(error) => {
                    let phase = if error.code == BootstrapErrorCode::DownloadCancelled {
                        BootstrapPhase::Cancelled
                    } else {
                        BootstrapPhase::Failed
                    };
                    let code = error.code;
                    let error = error.message;
                    emit_error(
                        &app,
                        &path,
                        &mut snapshot,
                        phase,
                        code,
                        error.clone(),
                        true,
                        None,
                        None,
                    )?;
                    return Err(error);
                }
            }
        }
        snapshot.can_cancel = false;
        let package = msi.as_deref().ok_or("未能取得 WSL 官方安装包。")?;
        emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::Verifying)?;
        if let Err(error) = installer::validate_msi(package) {
            snapshot.cache_path = None;
            let code = error.code;
            let error = error.message;
            emit_error(
                &app,
                &path,
                &mut snapshot,
                BootstrapPhase::Failed,
                code,
                error.clone(),
                true,
                None,
                None,
            )?;
            return Err(error);
        }
        snapshot.cache_path = Some(package.to_path_buf());
        emit_snapshot(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::AwaitingElevation,
        )?;
        emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::InstallingMsi)?;
        let outcome = match installer::install_verified_msi(package) {
            Ok(outcome) => outcome,
            Err(error) => {
                emit_error(
                    &app,
                    &path,
                    &mut snapshot,
                    BootstrapPhase::Failed,
                    BootstrapErrorCode::InstallerFailed,
                    error.clone(),
                    true,
                    None,
                    None,
                )?;
                return Err(error);
            }
        };
        return finish_install(&app, &path, &mut snapshot, outcome);
    }

    if !matches!(
        host.virtual_machine_platform.as_deref(),
        Some("Disabled" | "Absent")
    ) {
        let message = if host.claude_vm_probe_failed {
            "claude-vm 启动探针失败，请检查发行版。现有数据已保留。"
        } else {
            host.wsl_list_error
                .as_deref()
                .unwrap_or("无法确认 WSL 2 或系统组件状态，请检查 Windows 功能后重试。")
        };
        emit_error(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::Failed,
            BootstrapErrorCode::RuntimeProbeFailed,
            message.into(),
            true,
            None,
            None,
        )?;
        return Err(message.into());
    }

    {
        emit_snapshot(
            &app,
            &path,
            &mut snapshot,
            BootstrapPhase::AwaitingElevation,
        )?;
        emit_snapshot(&app, &path, &mut snapshot, BootstrapPhase::EnablingFeatures)?;
        let outcome = match installer::enable_virtual_machine_platform() {
            Ok(outcome) => outcome,
            Err(error) => {
                emit_error(
                    &app,
                    &path,
                    &mut snapshot,
                    BootstrapPhase::Failed,
                    BootstrapErrorCode::InstallerFailed,
                    error.clone(),
                    true,
                    None,
                    None,
                )?;
                return Err(error);
            }
        };
        return finish_install(&app, &path, &mut snapshot, outcome);
    }
}

fn finish_install(
    app: &AppHandle,
    path: &Path,
    snapshot: &mut BootstrapSnapshot,
    outcome: InstallOutcome,
) -> Result<BootstrapSnapshot, String> {
    use super::state::ExitDisposition::*;
    snapshot.can_cancel = false;
    match outcome.disposition {
        Success => {
            emit_snapshot(app, path, snapshot, BootstrapPhase::Rechecking)?;
            let latest = probe::probe_host();
            if let Ok(host) = &latest {
                if host.reboot_pending() {
                    snapshot.reboot_required = true;
                    emit_error(
                        app,
                        path,
                        snapshot,
                        BootstrapPhase::RebootRequired,
                        BootstrapErrorCode::RebootRequired,
                        "系统组件需要重启 Windows。".into(),
                        true,
                        Some(3010),
                        Some(outcome.log_path),
                    )?;
                    return Ok(snapshot.clone());
                }
                if host.can_initialize() {
                    snapshot.system_boot_id = host.system_boot_id.clone();
                    emit_snapshot(app, path, snapshot, BootstrapPhase::InfrastructureReady)?;
                    return Ok(snapshot.clone());
                }
            }
            let message = latest.err().unwrap_or_else(|| {
                "安装已完成，但重新检查时仍无法确认 WSL 2 已就绪。请查看诊断信息。".into()
            });
            emit_error(
                app,
                path,
                snapshot,
                BootstrapPhase::Failed,
                BootstrapErrorCode::RuntimeProbeFailed,
                message.clone(),
                true,
                outcome.raw_exit_code,
                Some(outcome.log_path),
            )?;
            return Err(message);
        }
        RebootRequired | RebootStarted => {
            snapshot.reboot_required = true;
            let message =
                "Windows 安装了所需组件，需要重启后才能继续。重启后重新打开 Claude Haven。";
            emit_error(
                app,
                path,
                snapshot,
                BootstrapPhase::RebootRequired,
                BootstrapErrorCode::RebootRequired,
                message.into(),
                true,
                outcome.raw_exit_code,
                Some(outcome.log_path),
            )?;
            Ok(snapshot.clone())
        }
        Cancelled => {
            let message = if outcome.raw_exit_code == Some(1223) {
                "已取消管理员授权，没有更改系统组件。"
            } else {
                "WSL 安装程序已取消操作。点击重试可重新开始。"
            };
            emit_error(
                app,
                path,
                snapshot,
                BootstrapPhase::Cancelled,
                BootstrapErrorCode::UacCancelled,
                message.into(),
                true,
                outcome.raw_exit_code,
                Some(outcome.log_path),
            )?;
            Ok(snapshot.clone())
        }
        Busy => {
            let message = "Windows Installer 正在处理其他安装。等待完成后点击重试。";
            emit_error(
                app,
                path,
                snapshot,
                BootstrapPhase::Failed,
                BootstrapErrorCode::InstallerBusy,
                message.into(),
                true,
                outcome.raw_exit_code,
                Some(outcome.log_path),
            )?;
            Err(message.into())
        }
        Failed => {
            let message = format!(
                "安装失败（退出码 {:?}）。请查看安装日志后重试。",
                outcome.raw_exit_code
            );
            emit_error(
                app,
                path,
                snapshot,
                BootstrapPhase::Failed,
                BootstrapErrorCode::InstallerFailed,
                message.clone(),
                true,
                outcome.raw_exit_code,
                Some(outcome.log_path),
            )?;
            Err(message)
        }
    }
}

pub fn cancel() {
    CANCEL.store(true, Ordering::Release);
}

pub fn select_msi(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let selected = rfd::FileDialog::new()
        .add_filter(
            format!("WSL {} x64 安装包", download::release().tag),
            &["msi"],
        )
        .pick_file();
    let Some(path) = selected else {
        return Ok(None);
    };
    installer::validate_msi(&path).map_err(String::from)?;
    let _lock = BootstrapLock::acquire()?;
    let state_file = state_path(app)?;
    let mut snapshot = store::load(&state_file)?;
    snapshot.cache_path = Some(path);
    snapshot.resource_version = Some(download::release().version);
    if !snapshot.reboot_required {
        snapshot.error = None;
        emit_snapshot(app, &state_file, &mut snapshot, BootstrapPhase::NeedInstall)?;
    } else {
        store::save(&state_file, &snapshot)?;
    }
    Ok(snapshot.cache_path)
}

#[cfg(test)]
mod tests {
    use super::{classify_host, confirmed_reboot};
    use crate::bootstrap::download::release;
    use crate::bootstrap::probe::HostProbe;
    use crate::bootstrap::state::BootstrapErrorCode;

    fn host() -> HostProbe {
        HostProbe {
            windows_caption: Some("Windows".into()),
            windows_version: Some("10.0".into()),
            windows_build: Some(22631),
            system_boot_id: Some("boot".into()),
            architecture: Some("X64".into()),
            hypervisor_present: None,
            virtualization_firmware_enabled: Some(true),
            virtual_machine_platform: Some("Enabled".into()),
            wsl_feature: None,
            free_bytes: Some(4_000_000_000),
            wsl_cli_available: true,
            wsl_package_installed: true,
            wsl_version: None,
            distros: vec![],
            claude_vm_wsl_version: None,
            claude_vm_probe_ok: false,
            other_wsl2_running: false,
            claude_vm_probe_failed: false,
            wsl_list_error: None,
        }
    }

    #[test]
    fn host_gate_distinguishes_arch_build_and_virtualization() {
        let release = release();
        assert!(classify_host(&host(), &release).is_ok());
        let mut unsupported_release = release.clone();
        unsupported_release.architecture = "arm64".into();
        assert_eq!(
            classify_host(&host(), &unsupported_release).unwrap_err().0,
            BootstrapErrorCode::UnsupportedArchitecture
        );
        let mut h = host();
        h.architecture = Some("ARM64".into());
        assert_eq!(
            classify_host(&h, &release).unwrap_err().0,
            BootstrapErrorCode::UnsupportedArchitecture
        );
        let mut h = host();
        h.windows_build = Some(18362);
        assert_eq!(
            classify_host(&h, &release).unwrap_err().0,
            BootstrapErrorCode::UnsupportedWindows
        );
        let mut h = host();
        h.hypervisor_present = Some(false);
        h.virtualization_firmware_enabled = Some(false);
        assert_eq!(
            classify_host(&h, &release).unwrap_err().0,
            BootstrapErrorCode::VirtualizationDisabled
        );
    }

    #[test]
    fn reboot_requires_a_reliable_new_boot_id() {
        let before = "cim:2026-11-19T01:00:00.0000000Z";
        let after = "cim:2026-11-19T02:00:00.0000000Z";
        assert!(!confirmed_reboot(Some(before), Some(before)));
        assert!(!confirmed_reboot(Some(before), None));
        assert!(!confirmed_reboot(None, Some(after)));
        assert!(confirmed_reboot(Some(before), Some(after)));
        assert!(!confirmed_reboot(
            Some("2026-11-19T01:01:00Z"),
            Some(before)
        ));
        assert!(confirmed_reboot(Some("2026-11-19T01:01:00Z"), Some(after)));
    }

    #[test]
    fn readiness_distinguishes_installed_engine_and_failed_guest() {
        let mut probe = host();
        assert!(
            probe.can_initialize(),
            "an empty distro list is a normal first run"
        );
        probe.claude_vm_probe_failed = true;
        probe.other_wsl2_running = true;
        assert!(!probe.can_initialize());
        probe.claude_vm_probe_failed = false;
        probe.virtual_machine_platform = Some("EnablePending".into());
        assert!(!probe.can_initialize());
        assert!(!super::BootstrapSnapshot::default().phase.is_active());
    }
}
