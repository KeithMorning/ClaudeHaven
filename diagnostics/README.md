# 诊断工具

运行时镜像构建脚本位于 `claude-vm/build-rootfs.sh`；Tauri 开发和打包命令见项目根目录的 README。

- `network/tun-routes.py`：只读导出 Linux 全部 IPv4 路由表，包含 mihomo TUN 使用的策略路由表。可在虚拟机中运行 `python3 <仓库路径>/diagnostics/network/tun-routes.py`。
