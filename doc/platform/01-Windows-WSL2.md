# Windows / WSL2 平台
> **⚠️ 历史档案（2.0 起部分内容已过时，2026-11-16）**
> 本页保留 1.0.x 时期的完整记录，作为「为什么不再这么做」的依据。
> 已过时的点：**wslg(:0) 分支、WSLg 窗口存活、旧代理网关死锁**。
> **当前架构以 [`decisions/05-2.0重构-单态化.md`](../decisions/05-2.0重构-单态化.md) 与
> [`network/02-TUN与Mihomo.md`](../network/02-TUN与Mihomo.md) 为准。**


> Windows 是主平台。WSL2 提供**独立内核**，隔离强度高于 macOS 的容器后端。

## 前置条件

- **Windows 11，或 Windows 10 19044+ 且使用商店版 WSL**（WSLg 的前置条件）
- 更老的 Win10（2004/21H1 等内置版 WSL）**没有 WSLg**，只能用 `desktop` 模式走 noVNC
- BIOS 已开虚拟化（WSL2 前提）

## 运行形态

应用启动时把 `runtime/rootfs.tar.gz` 导入为 WSL 发行版 `claude-vm`：

```
Electron → wsl.exe -d claude-vm → entrypoint.sh → wslg(:0) 或 Xvnc(:1)+noVNC(6080)
```

- `wsl --terminate`（停止）只停发行版、**保留磁盘数据**，不重建网络命名空间
  ——这正是「停止→启动连不到代理」死锁的根因，见[坑 15](../pitfalls/02-网络与代理.md)。
- `wsl --shutdown` 才会重建网络、恢复默认路由。
- 一键重置需要 `wsl --unregister` 彻底销毁，见[环境重置](../security/02-一键环境重置.md)。

## 网络能力（实测）

- `/dev/net/tun` 存在、`tun` 模块已加载、WSL2 内核 6.6.87.2 —— TUN 完全可用
- `CapEff=000001ffffffffff`（全能力），但镜像里**没有 `ip` 命令**（无 iproute2）
- netlink（`AF_NETLINK`）可用，这是[网络熔断](../network/01-网络熔断.md)的实现基础

## 会话生命周期的两个坑

1. **WSLg 窗口存活依赖发起它的 `wsl.exe`**：「拉起窗口 → wsl.exe 马上退出」会让发行版进入
   Stopped，窗口和剪贴板一起消失。entrypoint 末尾必须 `sleep infinity & wait` ——
   这不是资源泄漏，是窗口的生命线（坑 7）。
2. **短命 wsl.exe + setsid 会被 WSL 回收整棵进程树**：排查会话问题必须用常驻 wsl.exe 后台任务
   当宿主（产品 spawn 同款形态）。多行 `bash -c` 经 wsl.exe 传参换行会被吞、变量赋值失效，
   诊断逻辑一律写进脚本文件再执行（坑 8/17）。

## 与其他平台的边界

平台差异只允许写在 `app/lib/vm-backend.js`，main.js 只调接口。macOS 走容器后端，
见[macOS 后端](02-macOS-容器后端.md)与[平台取舍](../decisions/04-平台与范围取舍.md)。

---
*更新: 2026-11-16 | 来源: `开发交接.md` 第 1/9 节 + 坑 7/15/17 + TUN spike 实测*
