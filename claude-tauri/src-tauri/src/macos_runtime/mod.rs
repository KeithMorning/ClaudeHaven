//! macOS developer runtime using Lima's Virtualization.framework driver.
use crate::{runtime, LaunchOutcome, RuntimeStatus, WorkspaceConfig};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const VM: &str = "desktop";
const GUEST_ROOT: &str = "/var/lib/claude-haven/rootfs";
const DESKTOP: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 6080);
const ROOTFS: &str = if cfg!(target_arch = "aarch64") {
    "rootfs-linux-arm64.tar.gz"
} else {
    "rootfs.tar.gz"
};

struct Lima {
    executable: PathBuf,
    home: PathBuf,
}

impl Lima {
    fn discover() -> Result<Self, String> {
        let executable = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .chain([
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ])
            .map(|directory| directory.join("limactl"))
            .find(|path| path.is_absolute() && path.is_file())
            .ok_or("请先安装 Lima（brew install lima），再刷新运行环境。")?;
        let home = std::env::var_os("HOME").ok_or("找不到当前用户的主目录。")?;
        Ok(Self {
            executable,
            home: PathBuf::from(home).join(".claude-haven-lima"),
        })
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.env("LIMA_HOME", &self.home);
        command
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        let result = self
            .command()
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        output(result)
    }

    fn state(&self) -> Result<Option<String>, String> {
        if !self.home.join(VM).join("lima.yaml").is_file() {
            return Ok(None);
        }
        self.run(&["list", "--format", "{{.Status}}", VM])
            .map(|value| Some(value.trim().to_owned()))
    }

    fn guest(&self, program: &str) -> Result<String, String> {
        let mut child = self
            .command()
            .args(["shell", "--workdir", "/", VM, "sudo", "-n", "bash", "-se"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let write = child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(program.as_bytes());
        let result = child.wait_with_output().map_err(|e| e.to_string())?;
        let text = output(result)?;
        write.map_err(|e| e.to_string())?;
        Ok(text)
    }

    fn desktop_guest(&self, program: &str) -> Result<String, String> {
        let encoded = STANDARD.encode(program);
        self.guest(&format!(
            "printf '%s' '{encoded}' | base64 -d | chroot {GUEST_ROOT} /bin/bash -se\n"
        ))
    }

    fn desktop_ready(&self) -> bool {
        TcpStream::connect_timeout(&DESKTOP, Duration::from_millis(300)).is_ok()
            && self
                .desktop_guest(
                    "test -f /run/claude-vm/ready\npgrep -f '[w]ebsockify --web=' >/dev/null\n",
                )
                .is_ok()
    }
}

fn output(result: Output) -> Result<String, String> {
    if result.status.success() {
        Ok(String::from_utf8_lossy(&result.stdout).into_owned())
    } else {
        let error = String::from_utf8_lossy(&result.stderr);
        Err(format!(
            "macOS 虚拟环境操作失败（{}）：{}",
            result.status,
            error.trim()
        ))
    }
}

fn resources_available(resources: &Path) -> bool {
    resources.join(ROOTFS).is_file()
        && resources.join("scripts/entrypoint.sh").is_file()
        && resources.join("assets/novnc/desktop.html").is_file()
}

pub(crate) fn status(resources: &Path) -> RuntimeStatus {
    let lima = Lima::discover();
    let (state, message) = match &lima {
        Ok(lima) => match lima.state() {
            Ok(state) => (state, None),
            Err(error) => (None, Some(error)),
        },
        Err(error) => (None, Some(error.clone())),
    };
    let running = state.as_deref() == Some("Running");
    let runtime_available = message.is_none();
    RuntimeStatus {
        platform: "macos",
        platform_message: message,
        runtime_available,
        environment_exists: state.is_some(),
        session_running: running,
        desktop_available: running && lima.is_ok_and(|lima| lima.desktop_ready()),
        runtime_resources_available: resources_available(resources),
        host_probe: None,
    }
}

fn start_inner(
    lima: &Lima,
    config: WorkspaceConfig,
    resources: &Path,
    progress: impl Fn(&str),
) -> Result<(), String> {
    if !resources_available(resources) {
        return Err(format!(
            "缺少运行时资源，请将 {ROOTFS} 放到 claude-tauri/runtime/。"
        ));
    }
    crate::validate_exit_node(&config)?;
    let yaml = std::fs::read(&config.yaml_path).map_err(|_| "无法读取网络配置文件。")?;
    let workspace = std::fs::canonicalize(&config.workspace).map_err(|_| "工作区目录不存在。")?;
    let resources = std::fs::canonicalize(resources).map_err(|_| "运行时目录不存在。")?;
    if !workspace.is_dir()
        || workspace.starts_with(&resources)
        || resources.starts_with(&workspace)
        || workspace.starts_with(&lima.home)
        || lima.home.starts_with(&workspace)
    {
        return Err("请选择与应用运行时目录独立的工作区。".into());
    }
    let mounts = serde_json::json!([
        { "location": resources, "mountPoint": "/mnt/haven-runtime", "writable": false },
        { "location": workspace, "mountPoint": "/mnt/haven-workspace", "writable": true }
    ]);
    let mounts = format!(".mounts = {mounts}");
    let state = lima.state()?;
    if state.as_deref().is_some_and(|state| state != "Stopped") {
        return Err("已有 Mac 虚拟环境运行中或正在切换状态，请先停止环境。".into());
    }
    TcpListener::bind(DESKTOP).map_err(|_| "本机桌面端口 6080 已被占用。")?;
    progress("preparing");
    if state.is_some() {
        lima.run(&["edit", "--tty=false", "--set", &mounts, VM])?;
        lima.run(&["start", "--tty=false", VM])?;
    } else {
        lima.run(&[
            "start", "--tty=false", "--name", VM, "--vm-type=vz", "--mount-type=virtiofs",
            "--set", &mounts, "--set", ".containerd = {\"system\": false, \"user\": false}",
            "--set", ".portForwards = [{\"guestPort\":6080,\"guestIP\":\"127.0.0.1\",\"hostPort\":6080,\"hostIP\":\"127.0.0.1\"},{\"guestPortRange\":[1,65535],\"ignore\":true}]",
            "template:ubuntu-24.04",
        ])?;
    }
    let (lang, chrome) = match config.language {
        crate::EnvironmentLanguage::English => ("en_US.UTF-8", "en-US"),
        crate::EnvironmentLanguage::SimplifiedChinese => ("zh_CN.UTF-8", "zh-CN"),
        crate::EnvironmentLanguage::TraditionalChinese => ("zh_TW.UTF-8", "zh-TW"),
    };
    let quote = runtime::shell_quote;
    let program = format!(
        "archive={}\nproxy={}\nnode={}\ntimezone={}\nlang={}\nchrome={}\n{}",
        quote(ROOTFS),
        quote(&STANDARD.encode(yaml)),
        quote(&config.node),
        quote(&config.timezone),
        quote(lang),
        quote(chrome),
        include_str!("guest.sh")
    );
    lima.guest(&program)?;
    progress("desktop-starting");
    let deadline = Instant::now() + Duration::from_secs(100);
    loop {
        if lima.desktop_ready() {
            wait_for_guard(lima)?;
            progress("desktop-ready");
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(
                "Mac 虚拟桌面启动超时，请查看 Lima 虚拟机中 claude-haven-desktop 服务的日志。"
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(800));
    }
}

pub(crate) fn start(
    config: WorkspaceConfig,
    resources: &Path,
    progress: impl Fn(&str),
) -> LaunchOutcome {
    let result = Lima::discover().and_then(|lima| start_inner(&lima, config, resources, progress));
    match result {
        Ok(()) => LaunchOutcome {
            ok: true,
            needs_stop: false,
            error: String::new(),
        },
        Err(error) => LaunchOutcome {
            ok: false,
            needs_stop: Lima::discover()
                .and_then(|lima| lima.state())
                .is_ok_and(|state| state.as_deref() == Some("Running")),
            error,
        },
    }
}

fn wait_for_guard(lima: &Lima) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if let Ok(report) = read_guard_details(lima) {
            match report["state"].as_str() {
                Some("guarded") => return Ok(()),
                Some("blocked" | "off") => break,
                _ => {}
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(800));
    }
    Err("网络保护未通过检查，请检查代理配置后重新启动虚拟环境。".into())
}

pub(crate) fn restore() -> Result<(), String> {
    let lima = Lima::discover()?;
    if !lima.desktop_ready() {
        return Err("已有虚拟桌面未就绪，请停止后重新启动。".into());
    }
    wait_for_guard(&lima)
}

pub(crate) fn guard_status() -> Result<serde_json::Value, String> {
    read_guard_details(&Lima::discover()?)
}

fn read_guard_details(lima: &Lima) -> Result<serde_json::Value, String> {
    let raw = lima.desktop_guest(
        r#"
test -s /run/claude-vm/net-guard.pid
kill -0 "$(cat /run/claude-vm/net-guard.pid)"
cat /run/claude-vm/net-guard.state
if test -r /run/claude-vm/session-timezone; then cat /run/claude-vm/session-timezone; fi
"#,
    )?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let state = runtime::parse_guard_state(&raw, now)?;
    if state == "guarded" {
        let prerequisites = lima.desktop_guest(
            r#"
pgrep -x mihomo >/dev/null
grep -qE '^ *Meta:' /proc/net/dev
test "$(awk '/^nameserver[[:space:]]/{print $2}' /etc/resolv.conf)" = 127.0.0.1
python3 /opt/scripts/net-guard.py status
"#,
        )?;
        let status = serde_json::from_str(&prerequisites).map_err(|_| "无法读取网络保护条件。")?;
        if !runtime::protection_prerequisites_met(&status) {
            return Err("网络保护条件未全部满足。".into());
        }
    }
    let field = |key| {
        raw.lines().find_map(|line| {
            let (name, value) = line.split_once('=')?;
            (name == key).then_some(value)
        })
    };
    Ok(serde_json::json!({
        "state": state,
        "exit_country": if state == "guarded" { field("exit_country") } else { None },
        "exit_city": if state == "guarded" { field("exit_city") } else { None },
        "exit_timezone": if state == "guarded" { field("exit_timezone") } else { None },
        "active_timezone": field("active_timezone"),
        "timezone_source": field("timezone_source"),
    }))
}

pub(crate) fn check_network() -> Result<Vec<serde_json::Value>, String> {
    let lima = Lima::discover()?;
    wait_for_guard(&lima)?;
    let report = lima.desktop_guest("python3 /opt/scripts/check-network.py\n")?;
    let report: serde_json::Value =
        serde_json::from_str(&report).map_err(|_| "无法解析网络检查结果。")?;
    if report.get("runtimeUp").and_then(serde_json::Value::as_i64) != Some(1) {
        return Err("虚拟桌面未就绪，检查结果不完整。".into());
    }
    let groups = crate::network_groups(&report);
    if groups.is_empty() {
        return Err("没有获取到网络检查结果。".into());
    }
    Ok(groups)
}

pub(crate) fn stop() -> Result<(), String> {
    let lima = match Lima::discover() {
        Ok(lima) => lima,
        Err(_) => return Ok(()),
    };
    if lima.state()?.is_some_and(|state| state != "Stopped") {
        lima.run(&["stop", "--tty=false", VM])?;
    }
    Ok(())
}
