//! Windows WSL integration. This module intentionally contains no UI logic.

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Quote a single POSIX shell argument, including embedded apostrophes.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Convert a local drive path to WSL's standard automount location.
/// UNC and relative paths are rejected rather than guessed.
pub fn guest_path(path: &Path) -> Result<String, String> {
    let raw = path
        .to_str()
        .ok_or("路径包含无法转换的字符。")?
        .replace('\\', "/");
    // Windows canonicalize() uses the extended-length prefix for local paths.
    // Only remove that prefix; the drive check below still rejects UNC devices.
    let raw = raw.strip_prefix("//?/").unwrap_or(&raw);
    let bytes = raw.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'/' {
        return Err("请选择本机磁盘上的绝对路径；暂不支持网络路径。".into());
    }
    if raw[3..].split('/').any(|part| part == "..") {
        return Err("路径不能包含上级目录引用。".into());
    }
    Ok(format!(
        "/mnt/{}/{}",
        (bytes[0] as char).to_ascii_lowercase(),
        &raw[3..]
    ))
}

/// Development sources are deliberately explicit; packaged resources will be
/// resolved from Tauri's resource directory when bundling is enabled.
pub fn development_runtime() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace path")
        .join("runtime")
}

/// Pass the shell program as base64: wsl.exe may otherwise reinterpret `$`.
pub fn bash_command(script: &str) -> String {
    format!(
        "printf '%s' '{}' | base64 -d | bash",
        STANDARD.encode(script.as_bytes())
    )
}

/// Hash every regular script, so a reported successful copy can be verified.
pub fn script_manifest(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut manifest = BTreeMap::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("无法读取脚本目录：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "脚本文件名无效。")?;
        if !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err("脚本文件名包含不支持的字符。".into());
        }
        let data = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        manifest.insert(name, format!("{:x}", Sha256::digest(data)));
    }
    if manifest.is_empty() {
        return Err("运行时脚本目录为空。".into());
    }
    Ok(manifest)
}

pub fn asset_manifest(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    fn visit(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("无法读取资源目录：{e}"))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err("资源目录不能包含符号链接。".into());
            }
            if kind.is_dir() {
                visit(base, &entry.path(), out)?;
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("资源文件名无效。")?
                .replace('\\', "/");
            if !relative
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
            {
                return Err("资源文件名包含不支持的字符。".into());
            }
            let data = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            out.insert(relative, format!("{:x}", Sha256::digest(data)));
        }
        Ok(())
    }
    let mut manifest = BTreeMap::new();
    visit(dir, dir, &mut manifest)?;
    if manifest.is_empty() {
        return Err("运行时资源目录为空。".into());
    }
    Ok(manifest)
}

pub fn sync_script(
    scripts: &str,
    assets: &str,
    manifest: &BTreeMap<String, String>,
    asset_files: &BTreeMap<String, String>,
) -> String {
    sync_script_to(
        scripts,
        assets,
        manifest,
        asset_files,
        "/opt/scripts",
        "/opt/assets",
    )
}

fn sync_script_to(
    scripts: &str,
    assets: &str,
    manifest: &BTreeMap<String, String>,
    asset_files: &BTreeMap<String, String>,
    dest_scripts: &str,
    dest_assets: &str,
) -> String {
    let mut script = format!(
        "set -eu\nmkdir -p {} {}\nsync_file() {{\n  src=$1; dest=$2; hash=$3; tmp=\"${{dest}}.tmp\"\n  mkdir -p \"$(dirname \"$dest\")\"\n  if ! printf '%s  %s\\n' \"$hash\" \"$dest\" | sha256sum -c - >/dev/null 2>&1; then\n    cp -f \"$src\" \"$tmp\"\n    printf '%s  %s\\n' \"$hash\" \"$tmp\" | sha256sum -c - >/dev/null\n    mv -f \"$tmp\" \"$dest\"\n  fi\n}}\n",
        shell_quote(dest_scripts),
        shell_quote(dest_assets)
    );
    for (name, hash) in manifest {
        let source = shell_quote(&format!("{scripts}/{name}"));
        let dest = shell_quote(&format!("{dest_scripts}/{name}"));
        script.push_str(&format!("sync_file {source} {dest} {hash}\n"));
    }
    for (name, hash) in asset_files {
        let source = shell_quote(&format!("{assets}/{name}"));
        let dest_path = format!("{dest_assets}/{name}");
        let dest = shell_quote(&dest_path);
        script.push_str(&format!("sync_file {source} {dest} {hash}\n"));
    }
    script.push_str(&format!(
        "chmod +x {}/*.sh\nprintf 'SYNCED\\n'\n",
        shell_quote(dest_scripts)
    ));
    script
}

/// The launcher owns the order of security-sensitive steps. Implementations
/// provide platform operations; any error prevents later steps from running.
pub trait LaunchOperations {
    fn validate(&mut self) -> Result<(), String>;
    fn ensure_stopped_and_port_free(&mut self) -> Result<(), String>;
    fn ensure_runtime(&mut self) -> Result<(), String>;
    fn sync_verified_resources(&mut self) -> Result<(), String>;
    fn install_network_config(&mut self) -> Result<(), String>;
    fn spawn_entrypoint(&mut self) -> Result<(), String>;
    fn await_desktop(&mut self) -> Result<(), String>;
    fn verify_guard(&mut self) -> Result<(), String>;
}

#[cfg(test)]
fn launch(ops: &mut impl LaunchOperations) -> Result<(), String> {
    launch_with_progress(ops, |_| {})
}

pub fn launch_with_progress(
    ops: &mut impl LaunchOperations,
    mut progress: impl FnMut(&str),
) -> Result<(), String> {
    progress("preparing");
    ops.validate()?;
    ops.ensure_stopped_and_port_free()?;
    ops.ensure_runtime()?;
    ops.sync_verified_resources()?;
    ops.install_network_config()?;
    ops.spawn_entrypoint()?;
    progress("desktop-starting");
    ops.await_desktop()?;
    progress("desktop-ready");
    ops.verify_guard()?;
    Ok(())
}

pub trait StopOperations {
    fn is_running(&mut self) -> Result<bool, String>;
    fn restore_network(&mut self) -> Result<(), String>;
    fn can_terminate_without_restore(&mut self) -> Result<bool, String> {
        Ok(false)
    }
    fn terminate(&mut self) -> Result<(), String>;
}

pub fn shutdown(ops: &mut impl StopOperations) -> Result<(), String> {
    if !ops.is_running()? {
        return Ok(());
    }
    if let Err(error) = ops.restore_network() {
        if !ops.can_terminate_without_restore()? {
            return Err(error);
        }
    }
    ops.terminate()
}

#[cfg(windows)]
pub(crate) fn run_wsl(args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new(wsl_exe_path())
        .args(args)
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("无法执行 WSL：{e}"))
}

#[cfg(windows)]
fn wsl_exe_path() -> PathBuf {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(system_root).join("System32").join("wsl.exe")
}

#[cfg(windows)]
pub(crate) fn output_text(output: &std::process::Output) -> String {
    let mut bytes = output.stdout.clone();
    bytes.extend_from_slice(&output.stderr);
    crate::bootstrap::decode_windows_output(&bytes)
        .trim()
        .to_owned()
}

#[cfg(windows)]
fn wsl2_probe_error(stage: &str, output: &std::process::Output) -> String {
    let detail = output_text(output);
    let normalized = detail.to_ascii_lowercase();
    if normalized.contains("0x80370102") || normalized.contains("wsl_e_hyperv_not_installed") {
        format!("{stage}：WSL 2 虚拟机无法启动（原始信息：{detail}）。可能涉及 VirtualMachinePlatform、固件虚拟化或 Hypervisor 策略；请查看系统诊断信息。")
    } else {
        format!("{stage}：{detail}")
    }
}

#[cfg(windows)]
fn guest_script(script: &str) -> Result<String, String> {
    let encoded = bash_command(script);
    let result = run_wsl(&[
        "-d",
        "claude-vm",
        "-u",
        "root",
        "--",
        "bash",
        "-c",
        &encoded,
    ])?;
    if !result.status.success() {
        return Err(format!("虚拟环境操作失败：{}", output_text(&result)));
    }
    Ok(output_text(&result))
}

fn parse_guard_state(raw: &str, now: u64) -> Result<String, String> {
    let value = |key: &str| {
        raw.lines()
            .find_map(|line| line.trim().strip_prefix(key))
            .unwrap_or("")
            .trim()
    };
    let state = value("state=");
    let ts = value("ts=")
        .parse::<u64>()
        .map_err(|_| "网络守卫心跳缺失。")?;
    if now.saturating_sub(ts) > 30 || ts > now.saturating_add(5) {
        return Err("网络守卫心跳已过期。".into());
    }
    match state {
        "guarded" if value("locked=") == "1" && value("preflight=") == "pass" => Ok(state.into()),
        "blocked" | "proxy_down" | "off" => Ok(state.into()),
        _ => Err("网络守卫状态未确认。".into()),
    }
}

fn guard_failure_message(reason: &str) -> &'static str {
    match reason.trim() {
        "proxy-unreachable" => {
            "网络守卫无法通过所选节点获取出口信息。请检查节点、配置和网络后重试。"
        }
        "exit-region-risk" => "出口地区未通过网络守卫检查，请更换节点后重试。",
        "exit-region-unknown" => "无法确认出口地区或支持地区名单不可用，请检查网络后重试。",
        "dns-not-ready" => "虚拟机 DNS 尚未就绪，网络保护未通过检查。",
        "split-exit" => "网络守卫检测到多个出口，请检查配置或更换节点后重试。",
        "anthropic-unreachable" => "无法通过所选节点访问 Claude 服务，请检查节点后重试。",
        "leak-detected" | "lock-failed" => {
            "网络接管或保护未生效，已拒绝启动。请检查网络配置后重试。"
        }
        _ => "网络守卫未确认受保护状态；请检查网络后重试。",
    }
}

#[cfg(windows)]
pub(crate) fn read_guard_state() -> Result<String, String> {
    let script = "set -eu\ntest -s /run/claude-vm/net-guard.pid\nkill -0 \"$(cat /run/claude-vm/net-guard.pid)\"\ncat /run/claude-vm/net-guard.state\n";
    let raw = guest_script(script)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let state = parse_guard_state(&raw, now)?;
    if state == "guarded" {
        let prerequisites = guest_script("set -eu\npgrep -x mihomo >/dev/null\ngrep -qE '^ *Meta:' /proc/net/dev\ntest \"$(awk '/^nameserver[[:space:]]/{print $2}' /etc/resolv.conf)\" = 127.0.0.1\npython3 /opt/scripts/net-guard.py status\n")?;
        let status: serde_json::Value =
            serde_json::from_str(&prerequisites).map_err(|_| "无法读取网络保护条件。")?;
        if !protection_prerequisites_met(&status) {
            return Err("网络保护条件未全部满足。".into());
        }
    }
    Ok(state)
}

fn protection_prerequisites_met(status: &serde_json::Value) -> bool {
    status.get("locked").and_then(|v| v.as_bool()) == Some(true)
        && status.get("ipv6_disabled").and_then(|v| v.as_bool()) == Some(true)
}

#[cfg(windows)]
pub(crate) fn verify_existing_desktop() -> Result<(), String> {
    guest_script(
        "set -eu\ntest -f /run/claude-vm/ready\npgrep -f '[w]ebsockify --web=' >/dev/null\n",
    )
    .map_err(|_| "已有会话的桌面未就绪，请停止环境后重新启动。".to_string())?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], 6080));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(300))
        .map_err(|_| "无法连接已有虚拟桌面，请停止环境后重新启动。".to_string())?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn ensure_clipboard_bridge() -> Result<(), String> {
    guest_script(
        "set -eu\ncommand -v vncconfig >/dev/null\nif ! pgrep -x vncconfig >/dev/null; then DISPLAY=:1 nohup vncconfig -nowin </dev/null >/tmp/claude-vm-vncconfig.log 2>&1 & fi\nprintf READY\n",
    )?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn sync_diagnostics(root: &Path) -> Result<(), String> {
    let all = script_manifest(&root.join("scripts"))?;
    let mut selected = BTreeMap::new();
    for name in ["check-network.py", "claude-supported-regions.py"] {
        selected.insert(
            name.to_string(),
            all.get(name).ok_or("本地检查脚本不完整。")?.clone(),
        );
    }
    let program = sync_script(
        &guest_path(&root.join("scripts"))?,
        &guest_path(&root.join("assets"))?,
        &selected,
        &BTreeMap::new(),
    );
    if guest_script(&program)?
        .lines()
        .any(|line| line.trim() == "SYNCED")
    {
        Ok(())
    } else {
        Err("无法更新本地检查脚本。".into())
    }
}

#[cfg(windows)]
pub(crate) fn ensure_guard_running(root: &Path) -> Result<(), String> {
    let state = guest_script("set -eu\np=$(cat /run/claude-vm/net-guard.pid 2>/dev/null || true)\ncase \"$p\" in ''|*[!0-9]*) ;; *) if kill -0 \"$p\" 2>/dev/null && tr '\\0' ' ' < /proc/\"$p\"/cmdline | grep -q '[n]et-guard.sh'; then printf running; exit 0; fi;; esac\npython3 -c 'import glob,os\nfound={}\nfor p in glob.glob(\"/proc/[0-9]*/cmdline\"):\n try:\n  with open(p,\"rb\") as f: args=f.read().split(b\"\\0\")\n  if b\"/opt/scripts/net-guard.sh\" not in args: continue\n  q=p.rsplit(\"/\",1)[0]; lines=open(q+\"/status\").read().splitlines(); state=next(x.split()[1] for x in lines if x.startswith(\"State:\")); parent=int(next(x.split()[1] for x in lines if x.startswith(\"PPid:\")))\n  if state != \"Z\": found[int(os.path.basename(q))]=parent\n except (OSError,StopIteration,ValueError): pass\nroots=[pid for pid,parent in found.items() if parent not in found]\nprint(\"absent\" if not roots else (\"orphan:\"+str(roots[0]) if len(roots)==1 else \"ambiguous\"))'\n")?;
    let orphan = match state.as_str() {
        "running" => return Ok(()),
        "absent" => None,
        _ if state.starts_with("orphan:") => Some(
            state[7..]
                .parse::<u32>()
                .map_err(|_| "无法确认现有守卫进程。")?,
        ),
        _ => return Err("无法确认现有网络守卫进程，请检查环境状态。".into()),
    };
    let current = guest_script("set -eu\npgrep -x mihomo >/dev/null\ngrep -qE '^ *Meta:' /proc/net/dev\ntest \"$(awk '/^nameserver[[:space:]]/{print $2}' /etc/resolv.conf)\" = 127.0.0.1\npython3 /opt/scripts/net-guard.py status\n")
        .map_err(|_| "现有网络保护条件不完整，无法自动恢复守卫。")?;
    let status: serde_json::Value =
        serde_json::from_str(&current).map_err(|_| "无法读取网络保护条件。")?;
    if !protection_prerequisites_met(&status) {
        return Err("路由或 IPv6 保护未确认，无法自动恢复守卫。".into());
    }
    if let Some(pid) = orphan {
        // A previous shell may have removed its PID file yet continued running.
        // With the routes still locked, stop only processes whose argv contains
        // the exact guard script, then start a single fresh watchdog below.
        guest_script(&format!("set -eu\ntest ! -s /run/claude-vm/net-guard.pid\npython3 - {pid} <<'PY'\nimport glob, os, signal, sys\nexpected = int(sys.argv[1])\nfound = {{}}\nfor p in glob.glob('/proc/[0-9]*/cmdline'):\n try:\n  with open(p, 'rb') as f: args = f.read().split(b'\\0')\n  if b'/opt/scripts/net-guard.sh' not in args: continue\n  q = p.rsplit('/', 1)[0]; lines = open(q + '/status').read().splitlines()\n  state = next(x.split()[1] for x in lines if x.startswith('State:'))\n  parent = int(next(x.split()[1] for x in lines if x.startswith('PPid:')))\n  if state != 'Z': found[int(os.path.basename(q))] = parent\n except (OSError, StopIteration, ValueError): pass\nroots = [p for p, parent in found.items() if parent not in found]\nif roots != [expected]: sys.exit(1)\nfor p in found:\n try: os.kill(p, signal.SIGKILL)\n except ProcessLookupError: pass\nPY\n"))
            .map_err(|_| "守卫状态正在变化，请刷新后重试。")?;
    }
    let all = script_manifest(&root.join("scripts"))?;
    let mut selected = BTreeMap::new();
    for name in ["net-guard.sh", "claude-supported-regions.py"] {
        selected.insert(
            name.to_string(),
            all.get(name).ok_or("网络守卫文件不完整。")?.clone(),
        );
    }
    let program = sync_script(
        &guest_path(&root.join("scripts"))?,
        &guest_path(&root.join("assets"))?,
        &selected,
        &BTreeMap::new(),
    );
    if !guest_script(&program)?
        .lines()
        .any(|line| line.trim() == "SYNCED")
    {
        return Err("无法更新网络守卫。".into());
    }
    guest_script("set -eu\nNET_GUARD=strict NET_GUARD_STRICT_REGION=1 nohup /opt/scripts/net-guard.sh </dev/null >/tmp/claude-vm-net-guard-recovery.log 2>&1 &\nprintf STARTED\n")?;
    Ok(())
}

#[cfg(windows)]
pub struct WslLaunch {
    pub config: crate::WorkspaceConfig,
    pub data_dir: PathBuf,
    pub runtime_root: PathBuf,
    manifest: BTreeMap<String, String>,
    asset_files: BTreeMap<String, String>,
    spawned: bool,
}

#[cfg(windows)]
impl WslLaunch {
    pub fn new(config: crate::WorkspaceConfig, data_dir: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            config,
            data_dir,
            runtime_root,
            manifest: BTreeMap::new(),
            asset_files: BTreeMap::new(),
            spawned: false,
        }
    }
    pub fn was_spawned(&self) -> bool {
        self.spawned
    }
}

#[cfg(windows)]
impl LaunchOperations for WslLaunch {
    fn validate(&mut self) -> Result<(), String> {
        crate::validate_exit_node(&self.config)?;
        if !["tw-taipei", "us"].contains(&self.config.region.as_str()) {
            return Err("请选择有效地区。".into());
        }
        if !Path::new(&self.config.workspace).is_dir() {
            return Err("请选择可访问的工作区。".into());
        }
        guest_path(Path::new(&self.config.workspace))?;
        guest_path(Path::new(&self.config.yaml_path))?;
        let root = &self.runtime_root;
        if !root.join("rootfs.tar.gz").is_file() || !root.join("assets").is_dir() {
            return Err("运行时资源不完整。".into());
        }
        self.manifest = script_manifest(&root.join("scripts"))?;
        self.asset_files = asset_manifest(&root.join("assets"))?;
        for name in [
            "entrypoint.sh",
            "net-guard.sh",
            "net-guard.py",
            "claude-supported-regions.py",
            "check-network.py",
            "tun-core.sh",
            "tun-merge.py",
        ] {
            if !self.manifest.contains_key(name) {
                return Err(format!("缺少必需的运行时脚本：{name}"));
            }
        }
        for name in [
            "novnc/desktop.html",
            "novnc/novnc-1.7.0.tgz",
            "rime/wanxiang-pure.zip",
        ] {
            if !self.asset_files.contains_key(name) {
                return Err(format!("缺少必需的运行时资源：{name}"));
            }
        }
        Ok(())
    }

    fn ensure_stopped_and_port_free(&mut self) -> Result<(), String> {
        let running = run_wsl(&["--list", "--running", "--quiet"])?;
        if !running.status.success()
            && !output_text(&running).contains("WSL_E_DEFAULT_DISTRO_NOT_FOUND")
        {
            return Err("无法确认已有 WSL 会话状态，已中止启动。".into());
        }
        if output_text(&running)
            .lines()
            .any(|s| s.trim().eq_ignore_ascii_case("claude-vm"))
        {
            let idle = guest_script("set -eu\n! test -f /run/claude-vm/ready\n! pgrep -x Xtigervnc >/dev/null\n! pgrep -x mihomo >/dev/null\n! pgrep -x fcitx5 >/dev/null\n! pgrep -x chrome >/dev/null\n! pgrep -f '[w]ebsockify --web=' >/dev/null\n! test -s /run/claude-vm/net-guard.pid\nprintf IDLE\n");
            if !idle.is_ok_and(|result| result.contains("IDLE")) {
                return Err("已有环境正在运行或启动中，请刷新状态以恢复现有桌面。".into());
            }
        }
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], 6080));
        if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(300))
            .is_ok()
        {
            return Err("本机 6080 端口已被占用。".into());
        }
        Ok(())
    }

    fn ensure_runtime(&mut self) -> Result<(), String> {
        let list = run_wsl(&["--list", "--verbose"])?;
        let distros = crate::bootstrap::state::parse_distro_list(&output_text(&list));
        if let Some(distro) = distros
            .iter()
            .find(|distro| distro.name.eq_ignore_ascii_case("claude-vm"))
        {
            match distro.wsl_version {
                Some(2) => {
                    let probe = run_wsl(&["-d", "claude-vm", "--exec", "/bin/true"])?;
                    if probe.status.success() {
                        return Ok(());
                    }
                    return Err(wsl2_probe_error("claude-vm 已注册为 WSL 2，但最小启动探针失败", &probe));
                }
                Some(1) => return Err("claude-vm 已注册为 WSL 1。为保护其中数据，Claude Haven 不会自动转换或覆盖；请先备份后修复运行时。".into()),
                _ => return Err("无法确认 claude-vm 的 WSL 架构版本；未修改现有发行版。".into()),
            }
        }
        if !list.status.success() && !output_text(&list).contains("WSL_E_DEFAULT_DISTRO_NOT_FOUND")
        {
            return Err("无法确认 WSL 发行版状态，请检查 WSL2。".into());
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("无法创建运行时目录：{e}"))?;
        let dir = self.data_dir.to_str().ok_or("运行时目录无效。")?;
        let root = self.runtime_root.join("rootfs.tar.gz");
        let image = root.to_str().ok_or("运行时镜像路径无效。")?;
        let imported = run_wsl(&["--import", "claude-vm", dir, image, "--version", "2"])?;
        if imported.status.success() {
            let probe = run_wsl(&["-d", "claude-vm", "--exec", "/bin/true"])?;
            if probe.status.success() {
                Ok(())
            } else {
                Err(wsl2_probe_error(
                    "claude-vm 已导入，但 WSL 2 最小启动探针失败",
                    &probe,
                ))
            }
        } else {
            Err(wsl2_probe_error("导入虚拟环境失败", &imported))
        }
    }

    fn sync_verified_resources(&mut self) -> Result<(), String> {
        let root = &self.runtime_root;
        let script = sync_script(
            &guest_path(&root.join("scripts"))?,
            &guest_path(&root.join("assets"))?,
            &self.manifest,
            &self.asset_files,
        );
        if guest_script(&script)?.lines().any(|s| s.trim() == "SYNCED") {
            Ok(())
        } else {
            Err("运行时同步未完成，已中止启动。".into())
        }
    }

    fn install_network_config(&mut self) -> Result<(), String> {
        let yaml = guest_path(Path::new(&self.config.yaml_path))?;
        guest_script(&format!(
            "set -eu\ninstall -m 600 {} /opt/config/clash.yaml\nrm -f /run/claude-vm/ready\n",
            shell_quote(&yaml)
        ))?;
        Ok(())
    }

    fn spawn_entrypoint(&mut self) -> Result<(), String> {
        use std::process::{Command, Stdio};
        let (tz, lang, chrome) = if self.config.region == "us" {
            ("America/Los_Angeles", "en_US.UTF-8", "en-US")
        } else {
            ("Asia/Taipei", "zh_TW.UTF-8", "zh-TW")
        };
        let env = [
            format!("TZ={tz}"),
            format!("LANG={lang}"),
            format!("LC_ALL={lang}"),
            format!("CHROME_LANG={chrome}"),
            format!("TUN_NODE={}", self.config.node),
            format!(
                "WORKSPACE={}",
                guest_path(Path::new(&self.config.workspace))?
            ),
            "NET_GUARD=strict".into(),
            "NET_GUARD_STRICT_REGION=1".into(),
            "INPUT_METHOD=rime".into(),
            "NOVNC_PORT=6080".into(),
        ];
        Command::new(wsl_exe_path())
            .args(["-d", "claude-vm", "-u", "root", "--", "env"])
            .args(env)
            .arg("/opt/scripts/entrypoint.sh")
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动虚拟环境失败：{e}"))?;
        self.spawned = true;
        Ok(())
    }

    fn await_desktop(&mut self) -> Result<(), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], 6080));
        while std::time::Instant::now() < deadline {
            if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(300))
                .is_ok()
                && guest_script("test -f /run/claude-vm/ready && printf READY")
                    .is_ok_and(|s| s.contains("READY"))
            {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(700));
        }
        Err("桌面未在 60 秒内就绪，请检查运行时日志。".into())
    }

    fn verify_guard(&mut self) -> Result<(), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut blocked = false;
        while std::time::Instant::now() < deadline {
            if let Ok(state) = read_guard_state() {
                if state == "guarded" {
                    return Ok(());
                }
                if state == "blocked" || state == "off" {
                    blocked = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(700));
        }
        let reason = if blocked {
            guest_script("sed -n 's/^reason=//p' /run/claude-vm/net-guard.state | grep -E '^(proxy-unreachable|exit-region-risk|exit-region-unknown|dns-not-ready|split-exit|anthropic-unreachable|leak-detected|lock-failed)$' || true").unwrap_or_default()
        } else {
            String::new()
        };
        Err(format!(
            "{} 环境不会被标记为就绪。",
            guard_failure_message(&reason)
        ))
    }
}

/// User-initiated shutdown: restore the guest network before terminating the
/// distribution. If restoration fails, keep the session so it can be inspected.
#[cfg(windows)]
pub struct WslStop;

#[cfg(windows)]
impl StopOperations for WslStop {
    fn is_running(&mut self) -> Result<bool, String> {
        let running = run_wsl(&["--list", "--running", "--quiet"])?;
        if !running.status.success() {
            if output_text(&running).contains("WSL_E_DEFAULT_DISTRO_NOT_FOUND") {
                return Ok(false);
            }
            return Err("无法确认虚拟环境状态，未执行停止。".into());
        }
        Ok(output_text(&running)
            .lines()
            .any(|s| s.trim().eq_ignore_ascii_case("claude-vm")))
    }
    fn restore_network(&mut self) -> Result<(), String> {
        // Stop the watchdog before unlocking, or it can immediately re-lock
        // the route while shutdown is trying to restore it.
        guest_script("set -eu\nif test -s /run/claude-vm/net-guard.pid; then p=$(cat /run/claude-vm/net-guard.pid); case \"$p\" in *[!0-9]*|'') exit 1;; esac; if kill -0 \"$p\" 2>/dev/null; then tr '\\0' ' ' < /proc/\"$p\"/cmdline | grep -q 'net-guard.sh' || exit 1; kill \"$p\"; fi; fi\n")?;
        let result = run_wsl(&[
            "-d",
            "claude-vm",
            "-u",
            "root",
            "--",
            "python3",
            "/opt/scripts/net-guard.py",
            "unlock",
        ])?;
        let text = String::from_utf8_lossy(&result.stdout).replace('\0', "");
        let unlocked = text
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .any(|v| v.get("ok").and_then(|x| x.as_bool()) == Some(true));
        if result.status.success() && unlocked {
            Ok(())
        } else {
            Err("无法确认网络已恢复，未停止虚拟环境；请查看运行时日志。".into())
        }
    }
    fn can_terminate_without_restore(&mut self) -> Result<bool, String> {
        let running = run_wsl(&["--list", "--running", "--quiet"])?;
        if !running.status.success() {
            return Ok(false);
        }
        let text = output_text(&running);
        let names: Vec<_> = text
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if names.len() != 1 || !names[0].eq_ignore_ascii_case("claude-vm") {
            return Ok(false);
        }
        Ok(guest_script("test ! -e /run/claude-vm/net-guard.orig").is_ok())
    }
    fn terminate(&mut self) -> Result<(), String> {
        let result = run_wsl(&["--terminate", "claude-vm"])?;
        if result.status.success() {
            Ok(())
        } else {
            Err(format!("停止虚拟环境失败：{}", output_text(&result)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_drive_paths_are_mapped_and_unc_paths_rejected() {
        assert_eq!(
            guest_path(Path::new(r"E:\My Work\file.yaml")).unwrap(),
            "/mnt/e/My Work/file.yaml"
        );
        assert!(guest_path(Path::new(r"\\server\share")).is_err());
        assert!(guest_path(Path::new("relative")).is_err());
        assert!(guest_path(Path::new(r"E:\work\..\elsewhere")).is_err());
    }

    #[test]
    fn canonicalized_local_resource_path_is_mapped() {
        assert_eq!(
            guest_path(Path::new(r"\\?\E:\app\runtime\scripts")).unwrap(),
            "/mnt/e/app/runtime/scripts"
        );
        assert!(guest_path(Path::new(r"\\?\UNC\server\share")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn canonicalized_existing_runtime_path_is_mapped() {
        let path = development_runtime()
            .join("scripts")
            .canonicalize()
            .unwrap();
        assert!(guest_path(&path).unwrap().starts_with("/mnt/"));
    }

    #[test]
    fn shell_arguments_preserve_apostrophes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn sync_encodes_shell_and_verifies_each_copied_file() {
        let mut files = BTreeMap::new();
        files.insert("entrypoint.sh".into(), "123456".into());
        let mut assets = BTreeMap::new();
        assets.insert("novnc/desktop.html".into(), "abcdef".into());
        let script = sync_script(
            "/mnt/c/My O'Brien/scripts",
            "/mnt/c/assets",
            &files,
            &assets,
        );
        assert!(script.contains("O'\\''Brien"));
        assert!(script.contains("sha256sum -c"));
        assert!(script.contains("/opt/assets/novnc/desktop.html"));
        assert!(script.contains("tmp=\"${dest}.tmp\""));
        let encoded = bash_command(&script);
        let payload = encoded.split('\'').nth(3).unwrap();
        assert_eq!(STANDARD.decode(payload).unwrap(), script.as_bytes());
    }

    #[derive(Default)]
    struct FakeLaunch {
        calls: Vec<&'static str>,
        fail: &'static str,
    }
    impl FakeLaunch {
        fn step(&mut self, name: &'static str) -> Result<(), String> {
            self.calls.push(name);
            if self.fail == name {
                Err(name.into())
            } else {
                Ok(())
            }
        }
    }
    impl LaunchOperations for FakeLaunch {
        fn validate(&mut self) -> Result<(), String> {
            self.step("validate")
        }
        fn ensure_stopped_and_port_free(&mut self) -> Result<(), String> {
            self.step("port")
        }
        fn ensure_runtime(&mut self) -> Result<(), String> {
            self.step("runtime")
        }
        fn sync_verified_resources(&mut self) -> Result<(), String> {
            self.step("sync")
        }
        fn install_network_config(&mut self) -> Result<(), String> {
            self.step("config")
        }
        fn spawn_entrypoint(&mut self) -> Result<(), String> {
            self.step("spawn")
        }
        fn await_desktop(&mut self) -> Result<(), String> {
            self.step("desktop")
        }
        fn verify_guard(&mut self) -> Result<(), String> {
            self.step("guard")
        }
    }

    #[test]
    fn failed_sync_cannot_start_guest() {
        let mut ops = FakeLaunch {
            fail: "sync",
            ..Default::default()
        };
        assert!(launch(&mut ops).is_err());
        assert_eq!(ops.calls, ["validate", "port", "runtime", "sync"]);
    }

    #[test]
    fn desktop_is_not_ready_without_guard_verification() {
        let mut ops = FakeLaunch {
            fail: "guard",
            ..Default::default()
        };
        assert!(launch(&mut ops).is_err());
        assert_eq!(ops.calls.last(), Some(&"guard"));
    }

    #[test]
    fn desktop_progress_does_not_bypass_guard() {
        let mut ops = FakeLaunch {
            fail: "guard",
            ..Default::default()
        };
        let mut stages = Vec::new();
        assert!(launch_with_progress(&mut ops, |stage| stages.push(stage.to_owned())).is_err());
        assert_eq!(stages, ["preparing", "desktop-starting", "desktop-ready"]);
        assert_eq!(ops.calls.last(), Some(&"guard"));
    }

    #[test]
    fn failed_network_restore_does_not_terminate_guest() {
        struct FakeStop {
            terminated: bool,
        }
        impl StopOperations for FakeStop {
            fn is_running(&mut self) -> Result<bool, String> {
                Ok(true)
            }
            fn restore_network(&mut self) -> Result<(), String> {
                Err("failed".into())
            }
            fn terminate(&mut self) -> Result<(), String> {
                self.terminated = true;
                Ok(())
            }
        }
        let mut ops = FakeStop { terminated: false };
        assert!(shutdown(&mut ops).is_err());
        assert!(!ops.terminated);
    }

    #[test]
    fn missing_route_record_allows_only_explicitly_safe_termination() {
        struct FakeStop {
            safe: bool,
            terminated: bool,
        }
        impl StopOperations for FakeStop {
            fn is_running(&mut self) -> Result<bool, String> {
                Ok(true)
            }
            fn restore_network(&mut self) -> Result<(), String> {
                Err("missing".into())
            }
            fn can_terminate_without_restore(&mut self) -> Result<bool, String> {
                Ok(self.safe)
            }
            fn terminate(&mut self) -> Result<(), String> {
                self.terminated = true;
                Ok(())
            }
        }
        let mut unsafe_stop = FakeStop {
            safe: false,
            terminated: false,
        };
        assert!(shutdown(&mut unsafe_stop).is_err());
        assert!(!unsafe_stop.terminated);
        let mut safe_stop = FakeStop {
            safe: true,
            terminated: false,
        };
        assert!(shutdown(&mut safe_stop).is_ok());
        assert!(safe_stop.terminated);
    }

    #[test]
    fn stale_or_unlocked_guard_cannot_report_protection() {
        let good = "state=guarded\nlocked=1\npreflight=pass\nts=1000\n";
        assert_eq!(parse_guard_state(good, 1010).unwrap(), "guarded");
        assert!(parse_guard_state(good, 1031).is_err());
        assert!(parse_guard_state(&good.replace("locked=1", "locked=0"), 1010).is_err());
        assert!(
            parse_guard_state(&good.replace("preflight=pass", "preflight=fail"), 1010).is_err()
        );
    }

    #[test]
    fn guard_requires_actual_ipv4_and_ipv6_protection() {
        assert!(protection_prerequisites_met(
            &serde_json::json!({"locked":true,"ipv6_disabled":true})
        ));
        assert!(!protection_prerequisites_met(
            &serde_json::json!({"locked":true,"ipv6_disabled":false})
        ));
        assert!(!protection_prerequisites_met(
            &serde_json::json!({"locked":true})
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an installed claude-vm WSL distribution and writes only an isolated /tmp directory"]
    fn wsl_sync_copies_and_verifies_real_runtime_files() {
        let root = development_runtime();
        let scripts = guest_path(&root.join("scripts")).unwrap();
        let assets = guest_path(&root.join("assets")).unwrap();
        let mut files = script_manifest(&root.join("scripts")).unwrap();
        files.retain(|name, _| name == "entrypoint.sh");
        let mut asset_files = asset_manifest(&root.join("assets")).unwrap();
        asset_files.retain(|name, _| name == "novnc/desktop.html");
        let scratch = format!("/tmp/claude-vm-sync-test-{}", std::process::id());
        let script = sync_script_to(
            &scripts,
            &assets,
            &files,
            &asset_files,
            &format!("{scratch}/scripts"),
            &format!("{scratch}/assets"),
        );
        let target = shell_quote(&format!("{scratch}/scripts/entrypoint.sh"));
        let protected = format!(
            "set -eu\ntest ! -e {0}\ntrap 'rm -rf {0}' EXIT\nsync_once() {{\n{script}\n}}\nsync_once\ntouch -d @100 {target}\nsync_once\ntest \"$(stat -c %Y {target})\" = 100\nprintf corrupt > {target}\nsync_once\ntest \"$(stat -c %Y {target})\" != 100\nprintf 'REPAIR_OK\\n'\n",
            shell_quote(&scratch)
        );
        let command = bash_command(&protected);
        let result = run_wsl(&[
            "-d",
            "claude-vm",
            "-u",
            "root",
            "--",
            "bash",
            "-c",
            &command,
        ])
        .unwrap();
        assert!(result.status.success(), "{}", output_text(&result));
        assert!(output_text(&result)
            .lines()
            .any(|line| line.trim() == "SYNCED"));
        assert!(output_text(&result)
            .lines()
            .any(|line| line.trim() == "REPAIR_OK"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an installed claude-vm WSL distribution and writes only an isolated /tmp directory"]
    fn wsl_sync_rejects_mismatched_script_hash() {
        let root = development_runtime();
        let scripts = guest_path(&root.join("scripts")).unwrap();
        let assets = guest_path(&root.join("assets")).unwrap();
        let mut files = script_manifest(&root.join("scripts")).unwrap();
        files.retain(|name, _| name == "entrypoint.sh");
        *files.values_mut().next().unwrap() = "0".repeat(64);
        let mut asset_files = asset_manifest(&root.join("assets")).unwrap();
        asset_files.retain(|name, _| name == "novnc/desktop.html");
        let scratch = format!("/tmp/claude-vm-sync-fail-{}", std::process::id());
        let script = sync_script_to(
            &scripts,
            &assets,
            &files,
            &asset_files,
            &format!("{scratch}/scripts"),
            &format!("{scratch}/assets"),
        );
        let protected = format!(
            "set -eu\ntest ! -e {0}\ntrap 'rm -rf {0}' EXIT\n{script}",
            shell_quote(&scratch)
        );
        let command = bash_command(&protected);
        let result = run_wsl(&[
            "-d",
            "claude-vm",
            "-u",
            "root",
            "--",
            "bash",
            "-c",
            &command,
        ])
        .unwrap();
        assert!(!result.status.success());
        assert!(!output_text(&result)
            .lines()
            .any(|line| line.trim() == "SYNCED"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only checks on an existing running WSL desktop"]
    fn wsl_existing_session_health() {
        assert_eq!(read_guard_state().expect("guard check"), "guarded");
        verify_existing_desktop().expect("desktop check");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "restores a missing guard in an existing running WSL desktop"]
    fn wsl_recover_existing_guard() {
        verify_existing_desktop().expect("existing desktop");
        ensure_guard_running(&development_runtime()).expect("restore guard");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
        while std::time::Instant::now() < deadline {
            if read_guard_state().is_ok_and(|state| state == "guarded") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        panic!("guard did not confirm protection within the recovery period");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "stops the currently running claude-vm session"]
    fn wsl_stop_existing_session_with_missing_route_record() {
        let mut ops = WslStop;
        assert!(ops.is_running().unwrap());
        assert!(
            ops.can_terminate_without_restore().unwrap(),
            "fallback is not safe"
        );
        shutdown(&mut ops).expect("stop existing session");
        assert!(!ops.is_running().unwrap());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "starts and stops the existing WSL desktop using local configuration"]
    fn wsl_launch_and_safe_shutdown_with_existing_configuration() {
        let appdata = std::env::var_os("APPDATA").expect("APPDATA");
        let old_dir = PathBuf::from(appdata).join("claude-desktop");
        let raw = std::fs::read(old_dir.join("config.json")).expect("existing configuration");
        let old: serde_json::Value = serde_json::from_slice(&raw).expect("valid configuration");
        let field = |key: &str| {
            old.get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        let legacy = crate::WorkspaceConfig {
            yaml_path: field("clashYamlPath"),
            node: field("selectedNode"),
            workspace: field("workspace"),
            region: field("persona"),
        };
        let config = std::fs::read(
            PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"))
                .join("com.claudevm.workspace/workspace.json"),
        )
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or(legacy);
        let mut operations = WslLaunch::new(config, old_dir.join("runtime"), development_runtime());
        let started = (|| {
            macro_rules! timed {
                ($name:literal, $step:expr) => {{
                    let begin = std::time::Instant::now();
                    let result = $step;
                    eprintln!("{}: {:.2}s", $name, begin.elapsed().as_secs_f64());
                    result?;
                }};
            }
            timed!("validate", operations.validate());
            timed!(
                "existing-session",
                operations.ensure_stopped_and_port_free()
            );
            timed!("wsl", operations.ensure_runtime());
            timed!("sync", operations.sync_verified_resources());
            timed!("config", operations.install_network_config());
            timed!("spawn", operations.spawn_entrypoint());
            timed!("desktop", operations.await_desktop());
            timed!("guard", operations.verify_guard());
            Ok::<(), String>(())
        })();
        let diagnostic = if started.is_err() && operations.spawned {
            Some(guest_script("sed -n 's/^reason=//p' /run/claude-vm/net-guard.state | grep -E '^(ok|proxy-unreachable|exit-region-risk|split-exit|anthropic-unreachable|leak-detected|lock-failed)$' || true"))
        } else {
            None
        };
        let desktop_health = if started.is_ok() {
            Some(guest_script("set -eu\npgrep -x fcitx5 >/dev/null\nif command -v xdpyinfo >/dev/null 2>&1; then xdpyinfo -display :1 >/dev/null; fi\nprintf READY"))
        } else {
            None
        };
        let diagnostics_health = if started.is_ok() {
            Some(guest_script("set -eu\npython3 /opt/scripts/check-network.py | python3 -c 'import json,sys; x=json.load(sys.stdin); i=x[\"groups\"][0][\"items\"]; assert [v[\"label\"] for v in i]==[\"网络保护\",\"出口地区\"]; assert all(v[\"status\"]==\"pass\" for v in i)'\nprintf CHECKED"))
        } else {
            None
        };
        let sync_checks = if started.is_ok() {
            Some(std::panic::catch_unwind(|| {
                wsl_sync_copies_and_verifies_real_runtime_files();
                wsl_sync_rejects_mismatched_script_hash();
            }))
        } else {
            None
        };
        let recovery = if started.is_ok() {
            Some((|| -> Result<(), String> {
                guest_script("set -eu\np=$(cat /run/claude-vm/net-guard.pid)\nkill \"$p\"\nfor i in $(seq 1 60); do test -s /run/claude-vm/net-guard.pid || exit 0; sleep 0.1; done\nexit 1\n").map_err(|e| format!("stop test guard: {e}"))?;
                ensure_guard_running(&development_runtime())
                    .map_err(|e| format!("restart test guard: {e}"))?;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
                while std::time::Instant::now() < deadline {
                    if read_guard_state().is_ok_and(|state| state == "guarded") {
                        return Ok(());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                Err("恢复后的守卫未通过检查。".into())
            })())
        } else {
            None
        };
        let stopped = if operations.spawned {
            shutdown(&mut WslStop)
        } else {
            Ok(())
        };
        assert!(
            started.is_ok(),
            "launch: {started:?}; guard: {diagnostic:?}; cleanup: {stopped:?}"
        );
        assert!(stopped.is_ok(), "safe shutdown: {stopped:?}");
        assert!(
            desktop_health.is_some_and(|result| result.is_ok()),
            "desktop and input method should be running"
        );
        assert!(
            diagnostics_health.is_some_and(|result| result.is_ok()),
            "network or system diagnostics failed"
        );
        assert!(
            sync_checks.is_some_and(|result| result.is_ok()),
            "resource sync checks failed"
        );
        assert!(
            recovery.as_ref().is_some_and(|result| result.is_ok()),
            "guard recovery failed: {recovery:?}"
        );
    }
}
