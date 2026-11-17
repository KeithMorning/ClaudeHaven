# Claude VM 桌面端

Claude VM 是 Windows x64 桌面应用：通过 WSL2 启动 Linux 桌面，在窗口内使用 Chrome、Claude Code 和中文输入法。

**当前正式支持 Windows x64 + WSL2。macOS 和 Linux 尚未正式支持。** 用户安装和首次使用说明见[项目首页](../README.md)。

## 运行方式

应用首次启动时，将随安装包附带的 `rootfs.tar.gz` 导入为 `claude-vm` WSL 发行版。虚拟桌面通过本机 noVNC 连接呈现；所选工作区映射到虚拟环境。运行时内部的 mihomo 使用所选节点，网络守卫提供直连封锁机制。

配置文件采用 Clash / Mihomo YAML 格式。应用读取可用节点，生成自己的单节点路由；原配置中的分流规则不会原样应用。网络与安全页面提供网络守卫、DNS、出口一致性等检查，检查结果不保证第三方评分，也不能覆盖所有泄露风险。

## 开发与打包

需要 Windows、Node.js、npm 和 `runtime/rootfs.tar.gz`。镜像不包含在 Git 仓库中，生成方法见[构建与打包](../doc/engineering/01-构建与打包.md)。

```powershell
cd claude-desktop
npm install
npm start
npm run dist:win
```

`npm start` 和打包命令会先运行 `scripts/sync-scripts.js`，将 `claude-vm/vm/` 中的运行脚本和桌面资源同步到 `runtime/`。Windows 安装包输出到 `dist/`。

```powershell
npm run test:fast
```

完整测试和 WSL 集成测试说明见[测试体系](../tests/README.md)。

## 代码结构

- `app/main.js`：主进程、运行时生命周期与 IPC。
- `app/lib/`：WSL 后端、网络配置和地区设置。
- `app/renderer/`：桌面界面与检查结果。
- `scripts/sync-scripts.js`：运行时脚本和资源的同步入口。
- `runtime/`：本地生成的运行时镜像及同步资源，不进入 Git。

## 运行时数据

WSL 发行版和虚拟环境中的登录状态会保留在本机。重置或注销发行版会删除其中的数据，请先备份需要保留的内容。

## 许可

[MIT](../LICENSE)
