# 发布桌面版本

GitHub Actions 在云端分别构建 Windows x64 安装包、Apple Silicon Mac DMG 和 Intel Mac DMG，并将三个文件放到同一个 GitHub Release。它会在匹配架构的 Linux runner 上构建 Mac 系统镜像，再用对应的 Mac runner 打包应用。

## 发布步骤

先在 `claude-tauri/package.json`、`claude-tauri/package-lock.json`、`claude-tauri/src-tauri/Cargo.toml`、`claude-tauri/src-tauri/Cargo.lock` 和 `claude-tauri/src-tauri/tauri.conf.json` 中统一更新版本号，然后将代码推送到 `main`。

打开仓库的 **Actions → Publish Claude Haven → Run workflow**，输入对应标签，例如 `v0.1.5`。标签版本必须与应用版本一致。工作流完成后会自动创建 Release 并上传 Windows 和 Mac 安装包。

也可以在代码已更新版本号后直接推送标签。推送 `v*` 标签会自动启动同一套构建和发布流程。

如果只需更新已发布版本的 Windows 安装包，请在 `main` 上手动运行工作流，填写现有标签并勾选 `windows_only`。工作流从所选分支构建 Windows 安装包，并替换该 Release 的 Windows 资产。

## 构建结果

- Windows x64 NSIS 安装包，文件名类似 `Claude Haven_0.1.5_x64-setup.exe`。
- Apple Silicon Mac DMG，文件名为 `Claude-Haven-macOS-arm64-compact.dmg`。
- Intel Mac DMG，文件名为 `Claude-Haven-macOS-x64-compact.dmg`。

Mac DMG 使用临时签名，当前工作流没有 Developer ID 公证。公开分发前若要消除 Gatekeeper 的未验证开发者提示，需要配置 Apple Developer 签名和公证凭据。

工作流配置位于 `.github/workflows/release.yml`。
