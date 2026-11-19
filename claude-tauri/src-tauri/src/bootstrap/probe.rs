use super::state::{decode_windows_output, parse_distro_list, WslDistro};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostProbe {
    pub windows_caption: Option<String>,
    pub windows_version: Option<String>,
    pub windows_build: Option<u32>,
    pub system_boot_id: Option<String>,
    pub architecture: Option<String>,
    pub hypervisor_present: Option<bool>,
    pub virtualization_firmware_enabled: Option<bool>,
    pub virtual_machine_platform: Option<String>,
    pub wsl_feature: Option<String>,
    pub free_bytes: Option<u64>,
    pub wsl_cli_available: bool,
    pub wsl_package_installed: bool,
    pub wsl_version: Option<String>,
    pub distros: Vec<WslDistro>,
    pub claude_vm_wsl_version: Option<u8>,
    pub claude_vm_probe_ok: bool,
    pub other_wsl2_running: bool,
    pub claude_vm_probe_failed: bool,
    pub wsl_list_error: Option<String>,
}

impl HostProbe {
    pub fn wsl2_usable(&self) -> bool {
        !self.claude_vm_probe_failed && (self.claude_vm_probe_ok || self.other_wsl2_running)
    }

    pub fn can_initialize(&self) -> bool {
        !self.reboot_pending()
            && self.claude_vm_wsl_version != Some(1)
            && !self.claude_vm_probe_failed
            && (self.wsl2_usable()
                || (self.wsl_cli_available
                    && self.wsl_list_error.is_none()
                    && self.virtual_machine_platform.as_deref() == Some("Enabled")
                    && (self.hypervisor_present == Some(true)
                        || self.virtualization_firmware_enabled != Some(false))))
    }

    pub fn reboot_pending(&self) -> bool {
        self.virtual_machine_platform.as_deref() == Some("EnablePending")
    }

    pub fn distro(&self, name: &str) -> Option<&WslDistro> {
        self.distros
            .iter()
            .find(|distro| distro.name.eq_ignore_ascii_case(name))
    }
}

#[derive(Deserialize)]
struct WindowsSnapshot {
    caption: Option<String>,
    version: Option<String>,
    build: Option<u32>,
    system_boot_id: Option<String>,
    architecture: Option<String>,
    hypervisor_present: Option<bool>,
    virtualization_firmware_enabled: Option<bool>,
    virtual_machine_platform: Option<String>,
    wsl_feature: Option<String>,
    free_bytes: Option<u64>,
    wsl_package_installed: Option<bool>,
    wsl_package_version: Option<String>,
}

#[cfg(windows)]
fn powershell_snapshot() -> Result<WindowsSnapshot, String> {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$osVersion = [Environment]::OSVersion.Version
$caption = try { (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).ProductName } catch { $null }
$computer = $null; $processor = $null
try { $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch { }
try { $processor = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 } catch { }
function Get-FeatureState($name) {
  try {
    $item = Get-CimInstance Win32_OptionalFeature -Filter ("Name='" + $name + "'") -ErrorAction Stop
    switch ($item.InstallState) {
      1 { 'Enabled' }
      2 { 'Disabled' }
      3 { 'Absent' }
    }
  } catch { }
}
$drive = [System.IO.DriveInfo]::new($env:SystemDrive + '\')
$wslPackage = $null; $wslMsi = $null
try { $wslPackage = Get-AppxPackage -Name MicrosoftCorporationII.WindowsSubsystemForLinux -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1 } catch { }
foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  try { $wslMsi = Get-ItemProperty $key -ErrorAction Stop | Where-Object { $_.DisplayName -eq 'Windows Subsystem for Linux' } | Select-Object -First 1; if ($wslMsi) { break } } catch { }
}
$boot = try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  if ($os.LastBootUpTime) { 'cim:' + $os.LastBootUpTime.ToUniversalTime().ToString('o') }
} catch { $null }
$data = [ordered]@{
  caption = [string]$caption
  version = [string]$osVersion.ToString()
  build = [uint32]$osVersion.Build
  system_boot_id = $boot
  architecture = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  hypervisor_present = if ($null -ne $computer -and $null -ne $computer.HypervisorPresent) { [bool]$computer.HypervisorPresent } else { $null }
  virtualization_firmware_enabled = if ($null -ne $processor.VirtualizationFirmwareEnabled) { [bool]$processor.VirtualizationFirmwareEnabled } else { $null }
  virtual_machine_platform = Get-FeatureState 'VirtualMachinePlatform'
  wsl_feature = Get-FeatureState 'Microsoft-Windows-Subsystem-Linux'
  free_bytes = if ($drive) { [uint64]$drive.AvailableFreeSpace } else { $null }
  wsl_package_installed = [bool]($wslPackage -or $wslMsi)
  wsl_package_version = if ($wslPackage) { [string]$wslPackage.Version } elseif ($wslMsi) { [string]$wslMsi.DisplayVersion } else { $null }
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$data | ConvertTo-Json -Compress
"#;
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell = std::path::PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let output = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("无法读取 Windows 环境信息：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Windows 环境探测失败（退出码 {:?}）：{}",
            output.status.code(),
            decode_windows_output(&output.stderr)
        ));
    }
    let json = decode_windows_output(&output.stdout);
    serde_json::from_str(&json).map_err(|e| format!("Windows 环境探测结果无法解析：{e}"))
}

#[cfg(not(windows))]
fn powershell_snapshot() -> Result<WindowsSnapshot, String> {
    Err("当前仅支持 Windows。".into())
}

pub fn probe_host() -> Result<HostProbe, String> {
    let windows = powershell_snapshot()?;
    let version = crate::runtime::run_wsl(&["--version"]);
    let wsl_version_text = version
        .as_ref()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            decode_windows_output(&o.stdout)
                .lines()
                .find(|line| line.to_ascii_lowercase().contains("wsl version"))
                .map(str::trim)
                .unwrap_or("")
                .to_owned()
        });
    let list = crate::runtime::run_wsl(&["--list", "--verbose"]);
    let (distros, list_error) = match list {
        Ok(output) if output.status.success() => (
            parse_distro_list(&decode_windows_output(&output.stdout)),
            None,
        ),
        Ok(output) => {
            let text =
                decode_windows_output(&output.stdout) + &decode_windows_output(&output.stderr);
            let error =
                (!text.contains("WSL_E_DEFAULT_DISTRO_NOT_FOUND")).then(|| text.trim().to_owned());
            (Vec::new(), error)
        }
        Err(error) => (Vec::new(), Some(error)),
    };

    let claude = distros
        .iter()
        .find(|distro| distro.name.eq_ignore_ascii_case("claude-vm"));
    let running = crate::runtime::run_wsl(&["--list", "--running", "--quiet"])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| decode_windows_output(&output.stdout))
        .unwrap_or_default();
    let is_running = |name: &str| {
        running
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case(name))
    };
    let claude_is_running = is_running("claude-vm");
    let claude_probe_ok = claude.is_some_and(|distro| {
        if !claude_is_running {
            return false;
        }
        distro.wsl_version == Some(2)
            && crate::runtime::run_wsl(&["-d", &distro.name, "--exec", "/bin/true"])
                .is_ok_and(|output| output.status.success())
    });
    let claude_vm_probe_failed = claude_is_running
        && claude.is_some_and(|distro| distro.wsl_version == Some(2))
        && !claude_probe_ok;
    let other_wsl2_running = distros.iter().any(|distro| {
        distro.wsl_version == Some(2)
            && !distro.name.eq_ignore_ascii_case("claude-vm")
            && is_running(&distro.name)
    });
    let status = crate::runtime::run_wsl(&["--status"]).is_ok_and(|output| output.status.success());
    let cli_available = status
        || wsl_version_text.is_some()
        || list_error.is_none()
        || distros.iter().any(|distro| distro.wsl_version.is_some())
        || windows.wsl_package_installed.unwrap_or(false);

    Ok(HostProbe {
        windows_caption: windows.caption,
        windows_version: windows.version,
        windows_build: windows.build,
        system_boot_id: windows.system_boot_id,
        architecture: windows.architecture,
        hypervisor_present: windows.hypervisor_present,
        virtualization_firmware_enabled: windows.virtualization_firmware_enabled,
        virtual_machine_platform: windows.virtual_machine_platform,
        wsl_feature: windows.wsl_feature,
        free_bytes: windows.free_bytes,
        wsl_cli_available: cli_available,
        wsl_package_installed: windows.wsl_package_installed.unwrap_or(false),
        wsl_version: wsl_version_text
            .filter(|s| !s.is_empty())
            .or(windows.wsl_package_version),
        claude_vm_wsl_version: claude.and_then(|distro| distro.wsl_version),
        claude_vm_probe_ok: claude_probe_ok,
        other_wsl2_running,
        claude_vm_probe_failed,
        distros,
        wsl_list_error: list_error,
    })
}
