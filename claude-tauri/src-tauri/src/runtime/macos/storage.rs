use crate::storage::{StorageGrowth, StorageStatus};
use std::{fs, io, os::unix::fs::MetadataExt, path::Path, process::Command, time::Duration};

const GIB: u64 = 1024 * 1024 * 1024;
pub(super) const INITIAL_BYTES: u64 = 2 * GIB;
const LOW_SPACE_BYTES: u64 = GIB;
const LIMIT_BYTES: u64 = 16 * GIB;
const MIN_HOST_FREE_BYTES: u64 = 2 * GIB;
const PENDING: &str = "state-growth.pending";

fn pending_capacity(data: &Path, capacity: u64) -> Option<u64> {
    let target = fs::read_to_string(data.join(PENDING))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let next = capacity.saturating_mul(2).min(LIMIT_BYTES);
    (target == capacity || (next > capacity && target == next)).then_some(target)
}

pub(super) fn status(data: &Path, available: Option<u64>) -> io::Result<StorageStatus> {
    let (capacity, allocated, initialized) = match fs::metadata(data.join("state.img")) {
        Ok(meta) => (meta.len(), meta.blocks().saturating_mul(512), true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (INITIAL_BYTES, 0, false),
        Err(error) => return Err(error),
    };
    Ok(StorageStatus {
        capacity_bytes: capacity,
        allocated_bytes: allocated,
        guest_available_bytes: available,
        initialized,
        growth: Some(StorageGrowth {
            threshold_bytes: LOW_SPACE_BYTES,
            limit_bytes: LIMIT_BYTES,
            pending_capacity_bytes: initialized
                .then(|| pending_capacity(data, capacity))
                .flatten()
                .filter(|target| *target > capacity),
        }),
    })
}

pub(super) fn growth_target(data: &Path, capacity: u64) -> Option<u64> {
    let target = pending_capacity(data, capacity)?;
    if target <= capacity {
        return None;
    }
    let output = Command::new("/bin/df")
        .env("LC_ALL", "C")
        .arg("-Pk")
        .arg(data)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = std::str::from_utf8(&output.stdout).ok()?;
    let available_kib: u64 = stdout
        .lines()
        .last()?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()?;
    (available_kib >= MIN_HOST_FREE_BYTES / 1024).then_some(target)
}

pub(super) fn sample(socket: &Path, data: &Path) -> Result<u64, String> {
    let output = super::exec_at(
        socket,
        &["/bin/sh", "-c", "mountpoint -q /var/lib/haven-data && LC_ALL=C df -k --output=avail /var/lib/haven-data"],
        "",
        Duration::from_secs(2),
    )?;
    if !output.status.success() {
        return Err("无法读取虚拟机磁盘剩余空间。".into());
    }
    let available = std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|text| text.lines().last())
        .and_then(|line| line.trim().parse::<u64>().ok())
        .and_then(|kib| kib.checked_mul(1024))
        .ok_or("无法解析虚拟机磁盘剩余空间。")?;
    let capacity = fs::metadata(data.join("state.img"))
        .map_err(|e| e.to_string())?
        .len();
    let pending = pending_capacity(data, capacity);
    if available >= LOW_SPACE_BYTES && pending.is_some_and(|target| target > capacity) {
        clear_pending(data)?;
    } else if available < LOW_SPACE_BYTES && capacity < LIMIT_BYTES && pending.is_none() {
        let target = capacity.saturating_mul(2).min(LIMIT_BYTES);
        let temp = data.join("state-growth.tmp");
        fs::write(&temp, target.to_string())
            .and_then(|_| fs::rename(&temp, data.join(PENDING)))
            .map_err(|e| format!("无法记录虚拟机扩容计划：{e}"))?;
    }
    Ok(available)
}

pub(super) fn resize_guest(data: &Path) -> Result<(), String> {
    let capacity = fs::metadata(data.join("state.img"))
        .map_err(|e| e.to_string())?
        .len();
    if capacity <= INITIAL_BYTES {
        return Ok(());
    }
    // The guest has mounted ext4 and replayed its journal before accepting control commands.
    // resize2fs is a no-op at full size and can retry after an interrupted launch.
    let output = super::exec(&["/bin/sh", "-c", concat!(
        "set -eu; ",
        "test \"$(findmnt -n -o SOURCE,FSTYPE --mountpoint /var/lib/haven-data)\" = '/dev/vdb ext4'; ",
        "/usr/sbin/resize2fs /dev/vdb"
    )])?;
    if !output.status.success() {
        return Err(format!(
            "无法扩展虚拟机文件系统：{}",
            super::super::output_text(&output)
        ));
    }
    if pending_capacity(data, capacity) == Some(capacity) {
        clear_pending(data)?;
    }
    Ok(())
}

fn clear_pending(data: &Path) -> Result<(), String> {
    match fs::remove_file(data.join(PENDING)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除虚拟机扩容计划：{error}")),
    }
}
