# Claude VM 桌面端

Tauri 2 桌面端。Windows x64 使用 WSL 2。macOS 提供独立的 Lima 开发模式，尚待 Mac 实机验证。项目入口和运行要求见[仓库说明](../README.md)。

`npm run dev` 和 `npm run build` 会将 `claude-vm/vm/` 的脚本和资源同步到本目录的 `runtime/`。`runtime/rootfs.tar.gz` 是单独提供或构建的运行时镜像，不提交到 Git。

程序会保留已有 `claude-vm` WSL 发行版，并在首次使用时读取旧应用配置以迁移工作区设置。关闭窗口会收起到系统托盘；从托盘选择退出才会停止环境。

图片和文件暂不支持跨系统剪贴板，可使用共享工作区。安装包和全新 Windows 环境仍需完整验证。

## macOS 开发模式

在 Mac 上准备原生架构的 Node.js 和 [Xcode Command Line Tools](https://v2.tauri.app/start/prerequisites/)。如果还没有 Apple 开发工具，先运行 `xcode-select --install`。

```bash
cd claude-tauri
npm run build
npm run dev
```

`npm run build` 会补齐本地 npm 依赖。如果已安装 Homebrew，也会尝试安装缺少的 Rust 和 [Lima](https://lima-vm.io/docs/config/vmtype/vz/)。它生成本地开发用的程序，`npm run dev` 打开应用窗口。

镜像放在本目录的 `runtime/` 或仓库根目录的 `dist/`。Apple Silicon 使用 `rootfs-linux-arm64.tar.gz`，Intel 使用 `rootfs.tar.gz`。如果镜像在别处，可用 `CLAUDE_HAVEN_ROOTFS=/path/to/image.tar.gz npm run build` 指定文件。如果还没有镜像，可以先打开界面。进入虚拟桌面需要镜像和 Lima。

应用打开后，选择 Clash / Mihomo 配置和工作区，再点击「启动虚拟环境」。首次启动由 Lima 下载并启动 Ubuntu 基础虚拟机，然后导入项目的镜像。

开发虚拟机存放在 `~/.claude-haven-lima`，桌面端口为本机 `127.0.0.1:6080`。更换共享目录后，保存设置并停止、重新启动虚拟环境。开发版的停止与退出操作会关停这个独立实例。

如需在开发机上查看虚拟桌面的启动日志：

```bash
LIMA_HOME="$HOME/.claude-haven-lima" limactl shell desktop sudo journalctl -u claude-haven-desktop -n 80
```
