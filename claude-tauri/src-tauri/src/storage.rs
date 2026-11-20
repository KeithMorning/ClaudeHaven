//! Platform-neutral storage status consumed by System Settings.

#[derive(serde::Serialize)]
pub struct StorageStatus {
    pub capacity_bytes: u64,
    pub allocated_bytes: u64,
    pub guest_available_bytes: Option<u64>,
    pub initialized: bool,
    pub growth: Option<StorageGrowth>,
}

#[derive(serde::Serialize)]
pub struct StorageGrowth {
    pub threshold_bytes: u64,
    pub limit_bytes: u64,
    pub pending_capacity_bytes: Option<u64>,
}

pub fn status(app: &tauri::AppHandle) -> Result<Option<StorageStatus>, String> {
    #[cfg(target_os = "macos")]
    {
        crate::runtime::macos::storage_status(&crate::mac_vm_data(app)?).map(Some)
    }
    // A Windows storage provider can return the same status when implemented.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(None)
    }
}
