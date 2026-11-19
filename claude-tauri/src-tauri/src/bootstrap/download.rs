use super::state::BootstrapErrorCode;
use super::state::DownloadProgress;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct TransferError {
    pub code: BootstrapErrorCode,
    pub message: String,
}

impl TransferError {
    pub fn new(code: BootstrapErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn network(message: String) -> Self {
        Self::new(BootstrapErrorCode::Network, message)
    }
}

impl From<String> for TransferError {
    fn from(message: String) -> Self {
        Self::new(BootstrapErrorCode::DownloadFailed, message)
    }
}

impl From<TransferError> for String {
    fn from(error: TransferError) -> Self {
        error.message
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct WslRelease {
    pub tag: String,
    pub version: String,
    pub asset_name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub architecture: String,
    pub minimum_windows_build: u32,
    pub publisher: String,
}

pub fn release() -> WslRelease {
    serde_json::from_str(include_str!("wsl-release.json")).expect("wsl-release.json must be valid")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResumeAction {
    Start,
    Resume(u64),
    Restart,
}

fn resume_action(part_len: u64, etag_matches: bool, accepts_ranges: bool) -> ResumeAction {
    if part_len == 0 {
        ResumeAction::Start
    } else if etag_matches && accepts_ranges {
        ResumeAction::Resume(part_len)
    } else {
        ResumeAction::Restart
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    use reqwest::redirect::{Attempt, Policy};
    let policy = Policy::custom(|attempt: Attempt<'_>| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        let url = attempt.url();
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let trusted = url.scheme() == "https"
            && (host == "github.com"
                || host == "githubusercontent.com"
                || host.ends_with(".githubusercontent.com"));
        if trusted {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 60))
        .redirect(policy)
        .build()
        .map_err(|e| format!("无法初始化安全下载：{e}"))
}

fn send_with_retry(
    request: reqwest::blocking::RequestBuilder,
    label: &str,
) -> Result<reqwest::blocking::Response, TransferError> {
    for attempt in 0..3 {
        let copy = request
            .try_clone()
            .ok_or_else(|| format!("无法重试{label}请求。"))?;
        match copy.send() {
            Ok(response) if response.status().is_server_error() && attempt < 2 => {
                thread::sleep(Duration::from_millis(250 * (attempt + 1) as u64));
            }
            Ok(response) => return Ok(response),
            Err(error) if attempt < 2 => {
                thread::sleep(Duration::from_millis(250 * (attempt + 1) as u64));
                let _ = error;
            }
            Err(error) => {
                return Err(TransferError::network(format!(
                    "{label}失败（已重试 2 次）：{}",
                    error.without_url()
                )))
            }
        }
    }
    Err(TransferError::network(format!(
        "{label}失败（已重试 2 次）。"
    )))
}

fn check_head_size(
    headers: &reqwest::header::HeaderMap,
    expected: u64,
) -> Result<(), TransferError> {
    if let Some(length) = headers.get(reqwest::header::CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok());
        if length != Some(expected) {
            return Err(TransferError::new(
                BootstrapErrorCode::SizeMismatch,
                format!("官方 WSL 资源大小与清单不符（预期 {expected} 字节）。"),
            ));
        }
    }
    Ok(())
}

pub fn download_msi(
    cache_dir: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf, TransferError> {
    let release = release();
    fs::create_dir_all(cache_dir).map_err(|e| format!("无法创建下载缓存目录：{e}"))?;
    let target = cache_dir.join(&release.asset_name);
    let part = cache_dir.join(format!("{}.part", release.asset_name));
    let etag_path = cache_dir.join(format!("{}.etag", release.asset_name));
    if verify_size_hash(&target, &release).is_ok() {
        return Ok(target);
    }
    if target.exists() {
        let _ = fs::remove_file(&target);
    }

    let client = client().map_err(TransferError::network)?;
    let head = send_with_retry(client.head(&release.url), "连接微软官方 WSL 下载")?;
    if !head.status().is_success() {
        return Err(TransferError::network(format!(
            "微软官方 WSL 下载返回 HTTP {}。",
            head.status()
        )));
    }
    check_head_size(head.headers(), release.size_bytes)?;
    let etag = head
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let accepts_ranges = head
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("bytes"));
    let old_etag = fs::read_to_string(&etag_path).ok();
    let part_len = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let action = resume_action(
        part_len,
        etag.as_deref().is_some_and(|v| v.starts_with('"'))
            && etag == old_etag
            && part_len < release.size_bytes,
        accepts_ranges,
    );
    let offset = match action {
        ResumeAction::Start => 0,
        ResumeAction::Resume(offset) => offset,
        ResumeAction::Restart => {
            let _ = fs::remove_file(&part);
            0
        }
    };
    let mut request = client.get(&release.url);
    if offset > 0 {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .header(
                reqwest::header::IF_RANGE,
                etag.as_deref().unwrap_or_default(),
            );
    }
    let mut response = send_with_retry(request, "下载 WSL 安装包")?;
    let expected_range = format!(
        "bytes {offset}-{}/{}",
        release.size_bytes - 1,
        release.size_bytes
    );
    let valid_range = response.status() == reqwest::StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            == Some(expected_range.as_str())
        && response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            == etag.as_deref();
    let offset = if offset > 0 && valid_range {
        offset
    } else {
        if offset > 0
            && matches!(
                response.status(),
                reqwest::StatusCode::RANGE_NOT_SATISFIABLE | reqwest::StatusCode::PARTIAL_CONTENT
            )
        {
            drop(response);
            response = send_with_retry(client.get(&release.url), "重新下载 WSL 安装包")?;
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(TransferError::network(format!(
                "官方下载返回 HTTP {}。",
                response.status()
            )));
        }
        // A fresh request can return a different validator than HEAD.
        match response.headers().get(reqwest::header::ETAG) {
            Some(value) => fs::write(&etag_path, value.as_bytes())
                .map_err(|e| format!("无法保存下载校验信息：{e}"))?,
            None => {
                let _ = fs::remove_file(&etag_path);
            }
        }
        0
    };
    response_to_file(
        response,
        &part,
        offset,
        release.size_bytes,
        cancelled,
        &mut progress,
    )?;
    if let Err(error) = verify_size_hash(&part, &release) {
        if error.code == BootstrapErrorCode::HashMismatch {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&etag_path);
        }
        return Err(error);
    }
    fs::rename(&part, &target).map_err(|e| format!("下载完成但无法保存安装包：{e}"))?;
    let _ = fs::remove_file(etag_path);
    Ok(target)
}

fn response_to_file(
    mut response: reqwest::blocking::Response,
    path: &Path,
    offset: u64,
    total: u64,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(DownloadProgress),
) -> Result<(), TransferError> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(path)
        .map_err(|e| format!("无法写入 WSL 安装包缓存：{e}"))?;
    let mut downloaded = offset;
    let mut buffer = vec![0_u8; 1024 * 256];
    let start = Instant::now();
    let mut last_report = start;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(TransferError::new(
                BootstrapErrorCode::DownloadCancelled,
                "WSL 安装包下载已取消。",
            ));
        }
        let count = response
            .read(&mut buffer)
            .map_err(|e| TransferError::network(format!("下载过程中网络中断：{e}")))?;
        if count == 0 {
            break;
        }
        if downloaded.saturating_add(count as u64) > total {
            return Err(TransferError::new(
                BootstrapErrorCode::SizeMismatch,
                "官方下载内容超过审核清单大小，已中止。",
            ));
        }
        file.write_all(&buffer[..count])
            .map_err(|e| format!("写入 WSL 安装包缓存失败：{e}"))?;
        downloaded += count as u64;
        let elapsed = start.elapsed().as_secs_f64().max(0.001);
        if last_report.elapsed() >= Duration::from_millis(250) {
            progress(DownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: Some(total),
                bytes_per_second: (downloaded.saturating_sub(offset) as f64 / elapsed) as u64,
            });
            last_report = Instant::now();
        }
    }
    file.sync_all()
        .map_err(|e| format!("无法完成 WSL 安装包缓存：{e}"))?;
    progress(DownloadProgress {
        downloaded_bytes: downloaded,
        total_bytes: Some(total),
        bytes_per_second: (downloaded.saturating_sub(offset) as f64
            / start.elapsed().as_secs_f64().max(0.001)) as u64,
    });
    Ok(())
}

pub fn verify_size_hash(path: &Path, release: &WslRelease) -> Result<(), TransferError> {
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取 WSL 安装包：{e}"))?;
    if metadata.len() != release.size_bytes {
        return Err(TransferError::new(
            BootstrapErrorCode::SizeMismatch,
            format!(
                "WSL 安装包大小不符：预期 {} 字节，实际 {} 字节。",
                release.size_bytes,
                metadata.len()
            ),
        ));
    }
    let mut file = File::open(path).map_err(|e| format!("无法读取 WSL 安装包：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("校验 WSL 安装包失败：{e}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(&release.sha256) {
        return Err(TransferError::new(
            BootstrapErrorCode::HashMismatch,
            format!("WSL 安装包 SHA-256 不符：{actual}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{release, resume_action, verify_size_hash, ResumeAction, WslRelease};

    #[test]
    fn head_uses_the_asset_header_and_accepts_an_unknown_length() {
        use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH};
        let mut headers = HeaderMap::new();
        assert!(super::check_head_size(&headers, 100).is_ok());
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("100"));
        assert!(super::check_head_size(&headers, 100).is_ok());
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("0"));
        assert_eq!(
            super::check_head_size(&headers, 100).unwrap_err().code,
            super::BootstrapErrorCode::SizeMismatch,
        );
    }

    #[test]
    fn release_manifest_pins_the_reviewed_x64_asset() {
        let asset = release();
        assert_eq!(asset.tag, "3.0.5");
        assert_eq!(asset.asset_name, "wsl.3.0.5.0.x64.msi");
        assert_eq!(asset.size_bytes, 367_788_032);
        assert_eq!(asset.architecture, "x64");
        assert!(asset
            .url
            .starts_with("https://github.com/microsoft/WSL/releases/"));
    }

    #[test]
    fn interrupted_download_resumes_only_with_matching_etag_and_range_support() {
        assert_eq!(resume_action(0, false, false), ResumeAction::Start);
        assert_eq!(resume_action(120, true, true), ResumeAction::Resume(120));
        assert_eq!(resume_action(120, false, true), ResumeAction::Restart);
        assert_eq!(resume_action(120, true, false), ResumeAction::Restart);
    }

    #[test]
    fn integrity_check_rejects_modified_or_truncated_assets() {
        use sha2::{Digest, Sha256};
        let bytes = b"verified test asset";
        let path = std::env::temp_dir().join(format!(
            "claude-haven-integrity-{}-{}.msi",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).expect("write fixture");
        let asset = WslRelease {
            tag: "test".into(),
            version: "test".into(),
            asset_name: "test.msi".into(),
            url: "https://github.com/microsoft/WSL/releases/test".into(),
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            architecture: "x64".into(),
            minimum_windows_build: 19041,
            publisher: "Microsoft Corporation".into(),
        };
        assert!(verify_size_hash(&path, &asset).is_ok());
        let mut modified = asset.clone();
        modified.sha256 = "00".repeat(32);
        assert!(verify_size_hash(&path, &modified)
            .unwrap_err()
            .message
            .contains("SHA-256"));
        let mut truncated = asset;
        truncated.size_bytes += 1;
        assert!(verify_size_hash(&path, &truncated)
            .unwrap_err()
            .message
            .contains("大小"));
        let _ = std::fs::remove_file(path);
    }
}
