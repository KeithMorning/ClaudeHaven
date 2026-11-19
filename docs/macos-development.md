# macOS Apple Silicon 开发工具链

macOS 版本面向 Apple Silicon（arm64），最低要求 macOS 13。桌面运行在内置 ARM64 Linux 虚拟机中，由 Apple Virtualization.framework 启动。用户运行应用时不需要安装 Lima、Docker 或另行下载 Linux 系统镜像。

## Mac 主机工具

- Apple Silicon Mac，macOS 13 或更新版本。
- Xcode 或 Xcode Command Line Tools，提供 Apple SDK、Swift 编译器和代码签名工具。仅安装命令行工具时可运行 `xcode-select --install`。
- Node.js 22。仓库通过 `claude-tauri/.nvmrc` 固定主版本；使用 nvm 时在 `claude-tauri/` 下运行 `nvm use`。
- Rust stable 和 `aarch64-apple-darwin` target。通常 rustup 会按 Mac 主机自动选择；如果缺少该 target，运行 `rustup target add aarch64-apple-darwin`。

检查工具是否可用：

```bash
xcodebuild -version
xcrun swiftc --version
node --version
rustc --version
```

## 准备内置 Linux 镜像

首次构建 Mac 应用前，`claude-tauri/runtime/native/` 中需要有 `kernel`、`initrd`、`system.img.gz` 和 `image-version`。这些大文件由 Git 忽略，不在源码仓库中。

镜像打包脚本的输入是 `dist/rootfs-linux-arm64.tar.gz`。它必须是可运行桌面环境的 ARM64 Linux rootfs；Windows WSL 使用的 `claude-tauri/runtime/rootfs.tar.gz` 不是这个文件的替代品。当前 `claude-vm/build-rootfs.sh` 用于 Windows/WSL 开发镜像，不负责生成此 ARM64 输入。请先从项目构建产物中取得该 ARM64 rootfs。

接着在 ARM64 Linux 构建机上生成 Apple 虚拟机使用的内核、initramfs 和系统盘。构建机需运行带有匹配 `/boot/vmlinuz-$(uname -r)`、`/boot/initrd.img-$(uname -r)` 及 `/lib/modules/$(uname -r)` 的 ARM64 Linux 内核。脚本会从当前内核复制虚拟机所需模块，因此应在完整的 Linux ARM64 虚拟机中运行，而不是 macOS shell 或普通容器中运行。

Ubuntu/Debian 构建机需要 `busybox`、`kmod`、`e2fsprogs`、`binutils`、`zstd`、`python3` 和 gzip 等工具。示例：

```bash
sudo apt-get update
sudo apt-get install -y busybox kmod e2fsprogs binutils zstd python3 gzip
```

在仓库根目录运行：

```bash
sudo bash claude-vm/macos/build-image.sh \
  dist/rootfs-linux-arm64.tar.gz \
  claude-tauri/runtime/native
```

构建完成后，把 `claude-tauri/runtime/native/` 目录带回 Mac 主机。该目录是本地构建产物，已加入 `.gitignore`，不要提交生成的大镜像文件。

## 在 Mac 上运行和打包

```bash
cd claude-tauri
nvm use
npm ci
npm run dev
```

打包本地应用：

```bash
npm run build
```

构建结果位于 `src-tauri/target/release/bundle/macos/Claude Haven.app`。`npm run dev` 和 `npm run build` 会先同步 `claude-vm/vm/` 中的脚本与资源；在 macOS 上，`prepare-macos.js` 还会自动编译 `native/HavenVM.swift`、生成 `runtime/native/haven-vm`，并为它签入 Virtualization.framework entitlement。Tauri 的 macOS 配置会把这套 ARM64 镜像打入应用，同时排除 Windows WSL rootfs。

首次启动时，应用会把压缩系统盘展开到用户数据目录；Linux 用户数据盘会保留在同一目录。启动日志位于该目录下的 `native-vm/boot.log`。修改 Linux 桌面脚本后，一般直接重启开发版即可；修改基础系统包或 Linux 内核时，需要重新生成并拷贝 `runtime/native/` 镜像。

本地开发构建不等于正式发行。公开分发还需要对应用进行 Developer ID 签名、公证，并验证目标 Mac 上的安装和首次启动流程。

## Windows 构建不变

Windows 继续使用 Tauri + WSL2 和 Windows rootfs，按[仓库开发说明](../README.md#快速开始)操作。macOS 的 Swift 虚拟机助手和 Apple Virtualization.framework 配置只在 macOS 构建中使用，不会替换 Windows 的运行时。
