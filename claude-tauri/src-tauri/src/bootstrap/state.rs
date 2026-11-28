use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandKind {
    Dism,
    Msi,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitDisposition {
    Success,
    RebootRequired,
    RebootStarted,
    Cancelled,
    Busy,
    Failed,
}

pub fn classify_exit(kind: CommandKind, code: i32) -> ExitDisposition {
    match code {
        0 => ExitDisposition::Success,
        3010 => ExitDisposition::RebootRequired,
        1641 if kind == CommandKind::Msi => ExitDisposition::RebootStarted,
        1223 => ExitDisposition::Cancelled,
        1602 if kind == CommandKind::Msi => ExitDisposition::Cancelled,
        1618 if kind == CommandKind::Msi => ExitDisposition::Busy,
        _ => ExitDisposition::Failed,
    }
}

pub fn decode_windows_output(bytes: &[u8]) -> String {
    let (encoding, bytes) = if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        (Some(false), rest)
    } else if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        (Some(true), rest)
    } else {
        // Localized WSL output can start with several non-ASCII UTF-16 units.
        // Look for the zero-byte alignment across the output, including CRLF.
        let zero_low = bytes.chunks_exact(2).filter(|pair| pair[0] == 0).count();
        let zero_high = bytes.chunks_exact(2).filter(|pair| pair[1] == 0).count();
        let encoding = if bytes.len() % 2 != 0 {
            None
        } else if zero_high >= zero_low + 2 {
            Some(false)
        } else if zero_low >= zero_high + 2 {
            Some(true)
        } else {
            None
        };
        (encoding, bytes)
    };

    let mut text = if let Some(big_endian) = encoding {
        let units = bytes
            .chunks_exact(2)
            .map(|pair| {
                if big_endian {
                    u16::from_be_bytes([pair[0], pair[1]])
                } else {
                    u16::from_le_bytes([pair[0], pair[1]])
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    while text.ends_with('\0') {
        text.pop();
    }
    text
}

pub fn wsl_list_reports_no_distributions(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    // Some versions print only Microsoft's localized MessageNoDefaultDistro.
    // Its two command examples are kept verbatim across locales.
    text.contains("wsl_e_default_distro_not_found")
        || (text.contains("wsl.exe --list --online") && text.contains("wsl.exe --install <distro>"))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WslDistro {
    pub name: String,
    pub state: String,
    pub wsl_version: Option<u8>,
}

pub fn parse_distro_list(text: &str) -> Vec<WslDistro> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim().trim_start_matches('\u{feff}');
            let line = line.strip_prefix('*').map(str::trim_start).unwrap_or(line);
            let mut columns = line.split_whitespace().collect::<Vec<_>>();
            let version = columns.pop()?.parse::<u8>().ok()?;
            if !matches!(version, 1 | 2) || columns.len() < 2 {
                return None;
            }
            let state = columns.pop()?.to_owned();
            let name = columns.join(" ");
            if name.is_empty() || name.eq_ignore_ascii_case("name") {
                return None;
            }
            Some(WslDistro {
                name,
                state,
                wsl_version: Some(version),
            })
        })
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BootstrapPhase {
    Idle,
    Probing,
    AlreadyReady,
    Blocked,
    NeedInstall,
    Downloading,
    Verifying,
    AwaitingElevation,
    EnablingFeatures,
    InstallingMsi,
    RebootRequired,
    Rechecking,
    InfrastructureReady,
    ImportingRuntime,
    VerifyingRuntime,
    RuntimeReady,
    Failed,
    Cancelled,
}

impl BootstrapPhase {
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Probing
                | Self::Downloading
                | Self::Verifying
                | Self::AwaitingElevation
                | Self::EnablingFeatures
                | Self::InstallingMsi
                | Self::Rechecking
                | Self::ImportingRuntime
                | Self::VerifyingRuntime
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BootstrapErrorCode {
    UnsupportedWindows,
    UnsupportedArchitecture,
    VirtualizationDisabled,
    VirtualizationUnknown,
    PolicyBlocked,
    RebootRequired,
    Network,
    DownloadCancelled,
    DownloadFailed,
    SizeMismatch,
    HashMismatch,
    SignatureInvalid,
    UacCancelled,
    InstallerBusy,
    InstallerFailed,
    RuntimeImportFailed,
    RuntimeProbeFailed,
    DiskSpaceLow,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BootstrapError {
    pub diagnostic_id: Option<String>,
    pub code: BootstrapErrorCode,
    pub phase: BootstrapPhase,
    pub raw_exit_code: Option<i32>,
    pub hresult: Option<String>,
    pub retryable: bool,
    pub user_message: String,
    pub log_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub bytes_per_second: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct BootstrapSnapshot {
    pub schema_version: u32,
    pub task_id: Option<String>,
    pub sequence: u64,
    pub phase: BootstrapPhase,
    pub resource_version: Option<String>,
    pub cache_path: Option<PathBuf>,
    pub download: Option<DownloadProgress>,
    pub reboot_required: bool,
    pub can_cancel: bool,
    pub last_start_id: Option<String>,
    pub system_boot_id: Option<String>,
    pub error: Option<BootstrapError>,
}

impl Default for BootstrapSnapshot {
    fn default() -> Self {
        Self {
            schema_version: 1,
            task_id: None,
            sequence: 0,
            phase: BootstrapPhase::Idle,
            resource_version: None,
            cache_path: None,
            download: None,
            reboot_required: false,
            can_cancel: false,
            last_start_id: None,
            system_boot_id: None,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_exit, CommandKind, ExitDisposition};

    #[test]
    fn msi_and_dism_exit_codes_have_distinct_meanings() {
        assert_eq!(classify_exit(CommandKind::Msi, 0), ExitDisposition::Success);
        assert_eq!(
            classify_exit(CommandKind::Msi, 3010),
            ExitDisposition::RebootRequired
        );
        assert_eq!(
            classify_exit(CommandKind::Msi, 1641),
            ExitDisposition::RebootStarted
        );
        assert_eq!(
            classify_exit(CommandKind::Msi, 1602),
            ExitDisposition::Cancelled
        );
        assert_eq!(classify_exit(CommandKind::Msi, 1618), ExitDisposition::Busy);
        assert_eq!(
            classify_exit(CommandKind::Dism, 3010),
            ExitDisposition::RebootRequired
        );
        assert_eq!(
            classify_exit(CommandKind::Dism, 1602),
            ExitDisposition::Failed
        );
    }
}
