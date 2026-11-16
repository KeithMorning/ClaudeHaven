# 坑档案：桌面 UI 与 Electron（坑 5 / 6 / 7 / 12 / 14）

> 踩坑实录原文，逐字保留。当前机制见[显示模式](../desktop/02-显示模式.md)、
> [目录地图与 IPC](../overview/02-目录地图与IPC.md)。返回[速查表](index.md)。

## 5) `<webview>` 是独立图层，CSS `z-index` 盖不住它。

弹窗/面板要显示必须先把 webview 隐藏（`openPanel()` 里的 `data-restore` 逻辑）。
曾经自检面板已经正确生成，但被串流画面整块遮住，导致只能看到底部小字。

## 6) Electron 20+ 的 preload 跑在 sandbox 里。

`require('electron').clipboard` 是 `undefined`。剪贴板走主进程 `ipcMain`（`clip:read` / `clip:write`）。
同理 `win.setMenuBarVisibility(false)` 只隐藏菜单栏、**加速键照样生效** ——
Ctrl+W 会关掉整个应用并杀掉虚拟机，必须用 `Menu.setApplicationMenu(null)`。

## 7) WSLg 窗口的存活依赖发起它的 `wsl.exe`。

「拉起窗口 → wsl.exe 马上退出」会让发行版进入 Stopped，**窗口和剪贴板一起消失**。
所以 entrypoint 末尾必须显式兜住 `wait`：

```bash
sleep infinity &
wait
```

这不是资源泄漏，是窗口的生命线。desktop 模式同理（noVNC 会断）。
另：`syncScripts()` 拼命令时别在子命令末尾加分号，会拼出 `;;` 让整段 bash 语法错误
（1.0.19~1.0.20 同步一直静默失败，就是这个）。

## 12) 1.0.27：Openbox 按钮 context 的官方命名（串流桌面 ✕ 点不动）。

- 症状：串流桌面里窗口标题栏的 ✕ 看得到、点了没反应，但 `Alt+F4` 能关。
  根因是 `rc.xml` 的 `<mouse>` 段**整段替换**默认配置，精简版只写了
  `Frame` / `Titlebar` / `Desktop`，按钮 context 全缺 -> 按钮有外观、没有 action。
- **大坑**：按钮 context 叫 `Close` / `Maximize` / `Iconify` / `AllDesktops` / `Shade`，
  **不是** `CloseButton` 这种直觉命名；动作是 `Click` 不是 `Release`。
  第一版按直觉命名，XML 合法但 Openbox 静默忽略，实机点击依然 CLOSED=0；
  改成官方命名后同一坐标 CLOSED=1。不确定时直接对照 `/etc/xdg/openbox/rc.xml`。
- 修法：配置走 assets 链 `vm/config/openbox-rc.xml → runtime/assets/config/ →
  /opt/assets/config/`，entrypoint 3.1 段优先覆盖 `~/.config/openbox/rc.xml`，
  不用重建 rootfs。必须「停止 → 启动」让 openbox 重载；`Alt+F4` 一直是兜底。
- 实机验证做法：常驻会话里起 `Xtigervnc :1` + openbox + xterm，用
  `xwininfo -id <id> -tree` 找 frame，再
  `xdotool mousemove --window <frame> (W-8) 6 click 1` 点右上角，检查窗口是否消失。
  **X server / openbox / 测试窗口必须在同一个脚本存活期间**，子脚本一退出它们全没了（见坑 9）。
- UI：白竖条是 Chromium 默认浅色滚动条，换深灰细条；侧栏长说明折叠成 `<details>`，
  `runDetect()` 要先 `hint.closest('details').open = true` 再写反馈，否则检测结果藏在折叠里。

## 14) 1.0.29：串流桌面「意外退出 + Chrome 打不开 + 输入法切不了」是同一次会话猝死。

- 日志证据：`desktop 就绪` → 28 秒后 `[vm] 运行时进程退出 code=1`，没有 `[stop]` /
  `[app] 退出`。随后 `ready` 空、三个进程全无、6080 未监听、`DISPLAY=:1` FAIL、
  `XIM_SERVERS: no such atom`、熔断解锁、DNS 后缀又回来 —— 全是会话死后的衍生状态。
- **根因 1（猝死）**：`entrypoint.sh` 开头 `set -e`，末尾 `wait` 等最后一个后台子进程。
  desktop 模式**没有** `sleep infinity &`（注释误以为「靠 Xtigervnc/websockify 天然兜住」），
  任一组件退出 → `wait` 返回 → 脚本结束 → `wsl.exe` 退出 → 发行版 Stopped。
  修法：desktop 也放 `sleep infinity &`；新增 `desktop-guard.sh` 每 4 秒自愈四个组件。
  隔离 A/B 验证：无兜底时脚本在子进程退出后立刻结束，有兜底时 `timeout` 124（一直挂住）。
- **根因 2（输入法）**：`ibus-daemon` 在 2.45 段起，而 `export DISPLAY=:1` 在 4d 段 →
  XIM 注册到 WSLg 的 `:0`，串流窗口在 `:1`，`Ctrl+Space` 当然没反应。
  **把输入法整段移到 DISPLAY_MODE 分支之后、runtime-env 写盘之前**。
  别只在 desktop 分支补一次启动 —— 那样 wslg/desktop 两套逻辑会越漂越远。
- **根因 3（Chrome）**：`SingletonLock` 内容是 `hostname-PID`。1.0.26 起 hostname 随机化
  成 `DESKTOP-XXXXXXX`，残留锁仍是 `HomeVisionPC-324` 且 socket 目录已不存在 →
  Chrome 判定 Profile 被别的主机占用、拒绝启动。修法：桌面启动段 + `chrome-login.sh`
  各清一次（`SingletonLock/Cookie/Socket`），**仅当没有活着的 Chrome 进程**，正常多开仍复用实例。
- **hostname 会漂**：WSL 每次会话重启把 `/etc/hostname` 重设成宿主名。2.67 段每次启动
  都会重新套用 `/opt/config/identity`，所以自检那条「环境身份不一致」warn 其实是
  **会话已退出**的信号，不是身份逻辑坏了。也正因 hostname 来回变，清锁必须每次都做。
- 改了运行时脚本记得 `RUNTIME_REV` +1，否则新版可能接管旧脚本拉起的桌面，新 entrypoint 不重跑。

---
*更新: 2026-11-16 | 来源: `开发交接.md` 第 5 节坑 5/6/7/12/14（原文）*
