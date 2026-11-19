# 开发指南

本文面向希望从源码运行、修改或打包 Claude Haven 的开发者。普通用户请从仓库首页的[开始使用](../README.md#开始使用)开始。

## Windows x64 开发

需要 Windows x64、Node.js、Rust MSVC 工具链、C++ Build Tools、WebView2 和 WSL2。开发时需要 Linux 运行时镜像 `rootfs.tar.gz`；该文件不提交到 Git。

```powershell
git clone https://github.com/KeithMorning/ClaudeVM.git
cd ClaudeVM\claude-tauri
npm install
```

将 `rootfs.tar.gz` 放入 `claude-tauri\runtime\`，然后启动开发版：

```powershell
npm run dev
```

构建 Windows 安装包：

```powershell
npm run build
```

程序会保留已有的 `claude-vm` WSL 发行版。关闭窗口会将应用收进系统托盘；从托盘退出才会停止环境。

## macOS Apple Silicon 开发

Mac 构建要求 Apple Silicon 和 macOS 13+，以及 Node.js 22、Rust stable 和 Xcode Command Line Tools。首次构建还要准备 ARM64 Linux 镜像。完整的工具安装、镜像构建、运行和打包步骤见 [macOS 开发工具链](macos-development.md)。

基本开发命令：

```bash
cd claude-tauri
nvm use
npm ci
npm run dev
```

构建 `.app`：

```bash
npm run build
```

制作带有 Applications 快捷方式的 DMG：

```bash
npm run package:macos
```

## 构建 Linux 运行时镜像

日常开发和运行不需要 Docker。只有从源码构建 Windows / WSL 使用的 Linux 运行时镜像时，才需要在 Linux 或 WSL 环境中准备 Docker：

```bash
bash claude-vm/build-rootfs.sh
```

脚本默认将镜像写入 `claude-tauri/runtime/rootfs.tar.gz`，也可以传入构建上下文和输出路径。Mac 使用独立的 ARM64 镜像，生成方式见 [macOS 开发工具链](macos-development.md)。

## 项目目录

| 路径 | 内容 |
| --- | --- |
| `claude-tauri/` | Tauri 桌面程序、界面和运行时同步脚本 |
| `claude-vm/vm/` | Linux 桌面、网络保护脚本和资源 |
| `claude-vm/macos/` | Apple Silicon Linux 系统镜像构建脚本 |
| `tests/` | 项目测试 |
| `docs/` | 开发工具链和验证记录 |

运行时镜像等较大的构建产物由 Git 忽略，不要提交到源码仓库。
