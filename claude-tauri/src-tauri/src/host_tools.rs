use crate::{load_config, mac_vm_data, take_runtime_lock, HostTool, HostToolsStatus};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

const GRANT_FILE: &str = "host-npm.json";

#[derive(Deserialize, Serialize)]
struct Grant {
    workspace: PathBuf,
    tools: Option<BTreeMap<String, PathBuf>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    disabled: BTreeMap<String, PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    node: Option<PathBuf>,
    #[serde(
        default,
        rename = "allowBuild",
        skip_serializing_if = "Option::is_none"
    )]
    allow_build: Option<bool>,
}

fn read_grant(path: &Path) -> Result<Option<Grant>, String> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法读取 Mac 工具授权：{e}")),
    };
    let info = file.metadata().map_err(|e| e.to_string())?;
    if !info.is_file()
        || info.uid() != unsafe { libc::getuid() }
        || info.permissions().mode() & 0o077 != 0
        || info.len() > 16_384
    {
        return Err("Mac 工具授权必须是当前用户所有的私有文件，权限为 600。".into());
    }
    let mut bytes = Vec::new();
    file.take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16_384 {
        return Err("Mac 工具授权文件过大。".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("Mac 工具授权格式无效：{e}"))
}

pub fn status(app: &tauri::AppHandle) -> Result<HostToolsStatus, String> {
    let data = mac_vm_data(app)?;
    let workspace = load_config(app.clone())?.workspace;
    let grant = read_grant(&data.join(GRANT_FILE))?;
    let saved = fs::canonicalize(&workspace).ok();
    let matches = grant.as_ref().is_some_and(|grant| {
        saved
            .as_ref()
            .is_some_and(|saved| fs::canonicalize(&grant.workspace).ok().as_ref() == Some(saved))
    });
    let legacy = grant.as_ref().is_some_and(|grant| grant.tools.is_none());
    let mut tools = Vec::new();
    let mut suggested = Vec::new();
    if let Some(grant) = &grant {
        if let Some(enabled) = &grant.tools {
            tools.extend(enabled.iter().map(|(name, path)| tool(name, path, true)));
            tools.extend(
                grant
                    .disabled
                    .iter()
                    .map(|(name, path)| tool(name, path, false)),
            );
        } else if let Some(node) = &grant.node {
            tools.push(tool("node", node, true));
            tools.push(tool("npm", &node.with_file_name("npm"), true));
        }
    } else if let Some(saved) = &saved {
        tools.extend(
            default_tools(saved, &data)
                .iter()
                .map(|(name, path)| tool(name, path, false)),
        );
    }
    if matches && !legacy {
        if let Some(saved) = &saved {
            suggested.extend(
                default_tools(saved, &data)
                    .iter()
                    .filter(|(name, _)| !tools.iter().any(|tool| &tool.name == *name))
                    .map(|(name, path)| tool(name, path, false)),
            );
        }
    }
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(HostToolsStatus {
        configured: grant.is_some(),
        workspace,
        matches,
        legacy,
        tools,
        suggested,
    })
}

fn tool(name: &str, path: &Path, enabled: bool) -> HostTool {
    HostTool {
        name: name.to_owned(),
        path: path.display().to_string(),
        enabled,
    }
}

fn nvm_bins(root: &Path) -> Vec<PathBuf> {
    let mut versions: Vec<_> = fs::read_dir(root.join("versions/node"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let version = name.to_str()?.strip_prefix('v')?;
            let parts: Vec<u32> = version
                .split('.')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            let version: [u32; 3] = parts.try_into().ok()?;
            Some((version, entry.path().join("bin")))
        })
        .collect();
    versions.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, path)| path).collect()
}

fn valid_executable(path: &Path, workspace: &Path, data: &Path) -> bool {
    let outside = |path: &Path| !path.starts_with(workspace) && !path.starts_with(data);
    path.is_absolute()
        && outside(path)
        && path.to_str().is_some_and(|path| !path.contains(':'))
        && path
            .parent()
            .and_then(|parent| fs::canonicalize(parent).ok())
            .is_some_and(|parent| {
                outside(&parent) && parent.to_str().is_some_and(|p| !p.contains(':'))
            })
        && fs::canonicalize(path).ok().is_some_and(|target| {
            outside(&target)
                && fs::metadata(target)
                    .is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
        })
}

fn executable_bins() -> Vec<PathBuf> {
    let mut bins: Vec<_> = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .map(PathBuf::from)
    .into();
    if let Some(path) = env::var_os("PATH") {
        bins.extend(env::split_paths(&path));
    }
    bins
}

fn default_tools(workspace: &Path, data: &Path) -> BTreeMap<String, PathBuf> {
    let mut node_bins: Vec<_> = env::var_os("NVM_BIN")
        .map(PathBuf::from)
        .into_iter()
        .collect();
    if let Some(root) = env::var_os("NVM_DIR") {
        node_bins.extend(nvm_bins(Path::new(&root)));
    }
    if let Some(home) = env::home_dir() {
        node_bins.extend(nvm_bins(&home.join(".nvm")));
    }
    let mut bins = executable_bins();
    node_bins.extend(bins.iter().cloned());
    let find = |name: &str, bins: &[PathBuf]| {
        bins.iter()
            .map(|bin| bin.join(name))
            .find(|path| valid_executable(path, workspace, data))
    };
    let mut tools = BTreeMap::new();
    if let Some(node) = find("node", &node_bins) {
        let npm = node.with_file_name("npm");
        if valid_executable(&npm, workspace, data) {
            tools.insert("npm".into(), npm);
        }
        tools.insert("node".into(), node);
    }
    // /usr/bin/python3 is a launcher that may prompt to install developer tools.
    bins.retain(|bin| bin != Path::new("/usr/bin"));
    bins.push("/Library/Frameworks/Python.framework/Versions/Current/bin".into());
    bins.push("/Library/Developer/CommandLineTools/usr/bin".into());
    bins.push("/Applications/Xcode.app/Contents/Developer/usr/bin".into());
    if let Some(python) = find("python3", &bins) {
        tools.insert("python3".into(), python);
    }
    tools
}

fn workspace(app: &tauri::AppHandle, data: &Path) -> Result<PathBuf, String> {
    let workspace = fs::canonicalize(load_config(app.clone())?.workspace)
        .ok()
        .filter(|path| path.is_dir())
        .ok_or("请先选择并保存共享工作区。")?;
    let data = fs::canonicalize(data).unwrap_or_else(|_| data.to_owned());
    if data.starts_with(&workspace) || workspace.starts_with(&data) {
        return Err("工作区与应用数据目录重叠，请选择单独的项目文件夹。".into());
    }
    Ok(workspace)
}

fn confirm(workspace: &Path, description: &str) -> bool {
    rfd::MessageDialog::new()
        .set_title("授权 Mac 工具")
        .set_description(format!(
            "工作区：{}\n\n{}\n\n已启用的工具以当前 Mac 用户的权限运行，可访问本机文件和网络。",
            workspace.display(),
            description
        ))
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show()
        == rfd::MessageDialogResult::Ok
}

fn save_grant(data: &Path, grant: &Grant, new: bool) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(grant).map_err(|e| e.to_string())?;
    if bytes.len() > 16_384 {
        return Err("工具列表过大，请先移除不用的工具。".into());
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(data)
        .map_err(|e| format!("无法创建 Mac 工具授权目录：{e}"))?;
    let file = tempfile::NamedTempFile::new_in(data).map_err(|e| e.to_string())?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    file.as_file()
        .write_all(&bytes)
        .map_err(|e| e.to_string())?;
    let path = data.join(GRANT_FILE);
    if new {
        file.persist_noclobber(path)
    } else {
        file.persist(path)
    }
    .map_err(|e| format!("无法保存 Mac 工具授权：{e}"))?;
    Ok(())
}

pub fn configure(app: &tauri::AppHandle, enabled: bool) -> Result<HostToolsStatus, String> {
    let data = mac_vm_data(app)?;
    let path = data.join(GRANT_FILE);
    if !enabled {
        let _lock = take_runtime_lock()?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("无法关闭 Mac 工具转发：{e}")),
        }
        return status(app);
    }
    if read_grant(&path)?.is_some() {
        return status(app);
    }
    let selected = workspace(app, &data)?;
    let tools = default_tools(&selected, &data);
    let names = tools
        .iter()
        .map(|(name, path)| format!("{name} → {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let description = if names.is_empty() {
        "启用后可自行添加 Mac 工具。".to_owned()
    } else {
        format!("允许调用以下 Mac 工具？\n{names}")
    };
    if !confirm(&selected, &description) {
        return status(app);
    }
    let _lock = take_runtime_lock()?;
    if workspace(app, &data)? != selected {
        return Err("工作区已更改，请重试。".into());
    }
    save_grant(
        &data,
        &Grant {
            workspace: selected,
            tools: Some(tools),
            disabled: BTreeMap::new(),
            node: None,
            allow_build: None,
        },
        true,
    )?;
    status(app)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.len() > 64
        || matches!(name, "mac" | "claude")
        || !name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.+-".contains(&c))
    {
        return Err("请输入有效的命令名，例如 git 或 python3。".into());
    }
    Ok(())
}

pub fn find(app: &tauri::AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
    validate_name(name)?;
    let data = mac_vm_data(app)?;
    let selected = workspace(app, &data)?;
    if matches!(name, "node" | "npm" | "python3") {
        return Ok(default_tools(&selected, &data).remove(name));
    }
    Ok(executable_bins()
        .iter()
        .map(|bin| bin.join(name))
        .find(|path| valid_executable(path, &selected, &data)))
}

pub fn edit(
    app: &tauri::AppHandle,
    action: &str,
    name: &str,
    path: Option<PathBuf>,
) -> Result<HostToolsStatus, String> {
    if !matches!(action, "add" | "enable" | "disable" | "remove") {
        return Err("未知的工具操作。".into());
    }
    validate_name(name)?;
    let data = mac_vm_data(app)?;
    let selected = workspace(app, &data)?;
    let read = || -> Result<Grant, String> {
        let grant = read_grant(&data.join(GRANT_FILE))?.ok_or("请先启用 Mac 工具转发。")?;
        if fs::canonicalize(&grant.workspace).ok().as_ref() != Some(&selected) {
            return Err("请关闭旧工作区授权，并为当前工作区启用转发。".into());
        }
        if grant.tools.is_none() {
            return Err("请关闭旧版授权后重新启用。".into());
        }
        Ok(grant)
    };
    let before = read()?;
    let add = if action == "add" {
        if before
            .tools
            .as_ref()
            .is_some_and(|tools| tools.contains_key(name))
            || before.disabled.contains_key(name)
        {
            return Err("已有同名工具。".into());
        }
        let path = match path {
            Some(path) => path,
            None => match rfd::FileDialog::new()
                .set_title("选择 Mac 可执行文件")
                .set_directory("/opt/homebrew/bin")
                .pick_file()
            {
                Some(path) => path,
                None => return status(app),
            },
        };
        if !valid_executable(&path, &selected, &data) {
            return Err("请选择位于共享目录之外的 Mac 可执行文件。".into());
        }
        if !confirm(&selected, &format!("允许调用 {name}？\n{}", path.display())) {
            return status(app);
        }
        Some(path)
    } else {
        None
    };
    let _lock = take_runtime_lock()?;
    if workspace(app, &data)? != selected {
        return Err("工作区已更改，请重试。".into());
    }
    let mut grant = read()?;
    let tools = grant.tools.as_mut().ok_or("请重新启用转发。")?;
    match action {
        "add" => {
            if tools.contains_key(name) || grant.disabled.contains_key(name) {
                return Err("已有同名工具。".into());
            }
            let path = add.ok_or("未选择工具。")?;
            tools.insert(name.to_owned(), path);
        }
        "enable" => {
            let path = grant.disabled.remove(name).ok_or("找不到已禁用工具。")?;
            if !valid_executable(&path, &selected, &data) {
                return Err("工具已不可用，请移除后重新添加。".into());
            }
            tools.insert(name.to_owned(), path);
        }
        "disable" => {
            let path = tools.remove(name).ok_or("找不到已启用工具。")?;
            grant.disabled.insert(name.to_owned(), path);
        }
        "remove" => {
            tools.remove(name);
            grant.disabled.remove(name);
        }
        _ => unreachable!(),
    }
    save_grant(&data, &grant, false)?;
    status(app)
}
