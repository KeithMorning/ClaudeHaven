# macOS / 容器后端（1.0.32 起）

> 状态：代码已实现，**未在真实 Mac 上验收**。定位是实验性兜底，不是正式能力宣传。

## 架构约束

**平台差异只允许写在 `claude-desktop/app/lib/vm-backend.js`**，main.js 只调接口。
新平台也走这条路，不许把 `if (process.platform === ...)` 散进业务逻辑。

## 后端选型：容器（Docker Desktop / OrbStack），不是虚拟机

- `rootfs.tar.gz` 直接 `docker import` 成镜像，**零格式转换**（Lima 要先做可引导磁盘，
  Mac 本地没有 ext4 工具链）；
- rootfs 是 amd64，Apple Silicon 用 **Rosetta** 跑（设置里启用
  「Use Rosetta for x86_64/amd64 emulation」），**不用等 arm64 重建镜像**；
- entrypoint 本来就是容器 entrypoint（项目源自 Docker + noVNC 方案），guest 内全栈原样复用。

## 容器模型的关键决定（都在 vm-backend.js 顶部注释里）

- 实例 PID1 = `sleep infinity`（`--init` 让 tini 收信号），entrypoint 走 `docker exec` 拉起 ——
  每次启动带新环境变量（代理/工作区随配置变），容器空闲时也能 exec 同步脚本。
- `/root` 挂命名卷 `claudevm-home`：重建实例不丢凭据 / Chrome 配置 / Rime 词库
  （对齐 WSL「terminate 不丢发行版磁盘」语义）。
- 工作区靠挂载 `/Users` → `/mnt/host-users`、`/Volumes` → `/mnt/host-volumes` 覆盖；
  **工作区必须在这两个前缀下**，否则启动直接报错（不猜映射）。
- noVNC：`NOVNC_BIND=0.0.0.0` + `-p 127.0.0.1:6080:6080`（websockify 绑回环的话端口发布连不上）。
- `--shm-size=1g`（Chrome 必需）、`--cap-add NET_ADMIN`（net-guard 熔断必需）。
- macOS **只有串流桌面模式**（没有 WSLg），mergeCfg 强制 `displayMode=desktop`，渲染层隐藏选项。
- 一键重置：`docker rm -f` + `docker volume rm -f claudevm-home`，见[环境重置](../security/02-一键环境重置.md)。

## 在 Mac 上验证（用户实测清单）

```bash
git clone git@github.com:KeithMorning/ClaudeVM.git && cd ClaudeVM/claude-desktop
npm install && npm start          # 开发模式直接跑
# 或打包：npm run dist:mac（必须在 macOS 上跑；未签名需右键→打开 绕过 Gatekeeper）
```

前置：Docker Desktop 或 OrbStack（`brew install orbstack`，旧文档写的是 `--cask`）已启动；
Apple Silicon 启用 Rosetta。首次点「启动」会 docker import（约 1~2 分钟）。
验证三件事：桌面能串流显示且 ✕ 能关窗口；终端里 `Ctrl+Space` 敲 `nihao` 出「你好」；
代理链路校验通过（Chrome 能开 claude.ai）。

## 测试

`tests/unit/backend.test.js` 直接 require `app/lib/vm-backend.js`（不走 loader 切片 —— 这是
「纯函数抽到 lib/ 后直接 require」的重构方向）；静态层有平台抽象断言
（main.js 不得直接 spawn wsl.exe、NOVNC_BIND 等）。

## OrbStack 自动集成的调研结论

- **可自动**：官方支持纯 CLI（`orb status` / `orb start` / `orb stop`、`docker context use orbstack`、
  绝对路径 `~/.orbstack/bin/docker`），装好之后从检测到运行时到容器起来可一条龙。
- **不能静默自动**：首次安装 app 本身要过 Gatekeeper / 用户确认；且许可禁止再分发
  （Free 仅个人非商用，MSA 禁止 transfer/sublicense），**不能打进我们的安装包**，只能引导用户自装。
- **体积账**：arm64 DMG 约 448 MiB，加我们 620 MB rootfs，首次落地约 1.07 GB。
- **隔离边界**：OrbStack 的 Linux machine 与容器**共享同一内核**（官方原话 "not independent VMs"），
  换 machine 类型也拿不到 Cage 那种独立 VM。

详见[平台与范围取舍](../decisions/04-平台与范围取舍.md)与[Claude Cage 对比](../references/02-Claude-Cage对比.md)。

---
*更新: 2026-11-16 | 来源: `开发交接.md` 第 9 节 + OrbStack 官方文档调研*
