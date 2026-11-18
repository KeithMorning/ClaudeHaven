# Claude VM 桌面端

Tauri 2 开发版，当前支持 Windows x64 和 WSL2。项目入口和运行要求见[仓库说明](../README.md)。

`npm run dev` 和 `npm run build` 会将 `claude-vm/vm/` 的脚本和资源同步到本目录的 `runtime/`。`runtime/rootfs.tar.gz` 是单独提供或构建的运行时镜像，不提交到 Git。

程序会保留已有 `claude-vm` WSL 发行版，并在首次使用时读取旧应用配置以迁移工作区设置。关闭窗口会收起到系统托盘；从托盘选择退出才会停止环境。

图片和文件暂不支持跨系统剪贴板，可使用共享工作区。安装包和全新 Windows 环境仍需完整验证。
