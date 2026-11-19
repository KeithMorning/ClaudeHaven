use super::download::{release, verify_size_hash, TransferError};
use super::state::BootstrapErrorCode;
use super::state::{classify_exit, CommandKind, ExitDisposition};
use crate::bootstrap::decode_windows_output;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
pub struct InstallOutcome {
    pub disposition: ExitDisposition,
    pub raw_exit_code: Option<i32>,
    pub log_path: PathBuf,
}

#[derive(Deserialize)]
struct SignatureResult {
    status: String,
    subject: String,
}

pub fn validate_msi(path: &Path) -> Result<(), TransferError> {
    let invalid = |message| TransferError::new(BootstrapErrorCode::SignatureInvalid, message);
    if !path.is_absolute() {
        return Err(invalid(
            "请选择本机磁盘上的绝对路径；暂不支持网络路径。".into(),
        ));
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        {
            return Err(invalid(
                "请选择本机磁盘上的 MSI；不支持 UNC 或网络路径。".into(),
            ));
        }
    }
    let asset = release();
    verify_size_hash(path, &asset)?;
    let signature = authenticode(path).map_err(invalid)?;
    if !signature.status.eq_ignore_ascii_case("valid") {
        return Err(invalid(format!(
            "WSL 安装包的 Authenticode 状态不是 Valid（{}），已阻止安装。",
            signature.status
        )));
    }
    if !signature
        .subject
        .to_ascii_lowercase()
        .contains("o=microsoft corporation")
    {
        return Err(invalid(
            "WSL 安装包签名者不是 Microsoft Corporation，已阻止安装。".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn authenticode(path: &Path) -> Result<SignatureResult, String> {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:CLAUDE_HAVEN_MSI_PATH
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[ordered]@{ status = [string]$signature.Status; subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress
"#;
    let output = Command::new(powershell_path())
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("CLAUDE_HAVEN_MSI_PATH", path)
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("无法验证 WSL 安装包签名：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法验证 WSL 安装包签名：{}",
            decode_windows_output(&output.stderr)
        ));
    }
    serde_json::from_str(&decode_windows_output(&output.stdout))
        .map_err(|e| format!("Authenticode 返回结果无法解析：{e}"))
}

#[cfg(not(windows))]
fn authenticode(_path: &Path) -> Result<SignatureResult, String> {
    Err("当前仅支持 Windows。".into())
}

pub fn install_verified_msi(path: &Path) -> Result<InstallOutcome, String> {
    validate_msi(path)?;
    let asset = release();
    let source = path
        .canonicalize()
        .map_err(|e| format!("无法解析 MSI 路径：{e}"))?;
    let source = source.to_str().ok_or("无法读取 MSI 路径。")?;
    let source = source.strip_prefix(r"\\?\").unwrap_or(source);
    #[cfg(windows)]
    if !matches!(Path::new(source).components().next(),
        Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
    {
        return Err("MSI 的实际路径必须位于本机磁盘。".into());
    }
    let payload = serde_json::json!({
        "source": source,
        "sha256": asset.sha256,
        "size_bytes": asset.size_bytes,
        "publisher": asset.publisher,
    });
    let payload_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        serde_json::to_vec(&payload).map_err(|e| e.to_string())?,
    );
    run_elevated_script(&elevated_installer_script(&payload_b64), CommandKind::Msi)
}

pub fn enable_virtual_machine_platform() -> Result<InstallOutcome, String> {
    run_elevated_script("exit (Enable-Platform)", CommandKind::Dism)
}

const PROTECTED_STAGING: &str = r#"
$ErrorActionPreference = 'Stop'
$base = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if (-not $base) { throw 'ProgramData is unavailable.' }
$parent = Get-Item -LiteralPath $base -Force
if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe ProgramData directory.' }
$root = Join-Path $base '__TASK_DIRECTORY__'
if (Test-Path -LiteralPath $root) { throw 'Installation staging directory already exists.' }
$admin = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;AU)')
$directory = [IO.DirectoryInfo]::new($root)
$directory.Create($security)
if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe staging directory.' }
$actual = $directory.GetAccessControl()
$sections = [Security.AccessControl.AccessControlSections]::Access
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]) -ne $admin -or
    $actual.GetSecurityDescriptorSddlForm($sections) -ne $security.GetSecurityDescriptorSddlForm($sections)) {
  throw 'The installation staging directory is not protected.'
}

function Enable-Platform {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
  if ($feature.State.ToString() -eq 'EnablePending') { return 3010 }
  if ($feature.State.ToString() -eq 'Enabled') { return 0 }
  $dism = Join-Path $env:SystemRoot 'System32\dism.exe'
  $log = Join-Path $root 'wsl-dism.log'
  $args = '/Online /Enable-Feature /FeatureName:VirtualMachinePlatform /All /NoRestart /LogPath:"' + $log + '"'
  return (Start-Process -FilePath $dism -ArgumentList $args -Wait -PassThru -WindowStyle Hidden).ExitCode
}
"#;

fn run_elevated_script(script: &str, kind: CommandKind) -> Result<InstallOutcome, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let directory = format!("ClaudeHaven-WSL-{}-{stamp}", std::process::id());
    let setup = PROTECTED_STAGING.replace("__TASK_DIRECTORY__", &directory);
    let script = with_installer_mutex(&format!("{setup}\n{script}"));
    let log_path =
        PathBuf::from(std::env::var_os("ProgramData").unwrap_or_else(|| r"C:\ProgramData".into()))
            .join(directory);
    let child_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let outer = elevated_launcher_script(&child_b64);
    let outer_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        outer
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let output = hidden_powershell()
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &outer_b64,
        ])
        .output()
        .map_err(|e| format!("无法启动受限安装助手：{e}"))?;
    let code = output.status.code().ok_or_else(|| {
        format!(
            "安装助手异常退出：{}",
            decode_windows_output(&output.stderr)
        )
    })?;
    let stderr = decode_windows_output(&output.stderr);
    if code == 1 && !stderr.trim().is_empty() {
        return Err(format!("无法启动受限安装助手：{}", stderr.trim()));
    }
    Ok(InstallOutcome {
        disposition: if code == 1618 {
            ExitDisposition::Busy
        } else {
            classify_exit(kind, code)
        },
        raw_exit_code: Some(code),
        log_path,
    })
}

fn with_installer_mutex(script: &str) -> String {
    format!(
        "$mutex=[System.Threading.Mutex]::new($false,'Local\\ClaudeHavenBootstrapInstaller'); $owned=$false; try {{ $owned=$mutex.WaitOne(0); if (-not $owned) {{ exit 1618 }}; {script} }} finally {{ if ($owned) {{ $mutex.ReleaseMutex() | Out-Null }}; $mutex.Dispose() }}"
    )
}

#[cfg(windows)]
fn hidden_powershell() -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(powershell_path());
    command.creation_flags(0x08000000);
    command
}

#[cfg(not(windows))]
fn hidden_powershell() -> Command {
    Command::new(powershell_path())
}

fn powershell_path() -> PathBuf {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

fn elevated_launcher_script(child_b64: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop'; $exe=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; try {{ $p=Start-Process -FilePath $exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','{child_b64}'); exit $p.ExitCode }} catch {{ if (($_.Exception.HResult -band 0xffff) -eq 1223) {{ exit 1223 }}; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}"
    )
}

fn elevated_installer_script(payload_b64: &str) -> String {
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload_b64}'))
$task = ConvertFrom-Json -InputObject $json
$staged = Join-Path $root 'wsl-install.msi'
try {{
$source = [IO.File]::Open($task.source, 'Open', 'Read', 'Read')
try {{
  $destination = [IO.File]::Open($staged, 'CreateNew', 'Write', 'None')
  try {{ $source.CopyTo($destination) }} finally {{ $destination.Dispose() }}
}} finally {{ $source.Dispose() }}
$hash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
if ((Get-Item -LiteralPath $staged).Length -ne [uint64]$task.size_bytes -or $hash -ne $task.sha256) {{
  throw '提权后复核 MSI 大小或 SHA-256 失败。'
}}
$signature = Get-AuthenticodeSignature -LiteralPath $staged
if ($signature.Status.ToString() -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {{
  throw '提权后复核 MSI 签名失败。'
}}
$featureResult = Enable-Platform
if ($featureResult -ne 0) {{ exit $featureResult }}
$msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
$msiLog = Join-Path $root 'wsl-msi.log'
$arguments = '/i "' + $staged + '" /qn /norestart /L*v "' + $msiLog + '"'
$install = Start-Process -FilePath $msiexec -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
exit $install.ExitCode
}} finally {{ Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }}
"#
    )
}

#[cfg(test)]
mod tests {
    use super::{
        elevated_installer_script, elevated_launcher_script, with_installer_mutex,
        PROTECTED_STAGING,
    };

    #[test]
    fn privileged_script_revalidates_msi_and_never_accepts_a_command_argument() {
        let script = elevated_installer_script("eyJzYW1wbGUiOnRydWV9");
        assert!(script.contains("Get-FileHash"));
        assert!(script.contains("Get-AuthenticodeSignature"));
        assert!(PROTECTED_STAGING.contains("VirtualMachinePlatform"));
        assert!(PROTECTED_STAGING.contains("/NoRestart") && script.contains("/norestart"));
        assert!(script.contains("Start-Process -FilePath $msiexec"));
    }

    #[test]
    fn launcher_maps_uac_cancel_to_msi_cancel_code() {
        let script = elevated_launcher_script("YWJj");
        assert!(script.contains("-Verb RunAs"));
        assert!(script.contains("-band 0xffff") && script.contains("1223"));
    }

    #[test]
    fn elevated_installer_keeps_a_separate_lock_if_the_ui_process_exits() {
        let script = with_installer_mutex("exit 0");
        assert!(script.contains("Local\\ClaudeHavenBootstrapInstaller"));
        assert!(script.contains("WaitOne(0)"));
        assert!(script.contains("ReleaseMutex"));
        assert!(script.contains("exit 1618"));
    }
}
