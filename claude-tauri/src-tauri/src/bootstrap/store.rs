use super::state::BootstrapSnapshot;
use std::fs;
use std::path::Path;

pub fn load(path: &Path) -> Result<BootstrapSnapshot, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BootstrapSnapshot::default())
        }
        Err(error) => return Err(format!("无法读取初始化状态：{error}")),
    };
    let snapshot: BootstrapSnapshot =
        serde_json::from_slice(&bytes).map_err(|e| format!("初始化状态文件损坏：{e}"))?;
    if snapshot.schema_version != 1 {
        return Err("初始化状态版本不受支持，请导出诊断后重试。".into());
    }
    Ok(snapshot)
}

pub fn save(path: &Path, snapshot: &BootstrapSnapshot) -> Result<(), String> {
    let parent = path.parent().ok_or("初始化状态目录无效。")?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建初始化状态目录：{e}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
    fs::write(&temporary, bytes).map_err(|e| format!("无法写入初始化状态：{e}"))?;
    replace_atomically(&temporary, path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "无法原子更新初始化状态：{}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|e| format!("无法原子更新初始化状态：{e}"))
}

#[cfg(windows)]
pub struct BootstrapLock(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl BootstrapLock {
    pub fn acquire() -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        let name = std::ffi::OsStr::new("Local\\ClaudeHavenBootstrap")
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "无法创建初始化互斥锁：{}",
                std::io::Error::last_os_error()
            ));
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(Self(handle))
        } else {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            Err("另一实例正在执行环境初始化。".into())
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::BootstrapLock;

    #[test]
    fn bootstrap_mutex_rejects_a_second_process_owner() {
        const CHILD: &str = "CLAUDE_HAVEN_MUTEX_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            assert!(BootstrapLock::acquire().is_err());
            return;
        }
        let first = BootstrapLock::acquire().expect("first bootstrap task owns the lock");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "bootstrap::store::tests::bootstrap_mutex_rejects_a_second_process_owner",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .status()
            .expect("start a separate test process");
        assert!(status.success());
        drop(first);
        assert!(BootstrapLock::acquire().is_ok());
    }
}

#[cfg(windows)]
impl Drop for BootstrapLock {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
pub struct BootstrapLock;

#[cfg(not(windows))]
impl BootstrapLock {
    pub fn acquire() -> Result<Self, String> {
        Ok(Self)
    }
}
