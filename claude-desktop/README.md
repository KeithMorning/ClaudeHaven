# Claude VM 桌面版（2.0）

双击即用的桌面程序：在本机 **Linux 虚拟环境**里跑 Claude Code 与 Chrome，以 **noVNC 串流桌面**呈现。
文件走共享工作区，**出网流量由容器内的 mihomo 内核经 TUN 全量接管** —— 不需要宿主代理软件参与运行时链路。

> 终端用户不需要安装 Docker（Windows 需 WSL2）。首次运行自动把内置 rootfs 导入为 WSL 发行版。
> 完整技术文档见仓库根目录 [`doc/index.md`](../doc/index.md)。

```
┌─ Claude VM (Electron) ────────────────────────────────┐
│  设置：伪装画像 / YAML / 出口节点 / 工作区               │
│  检查报告：独立窗口，不遮挡桌面                          │
└──────────────────┬────────────────────────────────────┘
                   │ wsl -d claude-vm（内置 rootfs）
┌──────────────────▼────────────────────────────────────┐
│  Linux 运行时（Ubuntu 22.04）                           │
│   ├─ mihomo 内核   → TUN 全量接管（DNS/UDP/IPv6 一并）   │
│   ├─ net-guard     → 删默认路由，fail-closed 底座        │
│   ├─ Chrome / claude → 串流桌面 :1，noVNC :6080         │
│   └─ /workspace   ←── 宿主工作区目录                     │
└─────────────────────────────────────────────────────────┘
```

## 2.0 的四条改动

1. **删除外部代理链路**：不再填 `http://127.0.0.1:7897`，不再有自动探测、白名单分流、
   `local-proxy`、`HTTP_PROXY` 环境变量或 Chrome `--proxy-server`。宿主 Clash 只是**编辑和导入
   YAML 的辅助工具**，它是全局还是直连、甚至关掉，都不影响出口。
2. **删除 WSLg 模式**：只保留 noVNC 串流桌面（`Xtigervnc :1` + openbox + websockify）。
   相应的原生窗口 IPC 全部移除；登录/终端走串流桌面里的 `.desktop` 启动器。
3. **伪装画像（两套）**：`中国台湾·台北`（UTC+8 / `zh_TW`）与 `美国·纽约`（UTC-5 / `en_US`），
   一次带出时区 / locale / 语言 / Chrome Accept-Language。切换会触发会话重建。
4. **独立检查报告窗口**：检测结果在新 BrowserWindow 里渲染，可导出 HTML。
   主窗口的串流画面永远不被遮罩盖住 —— 报告开着也能继续用桌面。

## 功能

- **导入 YAML + 选择节点**：从 `proxies` 解析节点列表，选一个作为全量出口（忽略订阅原有
  `proxy-groups` / `rules`）。YAML 每次启动读最新内容，改动与换节点都进配置指纹，强制重建内核。
- **没有出口就不启动**：未导入 YAML / 节点失效时直接拒绝启动，避免拉起一台「显示已就绪、
  其实没网」的假环境。
- **fail-closed**：net-guard 删掉默认路由；内核一挂，TUN 与策略路由一起消失，
  main 表又没默认路由 → 立刻全断，不需要检测动作。
- **幂等启动**：配置指纹未变且运行时还活着就接管（仍同步最新脚本）。
- **一键环境重置**：销毁重建，换掉身份 / machine-id / Chrome profile / 登录态。
- **中文输入法**：fcitx5 + Rime 万象拼音，跑在虚拟环境内部。
- **诊断包**：一键导出脱敏配置 + 实例信息 + 检查报告 + 日志末 400 行。

## 目录

```
claude-desktop/
├── app/
│   ├── main.js           主进程：导入/启动/停止/检查、IPC、报告窗口
│   ├── preload.js        安全桥
│   ├── lib/
│   │   ├── vm-backend.js   平台差异唯一收敛点（WSL / 容器）
│   │   ├── tun-config.js   YAML 校验、节点解析、指纹、base64 分块
│   │   └── personas.js     两套伪装画像
│   └── renderer/
│       ├── index.html / renderer.js / styles.css   主窗口
│       └── report.html / report.js                 独立检查报告窗口
├── runtime/              构建产物：rootfs.tar.gz + 同步出的 scripts/assets
├── scripts/sync-scripts.js   vm/scripts → runtime/scripts（唯一同步入口）
└── package.json           electron-builder 配置
```

## 构建步骤（开发机）

前置：WSL2（Ubuntu 22.04）+ Docker（仅重建 rootfs 时需要）、Node 18+。

```bash
# 1) 在 WSL 内构建运行时并导出 rootfs（内含 mihomo 内核与 GeoIP 数据库）
wsl -d Ubuntu-22.04 -e bash -lc \
  "bash /mnt/e/Web/FuckCladue/claude-desktop/scripts/build-rootfs.sh"

# 2) 安装依赖（国内加速）
cd claude-desktop
npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install

# 3) 开发运行 / 打包
npm start
npm run dist:win
```

产物 `dist/ClaudeVM-Setup-<版本>-x64.exe`。安装包内置 `resources/rootfs.tar.gz`（约 650 MB），
因 rootfs 本身已是 gzip，打包用 `compression: "store"`，成品约 740 MB。

> 没有 Docker 时可用 `build/rebuild-rootfs-137.sh` 的增量方案：解压现有 rootfs →
> 只注入内核 / 数据库 / 新脚本 → 重打包。详见 [`doc/engineering/01-构建与打包.md`](../doc/engineering/01-构建与打包.md)。

## 首次运行

1. 程序启动做 WSL2 预检，不可用会列出修复步骤。
2. 选一套伪装画像 → 导入 Clash/Mihomo YAML → 选出口节点。
3. 点「启动虚拟环境」，首次导入 rootfs 约 1~3 分钟，之后约 10~20 秒。
4. 桌面出现后，用里面的 Chrome 完成一次 claude.ai 授权；之后开终端即可直接用 `claude`。
5. 需要核对环境时点「环境检查报告」，它在新窗口打开，不影响桌面。

## 卸载

- 程序目录直接删除；运行时数据在 `%APPDATA%\claude-desktop\runtime`
  （先 `wsl --unregister claude-vm` 注销发行版再删目录，可完整回收约 3 GB）。

## 注意

- 运行时占 `display :1`、`5901`（VNC）、`6080`（noVNC，仅绑回环）。同一台机器只跑一个实例。
- 环境一致性只能降低误判风险，**绕不过账号级地区限制**；需合规地区的 Claude 订阅或 API key。
- 详细架构、22 个历史坑与测试体系见 [`doc/index.md`](../doc/index.md)。

## License

MIT
