//! Native Apple Silicon VM lifecycle. The guest control channel uses a private Unix socket.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::{
        fs::{DirBuilderExt, OpenOptionsExt},
        net::UnixStream,
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Session {
    process: Child,
    socket_dir: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.socket_dir);
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn available() -> bool {
    cfg!(target_arch = "aarch64")
}

pub fn resources_ready(root: &Path) -> bool {
    [
        "kernel",
        "initrd",
        "system.img.gz",
        "image-version",
        "haven-vm",
    ]
    .iter()
    .all(|name| root.join("native").join(name).is_file())
        && root.join("scripts").is_dir()
        && root.join("assets").is_dir()
}

pub fn registered(data: &Path) -> bool {
    data.join("data.img").is_file()
}

pub fn running() -> bool {
    SESSION
        .lock()
        .unwrap()
        .as_mut()
        .is_some_and(|session| matches!(session.process.try_wait(), Ok(None)))
}

pub fn exec(args: &[&str]) -> Result<Output, String> {
    exec_with_input(args, "")
}

fn exec_with_input(args: &[&str], input: &str) -> Result<Output, String> {
    let socket = SESSION
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Mac 虚拟机未运行。")?
        .socket_dir
        .join("control");
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    let timeout = Some(Duration::from_secs(50));
    stream
        .set_read_timeout(timeout)
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(timeout)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut stream, &(args, input)).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    BufReader::new(stream)
        .take(8 * 1024 * 1024)
        .read_until(b'\n', &mut response)
        .map_err(|e| e.to_string())?;
    let (code, stdout, stderr): (i32, String, String) =
        serde_json::from_slice(&response).map_err(|e| format!("虚拟机控制通道未返回结果：{e}"))?;
    Ok(Output {
        status: ExitStatus::from_raw(code.rem_euclid(256) << 8),
        stdout: stdout.into_bytes(),
        stderr: stderr.into_bytes(),
    })
}

fn stage_system(image: &Path, target: &Path, version: &[u8]) -> io::Result<()> {
    let marker = target.with_extension("version");
    if target.is_file() && fs::read(&marker).is_ok_and(|saved| saved == version) {
        return Ok(());
    }
    let tmp = target.with_extension("tmp");
    let mut output = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    let mut unzip = Command::new("/usr/bin/gzip")
        .arg("-dc")
        .arg(image)
        .stdout(Stdio::piped())
        .spawn()?;
    let result = (|| {
        let mut input = BufReader::with_capacity(1024 * 1024, unzip.stdout.take().unwrap());
        let mut size = 0;
        loop {
            let block = input.fill_buf()?;
            let count = block.len();
            if count == 0 {
                break;
            }
            if block.iter().all(|byte| *byte == 0) {
                output.seek(SeekFrom::Current(count as i64))?;
            } else {
                output.write_all(block)?;
            }
            size += count as u64;
            input.consume(count);
        }
        output.set_len(size)?;
        output.sync_all()
    })();
    if result.is_err() {
        let _ = unzip.kill();
    }
    let status = unzip.wait()?;
    result?;
    if !status.success() {
        return Err(io::Error::other("无法解压内置 Linux 镜像"));
    }
    fs::rename(tmp, target)?;
    fs::write(marker, version)
}

pub fn prepare(
    config: &crate::WorkspaceConfig,
    root: &Path,
    data: &Path,
    progress: &dyn Fn(&'static str),
) -> Result<(), String> {
    if !available() {
        return Err("此虚拟机镜像需要 Apple Silicon。".into());
    }
    prepare_vm(config, root, data, progress)
        .map_err(|e| format!("无法启动内置 Linux 虚拟机：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while running() && Instant::now() < deadline {
        if exec(&["/bin/true"]).is_ok_and(|o| o.status.success()) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?;
            let timestamp = format!("@{}", now.as_secs());
            let result = exec(&["/bin/date", "-u", "-s", &timestamp])?;
            return if result.status.success() {
                Ok(())
            } else {
                Err(format!(
                    "无法同步 Linux 虚拟机时钟：{}",
                    super::output_text(&result)
                ))
            };
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "Linux 未能在 60 秒内建立控制连接。启动日志：{}",
        data.join("boot.log").display()
    ))
}

fn prepare_vm(
    config: &crate::WorkspaceConfig,
    root: &Path,
    data: &Path,
    progress: &dyn Fn(&'static str),
) -> io::Result<()> {
    let mut session = SESSION.lock().unwrap();
    if let Some(old) = session.as_mut() {
        if old.process.try_wait()?.is_none() {
            return Err(io::Error::other("已有虚拟机正在运行"));
        }
    }
    *session = None;
    let workspace = fs::canonicalize(&config.workspace)?;
    let root = fs::canonicalize(root)?;
    let data_path = if data.is_absolute() {
        data.to_owned()
    } else {
        std::env::current_dir()?.join(data)
    };
    if data_path.starts_with(&workspace)
        || root.starts_with(&workspace)
        || workspace.starts_with(&root)
    {
        return Err(io::Error::other("请选择不包含应用资源或虚拟机数据的工作区"));
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&data_path)?;
    let native = root.join("native");
    let system = data_path.join("system.img");
    progress("mac-image");
    stage_system(
        &native.join("system.img.gz"),
        &system,
        &fs::read(native.join("image-version"))?,
    )?;
    progress("mac-boot");
    let persistent = data_path.join("data.img");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&persistent)
    {
        Ok(file) => file.set_len(8 * 1024 * 1024 * 1024)?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let serial = File::create(data_path.join("boot.log"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let socket_dir = PathBuf::from(format!("/tmp/haven-{}-{nonce:x}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&socket_dir)?;
    let child = Command::new(native.join("haven-vm"))
        .arg(native.join("kernel"))
        .arg(native.join("initrd"))
        .arg(system)
        .arg(persistent)
        .arg(workspace)
        .arg(root)
        .arg(socket_dir.join("control"))
        .stdin(Stdio::piped())
        .stderr(serial.try_clone()?)
        .stdout(serial)
        .spawn();
    match child {
        Ok(process) => {
            *session = Some(Session {
                process,
                socket_dir,
            })
        }
        Err(error) => {
            let _ = fs::remove_dir(&socket_dir);
            return Err(error);
        }
    }
    Ok(())
}

pub fn stop() -> Result<(), String> {
    let mut lock = SESSION.lock().unwrap();
    let Some(session) = lock.as_mut() else {
        return Ok(());
    };
    drop(session.process.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(22);
    while Instant::now() < deadline {
        if session
            .process
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            *lock = None;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("Mac 虚拟机尚未停止，请查看启动日志。".into())
}

pub fn reset(data: &Path) -> Result<(), String> {
    stop()?;
    match fs::remove_dir_all(data) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn install_config(config: &crate::WorkspaceConfig) -> Result<(), String> {
    use base64::Engine;
    let bytes = fs::read(&config.yaml_path).map_err(|e| e.to_string())?;
    // Pass the data as a separate JSON argument, not as a large shell command.
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let result = exec_with_input(&["/usr/bin/python3", "-c",
        "import base64, os, pathlib, sys; os.umask(0o077); p=pathlib.Path('/opt/config/clash.yaml'); p.parent.mkdir(parents=True, exist_ok=True); tmp=p.with_suffix('.tmp'); tmp.write_bytes(base64.b64decode(sys.stdin.buffer.read())); tmp.chmod(0o600); tmp.replace(p); pathlib.Path('/run/claude-vm/ready').unlink(missing_ok=True)",
        ], &encoded)?;
    if result.status.success() {
        Ok(())
    } else {
        Err(super::output_text(&result))
    }
}
