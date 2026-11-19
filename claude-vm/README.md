# Linux 运行时

`vm/` 包含虚拟桌面的 Docker 构建上下文、网络守卫、输入法和桌面资源。Docker 只用于构建镜像；Windows 客户端通过 WSL2 导入并运行导出的文件系统。

在已安装 Docker 的 Linux 或 WSL 环境中运行 `./build-rootfs.sh`，默认输出到 `../claude-tauri/runtime/rootfs.tar.gz`。脚本也接受构建上下文和输出路径参数。

Tauri 启动时会同步并校验 `vm/scripts/` 和必要资源，不需要为了更新这些脚本重建镜像。
