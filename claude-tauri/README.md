# Claude Haven 桌面端

Tauri 2 桌面应用。Windows x64 通过 WSL2 运行 Linux 桌面；Intel 和 Apple Silicon Mac 使用 Apple Virtualization.framework 启动与宿主架构匹配的 Linux 系统。各平台使用独立的虚拟机镜像与启动实现。

`npm run dev` 和 `npm run build` 会先把 `claude-vm/vm/` 中的脚本与资源同步到本目录的 `runtime/`。

## Windows 开发

Windows 需要 Node.js、Rust MSVC 工具链、C++ Build Tools、WebView2 和 WSL2。开发时将 WSL rootfs 放在 `runtime/rootfs.tar.gz`；该运行时镜像不提交到 Git。Windows 启动与构建步骤见[开发指南](../docs/development.md#windows-x64-开发)。

程序会保留已有 `claude-vm` WSL 发行版，并在首次使用时读取旧应用配置以迁移工作区设置。关闭窗口会收进系统托盘；从托盘选择退出才会停止环境。

## macOS 开发

Mac 构建要求 Intel 或 Apple Silicon 和 macOS 13+。除 Node.js 22、Rust stable、Xcode Command Line Tools 外，还需要预先准备与 Mac 芯片匹配的 Linux 镜像。完整的工具安装、镜像构建、运行和打包说明见[macOS 开发工具链](../docs/macos-development.md)。

图片和文件暂不支持跨系统剪贴板，可使用共享工作区。安装包和全新 Windows 环境仍需完整验证。
