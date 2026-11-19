# Linux 运行时

`vm/` 包含虚拟桌面的 Docker 构建上下文、网络守卫、输入法和桌面资源。Docker 只用于构建镜像；Windows 客户端通过 WSL2 导入并运行导出的文件系统。

在仓库根目录运行以下命令。第一个命令导出 Windows 版 WSL 所用的 AMD64 镜像。第二个命令导出独立的 ARM64 文件系统，默认位于 `dist/rootfs-linux-arm64.tar.gz`。

```bash
bash claude-vm/build-rootfs.sh
bash claude-vm/build-rootfs.sh "" "" linux/arm64
```

ARM64 构建需要支持 `linux/arm64` 的 Docker Buildx 构建器，可使用 Apple Silicon 上的 Docker Desktop 或具备 ARM64 模拟能力的 x64 构建器。导出的压缩包是 Linux 用户空间。Apple Silicon 上通过原生虚拟化运行时，还需要匹配的 Linux 内核、启动磁盘及 macOS 客户端的虚拟机启动逻辑。Intel Mac 对应 AMD64 镜像。

Tauri 启动时会同步并校验 `vm/scripts/` 和必要资源，不需要为了更新这些脚本重建镜像。完整的网络保护和隐私边界见[网络检查审计](../docs/network-check-audit.md)。
