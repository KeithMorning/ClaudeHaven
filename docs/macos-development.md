# macOS Intel 与 Apple Silicon 开发工具链

macOS 版本支持 Intel（x86_64）和 Apple Silicon（arm64），最低要求 macOS 13。桌面运行在应用内置的同架构 Linux 虚拟机中，由 Apple Virtualization.framework 启动。用户运行应用时不需要安装 Lima、Docker 或另行下载 Linux 系统镜像。

## Mac 主机工具

- Intel 或 Apple Silicon Mac，macOS 13 或更新版本。
- Xcode 或 Xcode Command Line Tools，提供 Apple SDK、Swift 编译器和代码签名工具。仅安装命令行工具时可运行 `xcode-select --install`。
- Node.js 22。仓库通过 `claude-tauri/.nvmrc` 固定主版本；使用 nvm 时在 `claude-tauri/` 下运行 `nvm use`。
- Rust stable 和当前 Mac 对应的 target。Intel 使用 `x86_64-apple-darwin`，Apple Silicon 使用 `aarch64-apple-darwin`。rustup 通常会按主机自动选择。

检查工具是否可用：

```bash
xcodebuild -version
xcrun swiftc --version
node --version
rustc --version
```

## 准备内置 Linux 镜像

首次构建 Mac 应用前，将 `kernel.tar.xz`、`initrd`、`system.squashfs` 和 `image-version` 放入 `claude-tauri/runtime/native/`。这些文件由镜像构建脚本生成，Git 会忽略它们。目录中的镜像必须与正在构建的 Mac 架构一致。

镜像打包脚本的输入必须是可运行桌面环境的 Linux rootfs。Apple Silicon 使用 `linux/arm64`，Intel 使用 `linux/amd64`。Windows WSL 的 `claude-tauri/runtime/rootfs.tar.gz` 不能代替这两个镜像。可通过 `claude-vm/build-rootfs.sh` 生成匹配架构的 rootfs。

接着在对应架构的 Linux 构建机上生成虚拟机内核、initramfs 和系统盘。构建机需运行带有匹配 `/boot/vmlinuz-$(uname -r)` 和 `/lib/modules/$(uname -r)` 的 Linux 内核。脚本会从当前内核复制虚拟机所需模块，因此应在完整的 Linux 虚拟机中运行，而不是 macOS shell 或普通容器中运行。

Ubuntu/Debian 构建机需要 `busybox`、`kmod`、`e2fsprogs`、`binutils`、`zstd`、`python3` 和 gzip 等工具。示例：

```bash
sudo apt-get update
sudo apt-get install -y busybox kmod e2fsprogs binutils zstd python3 gzip xz-utils squashfs-tools
```

构建机的 `mksquashfs` 需要支持 XZ 和当前架构的 BCJ 过滤器。用于启动虚拟机的内核需启用 `CONFIG_SQUASHFS_XZ` 和 OverlayFS。构建时会在镜像内编译万象词库。

在仓库根目录运行：

```bash
sudo bash claude-vm/macos/build-image.sh \
  dist/rootfs-linux-arm64.tar.gz \
  claude-tauri/runtime/native
```

在 Intel Linux 构建机上将输入换成 `dist/rootfs-linux-x64.tar.gz`，脚本会根据当前 Linux 架构生成 x86_64 镜像。构建完成后，把 `claude-tauri/runtime/native/` 目录带回同架构 Mac 主机。该目录是本地构建产物，已加入 `.gitignore`，不要提交生成的大镜像文件。

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

制作带有 Applications 快捷方式的 DMG，运行 `npm run package:macos`。产物位于仓库的 `dist/` 目录。

构建结果位于 `src-tauri/target/release/bundle/macos/Claude Haven.app`。`npm run dev` 和 `npm run build` 会先同步 `claude-vm/vm/` 中的脚本与资源；在 macOS 上，`prepare-macos.js` 会根据宿主架构编译 `native/HavenVM.swift`，生成对应的 `runtime/native/haven-vm`，并为它签入 Virtualization.framework entitlement。Tauri 会把匹配的 Linux 镜像打入应用，同时排除 Windows WSL rootfs。

Mac 直接挂载应用内的只读压缩系统盘。Linux 将改动写入 `native-vm/state.img`，这个稀疏文件按写入的数据增长。浏览器的 HTTP 缓存和临时文件存于内存。启动日志位于 `native-vm/boot.log`。修改 Linux 桌面脚本后，可以重启开发版加载新脚本。修改基础系统包或 Linux 内核后，需要重新构建镜像。

本地开发构建不等于正式发行。公开分发还需要对应用进行 Developer ID 签名、公证，并验证目标 Mac 上的安装和首次启动流程。

## 从 Linux 工作区调用 Mac 工具

从 Mac 虚拟桌面打开 Claude Code 时，会通过 `mac claude` 启动。宿主转发关闭时，Claude Code 直接使用虚拟机里的 Linux 工具。启用转发后，重新打开 Claude Code 会加载当前工作区已授权的宿主工具。

在 Mac 应用中保存共享工作区，然后打开「系统设置 → Mac 工具转发」，点击「启用转发」。应用会检测已安装的 `node`、`npm` 和 `python3`，确认后将检测到的工具授权给当前工作区。已有授权里缺少的默认工具会显示为「可添加」。

添加其他工具时，输入命令名，应用会自动填入检测到的 Mac 路径。找不到时可输入绝对路径或选择文件。工具列表显示命令名、可执行文件路径和启用状态，可以单独禁用、重新启用或移除工具。

更换工作区时，请先关闭旧授权，再为新工作区启用。如果虚拟机仍打开着旧工作区，请重启虚拟环境。已有的手工授权仍可使用，旧版有限授权可关闭后用新版设置重新启用。

授权文件保存在 `~/Library/Application Support/com.claudevm.workspace/native-vm/host-npm.json`，权限为 `600`。以下路径为示例。

```json
{
  "workspace": "/Users/yourname/Projects/my-project",
  "tools": {
    "node": "/Users/yourname/.nvm/versions/node/v22.21.1/bin/node",
    "npm": "/Users/yourname/.nvm/versions/node/v22.21.1/bin/npm",
    "python3": "/opt/homebrew/bin/python3"
  }
}
```

保存后，在 Linux 终端进入 `/workspace` 或其下含有 `package.json` 的目录：

```sh
mac node scripts/check.js
mac npm run build
mac python3 tools/generate.py
mac claude
```

用 `mac claude` 打开会话后，Claude Code 可以直接执行 `npm run lint`、`node script.js` 等命令。会话启动时读取工具名，匹配的命令连同参数发给 Mac，实时返回输出和退出码。其他命令及 shell 运算符仍由 Linux 处理。工具应使用工作区内的相对路径，此模式目前适用于非交互命令。

授权工具可使用 Mac 当前用户的权限和网络执行任意受该工具支持的参数。请只给可信工作区授权。修改后续调用的权限无需重启虚拟机。旧的 `node` 与 `allowBuild` 配置仍支持原有的版本查询和构建。使用含原生模块的项目时，请在 Mac 侧准备依赖。

## Windows 构建不变

Windows 继续使用 Tauri + WSL2 和 Windows rootfs，按[Windows 开发指南](development.md#windows-x64-开发)操作。macOS 的 Swift 虚拟机助手和 Apple Virtualization.framework 配置只在 macOS 构建中使用，不会替换 Windows 的运行时。
