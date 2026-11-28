pub(crate) mod controller;
mod download;
pub(crate) mod installer;
pub(crate) mod probe;
pub(crate) mod state;
mod store;

pub(crate) fn decode_windows_output(bytes: &[u8]) -> String {
    state::decode_windows_output(bytes)
}

#[cfg(test)]
mod tests {
    use super::state::{
        classify_exit, decode_windows_output, parse_distro_list, wsl_list_reports_no_distributions,
        CommandKind, ExitDisposition,
    };

    #[test]
    fn decodes_utf16le_wsl_output_without_requiring_english_text() {
        let text = "适用于 Linux 的 Windows 子系统\nNAME STATE VERSION\nclaude-vm 已停止 2\n";
        let mut bytes = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }

        assert_eq!(decode_windows_output(&bytes), text);
        let distros = parse_distro_list(&decode_windows_output(&bytes));
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "claude-vm");
        assert_eq!(distros[0].wsl_version, Some(2));
    }

    #[test]
    fn recognizes_localized_empty_distro_list_without_bom_or_error_code() {
        let text = "适用于 Linux 的 Windows 子系统没有已安装的分发。\r\n\
                    使用 'wsl.exe --list --online' 列出可用的分发\r\n\
                    和 'wsl.exe --install <Distro>' 进行安装。\r\n";
        let bytes: Vec<_> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let decoded = decode_windows_output(&bytes);
        assert_eq!(decoded, text);
        assert_eq!(decode_windows_output(text.as_bytes()), text);
        assert!(wsl_list_reports_no_distributions(&decoded));
        assert!(wsl_list_reports_no_distributions("Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND"));
        assert!(!wsl_list_reports_no_distributions("Wsl/E_ACCESSDENIED"));
    }

    #[test]
    fn parses_default_distro_marker_and_ignores_localized_heading() {
        let distros = parse_distro_list(
            "Windows Subsystem for Linux Distributions:\nUbuntu Running 2\n* Debian Stopped 1\n",
        );
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu");
        assert_eq!(distros[0].wsl_version, Some(2));
        assert_eq!(distros[1].name, "Debian");
        assert_eq!(distros[1].wsl_version, Some(1));
    }

    #[test]
    fn installer_exit_codes_keep_reboot_cancel_and_busy_distinct() {
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
