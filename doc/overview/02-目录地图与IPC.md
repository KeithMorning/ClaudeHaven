# 目录地图与 IPC
> **⚠️ 历史档案（2.0 起部分内容已过时，2026-11-16）**
> 本页保留 1.0.x 时期的完整记录，作为「为什么不再这么做」的依据。
> 已过时的点：**代理探测、wslg 专用 IPC、显示模式配置**。
> **当前架构以 [`decisions/05-2.0重构-单态化.md`](../decisions/05-2.0重构-单态化.md) 与
> [`network/02-TUN与Mihomo.md`](../network/02-TUN与Mihomo.md) 为准。**


## 代码树逐文件职责

```
claude-desktop/
├─ app/main.js           主进程全部逻辑：WSL 导入/启动/停止、代理探测、自检、诊断包、IPC
├─ app/preload.js        安全桥（sandbox 下只能拿 contextBridge/ipcRenderer）
├─ app/renderer/         界面（设置面板 + 自检面板 + 可选 <webview> 嵌 noVNC）
├─ scripts/sync-scripts.js  vm/scripts → runtime/scripts 的唯一同步入口
├─ scripts/build-rootfs.sh  Docker → rootfs.tar.gz
└─ runtime/              构建产物（rootfs + 同步出来的 scripts/assets）

claude-vm/vm/
├─ Dockerfile            镜像定义（构建期清理，勿删 claude.exe！见坑 4）
├─ scripts/entrypoint.sh 启动：时区→locale→代理→熔断→语言头→DNS 后缀
│                         →独立身份→字体→Claude 自愈→DISPLAY_MODE 分支→就绪标记
├─ scripts/net-guard.py  netlink 路由增删（lock/unlock/status），零外部依赖
├─ scripts/net-guard.sh  严格预检 + 3 秒看门狗，状态写 /run/claude-vm/net-guard.state
├─ scripts/tun-core.sh   容器内 mihomo 内核：起内核 / 切 DNS / tun-ready 标记 / 看门狗
├─ scripts/tun-merge.py  合并用户 YAML + TUN 增强段、解析节点、补 /32 主机路由
├─ scripts/chrome-lang.py --set 固定 Profile 语言偏好 / --verify headless 实测请求头
├─ scripts/rime-setup.sh 按需装 fcitx5 + 前端 + 字体，离线解压万象词库
├─ scripts/desktop-guard.sh 串流桌面自愈：巡检 Xtigervnc/openbox/websockify/fcitx5
├─ scripts/run-claude.sh / run-terminal.sh  lxterminal 启动器（source runtime-env）
├─ scripts/check-env.sh  环境自检（checkcc 评分 + 熔断 + 语言头 + DNS 远程解析，--json 可机读）
├─ config/               桌面布局：openbox / tint2 / 菜单 / noVNC 定制页 desktop.html
├─ assets/fonts/         NotoSansSC.ttf + NotoSansTC.ttf（繁体笔形，均不在 checkcc 名单）
└─ assets/rime/          wanxiang-pure.zip（万象拼音 Pure 词库，26MB，CC BY 4.0）

doc/                     本技术文档 wiki（拆分自原 `开发交接.md`）
docs/                    早期方案存档（如 WechatOnCloud）
build/                   排障/验证用的一次性脚本，不是产品代码（见调试手法）
```

## 关键 IPC（wslg 模式才有意义）

| channel | 作用 |
| --- | --- |
| `terminal:open` | 新开一个 WSLg 窗口跑 `claude` |
| `terminal:shell` | 新开一个普通 shell 窗口 |
| `auth:login` | 弹出容器内 Chrome 做 claude.ai 授权 |
| `auth:status` | 查容器内登录态是否已存在 |
| `clip:read` / `clip:write` | 剪贴板（主进程，desktop 模式下由渲染层轮询） |
| `net:status` | 读 `/run/claude-vm/net-guard.state`，界面每 6 秒轮询 |
| `clash:pick` | 选择外部 Clash YAML（TUN 模式），见[坑 22](../pitfalls/02-网络与代理.md) |
| `runtime:reset` | 一键环境重置，见[环境重置](../security/02-一键环境重置.md) |

## 平台抽象边界

**所有平台差异只允许写在 `claude-desktop/app/lib/vm-backend.js`**，main.js 只调接口。
新平台（Linux 桌面等）也走这条路 —— 不许把 `if (process.platform === ...)` 散进业务逻辑。
详见[平台与范围取舍](../decisions/04-平台与范围取舍.md)与[macOS 后端](../platform/02-macOS-容器后端.md)。

---
*更新: 2026-11-16 | 来源: `开发交接.md` 第 4 节 + IPC 表*
