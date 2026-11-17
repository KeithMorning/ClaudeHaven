# 测试指南

这个项目的理念是「**fail-closed + 环境可信**」：网络熔断宁可断网也不泄漏、脚本改了必须真的进到运行环境里、容器内内核是唯一出口。2.0 单态化后，测试的重点从「两套链路别走错」转向「单态链路的每一环都在」——YAML 必需、节点可选、TUN 恒开、报告独立窗口。但根基没变：没有测试套件，二十二个坑每一个都可能悄悄回来。

这套测试的目的有两个：

1. **回归防线**：优化、重构、加功能时，改坏了立刻知道，而不是等用户报「又点不动了」。
2. **行为规格**：如果哪天要重新开发（换架构、换运行时），这套测试就是验收标准——
   纯函数的行为、脚本的关键约束、启动链路的顺序要求，全部写在这里。

## 分层模型

| 层 | 目录 | 外部依赖 | 何时跑 | 实测耗时 |
| --- | --- | --- | --- | --- |
| **L1 单元** | `tests/unit/` | 无（WSL 全部 mock） | 每次改 `app/main.js` | < 1 秒 |
| **L2 静态一致性** | `tests/static/` | 仅仓库文件（缺失自动 sync） | 每次提交前 | ~2 秒 |
| **L3 WSL 集成** | `tests/integration/` | WSL2 + 已导入 `claude-vm` | 改运行时脚本 / 网络逻辑后 | ~20 秒 |
| **L4 端到端** | 手工 checklist（见文末） | 真实代理 + 完整安装包 | 每次发版 | 分钟级 |

没有 WSL 的机器（CI、Mac）上 L3 自动 skip，不影响整体通过。

## 快速开始

```bash
# 全部（含 L3 集成，本机需 WSL 且环境处于「停止」状态）
node --test "tests/**/*.test.js"

# 只跑快速层（L1 + L2，无副作用）
node --test "tests/unit/*.test.js" "tests/static/*.test.js"

# 等价入口（在 claude-desktop/ 下）
cd claude-desktop && npm test
```

> **Windows 注意**：glob 必须用引号包住（`"tests/**/*.test.js"`）。
> cmd 不展开 `*`，Node 自己做 glob；裸目录参数（`node --test tests/unit`）在 Windows 上不生效。

## 坑 → 测试映射表

踩过的坑里，能在代码层拦住的都固化成了测试。新增测试时优先补这张表。

| 坑 | 症状 | 覆盖位置 |
| --- | --- | --- |
| ~~坑 8：代理尾斜杠~~ | 2.0 已删外部代理链路，`--proxy-server` 不再存在 | 该坑的测试随链路一起删除，实录保留在 `doc/pitfalls/02-网络与代理.md` |
| 坑 12：✕ 点不动 | openbox 用了臆造的 `CloseButton` context | `static/consistency.test.js`（必须 `context name="Close"`） |
| 坑 13：假活接管 | ready 标记还在、进程全退，新版一直不重建 | `unit/runtime.test.js`（标记在 + 进程 DEAD → 判死）＋ static（RUNTIME_REV 参与指纹、`pgrep -x` 校验） |
| 坑 13：脚本漂移 | 「修复在包里 ≠ 修复在环境里」 | `static/consistency.test.js`（镜像与打包副本逐字节一致 + 无多余副本文件） |
| 坑 14：会话猝死 | `wait` 无兜底，任一组件退出全崩 | static（entrypoint 必须含 `sleep infinity &`） |
| 坑 14：XIM 错位 | ibus 注册到 WSLg 的 `:0`，串流窗口切不了输入法 | static（输入法段索引必须 > `export DISPLAY=:1`） |
| 坑 14：Chrome 陈旧锁 | `SingletonLock` 指向不存在的主机 | static（entrypoint 与 chrome-login.sh 都要清锁） |
| 坑 15：停止→启动死锁 | 熔断删默认路由，网关发现只认默认路由 | 网关解析链路已随 2.0 删除（`unit/route.test.js` / `unit/upstream.test.js` 一并移除）；保留 static（stopRuntime 中 unlock 先于 kill）＋ `integration/wsl.test.js`（lock→unlock 往返实测），以及 `static` 的「旧代理符号残留为零」 |
| 坑 16：中文输入 | 终端一个字打不进、Chrome 候选窗豆腐块 | `static/consistency.test.js`（启动器用 lxterminal 且无 `-xrm`；rime-setup 装 fcitx5-gtk3 模块；entrypoint 部署配色；自检查 `im-fcitx5.so`） |
| 坑 18：fcitx5 壳 | IBus 面板 VNC 天花板；guard 误杀；激活语义 | `static/consistency.test.js`（fcitx5 包清单；D-Bus 先于 guard；`-o`/`-s rime` 激活；词库迁 fcitx5 目录） |
| 坑 19：候选窗方框 | 词库含 U+20000+ 生僻字，Noto 子集无字形 | `static/consistency.test.js`（装 fonts-hanazono、按码位检查覆盖、fc-cache；禁用 noto-cjk-extra；名单未被删减） |
| 坑 20：零候选时窗口消失 | `ffff` 时候选窗 unmap + client preedit 把编码交给应用，退格全盲 | `static/consistency.test.js`（必须写 fcitx5/config 的 `[Behavior] PreeditEnabledByDefault=False`；page_size 保持 6 且不得回到 9）＋ `build/ime-repro.sh`（Xtigervnc :1 隔离复现，Map State 断言） |
| 坑 21：一键重置 | 只停机不销毁数据 = 换不掉身份；先销毁再停会让运行中的 Claude Code 把旧凭证写回磁盘 | `static/consistency.test.js`（先 stopRuntime 再 destroyAll、清就绪指纹、界面二次确认）＋ `unit/backend.test.js`（两后端都有 destroyAll） |
| 坑 22：容器内内核 + TUN | 宿主代理软件切 Direct 时界面假绿；DNS 被宿主 fake-ip 污染；MMDB 初始化死锁 | `unit/tun-config.test.js`（YAML 校验 / 节点名解析 / selectedNode / base64Chunks / 配置指纹 / 缓存回退）＋ `static/consistency.test.js`（tun-core 先于 net-guard、MMDB 预置、裸 curl、base64 分块、ready 标记）＋ `build/tun-product-verify.sh`（端到端实测） |
| **2.0：单态化** | 双链路/wslg 冗余回来、宿主代理又成运行时依赖 | `unit/core.test.js`（defaultConfig 无旧字段）＋ `unit/personas.test.js`（只两套画像、applyTo 只写 persona）＋ `static/consistency.test.js`（主进程/客机/界面/preload 四处旧符号残留为零、无 YAML 拒绝启动、TUN_NODE 贯通、独立报告窗口）＋ `integration/wsl.test.js`（客机无 proxy-router / local-proxy） |
| 坑 23：同步假绿 | `wsl.exe` 吞 `$` → 脚本没同步却报成功 → 客机跑 1.0.x 旧脚本、5 项自检失败 | `unit/guest-cmd.test.js`（base64 无损、md5 校验拒绝「只有 SYNCED」的假成功）＋ `static/consistency.test.js`（内联 `bash -c` 无裸 `$`、同步失败硬阻断、env 由 personas 派生、断言自身反向自检）＋ `unit/core.test.js`（mergeCfg 清旧 tz/lang）＋ `build/verify-sync-2x.js`（真实 WSL 端到端 22/22 校验） |
| 坑 24：节点解析分叉 | 宿主能选中节点、客机 `tun-merge.py` 却报「不在 proxies 列表中」→ 不起内核、`leak-detected` 全断网 | `unit/tun-merge.test.js`（两种 YAML 写法、中文/引号、proxy-groups 不误收、**客机与宿主解析同一份 YAML 结果一致**）＋ `static/consistency.test.js`（两边状态机同构、所有 .sh 无 `VAR=#` 垃圾行）＋ `build/verify-tun-e2e-2x.sh` / `verify-mihomo-config-2x.sh`（真实 merge + `mihomo -t`） |
| 坑 25：画像语言假绿 | 选美区后报告 `en-US` 全通过、实际 Chrome 仍繁中；`chromeLang` 是死字段，四处各猜各的，`app_locale` 没人写 | `unit/guest-lang-delay.test.js`（真实加载 Python 模块：`CHROME_LANG` 优先于冲突的 `LANG`、两套画像写对 `accept_languages`/`app_locale`、节点名只来自 YAML、摘要不编数字）＋ `static/consistency.test.js`（六个环节读 `CHROME_LANG`、启动期 `pkill -x chrome`、欢迎页不写死英文、自检单列 UI 语言、RUNTIME_REV 14）＋ `unit/personas.test.js`（洛杉矶 / 台北、`lang` 与 `chromeLang` 自洽）＋ `build/verify-203-2x.sh` / `verify-delay-api-2x.sh`（真实内核实测延迟） |
| 2.0.3：节点延迟 | 控制 API 未开、内置策略被当成节点；延迟展示出来却全是超时 | `static/consistency.test.js`（`external-controller` 仅回环、剥离订阅管道、延迟链路贯通）＋ `unit/guest-lang-delay.test.js`（`node_names_from_yaml` 排除 proxy-groups）＋ `build/verify-delay-api-2x.sh`（临时 mihomo 实例实测 `{"delay":203}` 并确认清理） |
| **2.1：主界面改版 DOM 契约** | UI 改版后 `renderer.js` 仍引用已删除的 `status/start/stop/guardBadge/egress/checkChip`，整页静默失效 | `static/consistency.test.js`（扫描渲染层全部 `$('id')` 与 `index.html` 的 id 求差集、引用数下限与抽样反向自检、顶栏/单行状态栏/弹窗骨架、main↔preload 窗口控制通道对齐、`frame:false`）＋ `build/ui-smoke/`（真实 Electron + mock preload 冒烟：无运行时异常、画像/节点/tab 渲染、弹窗开关与切换） |
| 坑 26：宿主假任务栏 | 宿主 DOM 又画一套 dock / 窗口标签 / 音量 / `new Date()` 时钟，与 VM 内 tint2 面板叠成两条任务栏、两个时钟（`04:30 PST` vs `20:30` 本机） | `static/consistency.test.js`（宿主 HTML/CSS/JS 与 main/preload 不得再出现 `dock` / `sbWindow` / `sbTime` / `updateClock` / `data-launch` / 客机启动 IPC；宿主状态栏恰好 1 行；tint2 是唯一真源：`panel_items=LTSC`、底部、4 个 `.desktop` 随镜像、entrypoint 启动、Dockerfile 预置）＋ `build/ui-smoke/`（`fakeTaskbar:false`、`statusRows:1`、`30px`） |
| App Icon 分叉 | 顶栏用 SVG、窗口/安装包用位图，两套几何色值不一致就变成两个图标；或又回到裁用户原图那条路 | `static/consistency.test.js`（`app-icon.svg` 的 viewBox/圆角/色值/`>` 折线/小方块/短横、两份 PNG 存在、`make-app-icon-2x.py` 与 SVG 同源且不引用原图、顶栏 `<img>`、主窗口与报告窗口都 `icon: APP_ICON`、`build.icon` 指向 512 位图、asar 打包路径）＋ `build/ui-smoke/`（`iconLoaded:true`） |
| **2.0：独立检查报告** | 报告遮罩盖住串流桌面、JSON 契约被改坏 | `static/consistency.test.js`（report.html/report.js 存在、独立 BrowserWindow、无 cp-mask、可导出 HTML）＋ `integration/wsl.test.js`（`check-env.sh --json` 的 groups 是数组） |
| 平台抽象（1.0.32） | macOS 移植：平台差异散进业务逻辑会失控 | `unit/backend.test.js`（pickBackendId / 工作区映射 / docker create 参数，直接 require `app/lib/vm-backend.js`）＋ static（main.js 不得直接 spawn wsl.exe、NOVNC_BIND=0.0.0.0、dist:mac 存在） |

## 单元测试怎么加载 main.js（loader）

`app/main.js` 是 Electron 主进程模块，顶部 `require('electron')`，纯 Node 环境无法直接 require。
当前方案（`tests/loader.js`）：**按起止标记切片 + `new Function` 注入依赖**。

- 每个 `SEGMENTS` 条目声明 start/end 标记（必须在源码中唯一，loader 启动时全量校验，
  标记失效会得到明确的失败信息而不是静默测错对象）；
- mock `runWsl`（按命令关键词路由到预置输出）、`waitPort`、`log`（收集器）等依赖后注入。

**写新测试的三步**：

1. 在 `loader.js` 的 `SEGMENTS` 里加一段（选唯一、稳定的标记，优先函数签名行）；
2. 在对应 `tests/unit/*.test.js` 里 `loadSegment(name, deps)`；
3. 断言写成「事故回放」风格：注释里写清楚坑的编号和症状，失败信息里带上拿到的东西。

**重构方向**：把纯函数抽到 `claude-desktop/app/lib/*.js`（无 Electron 依赖），
单元测试直接 `require`，loader 届时退役。迁移时每抽一个函数，同步把对应 SEGMENTS 删掉。

## 集成测试安全约定（L3）

`tests/integration/wsl.test.js` 会**真实修改容器内核路由表**，约定如下：

1. 改路由的用例只在环境**未运行**（`/run/claude-vm/ready` 为空）时执行；运行中的会话的
   熔断绝不能被测试解锁，否则相当于人为制造安全缺口；
2. 每个改路由的用例都在 `finally` 里兜底 `unlock`，并以「默认路由已恢复」收尾断言；
3. 跑 L3 前先在应用里点「停止」。

## 已知边界（这套测试不覆盖什么）

- **Electron 渲染层 UI 交互**：页面能否加载、DOM id 是否齐全、画像/节点/tab 渲染、
  设置弹窗开关与切换，已由 `build/ui-smoke/` 做无 VM 冒烟（静态断言另有一层 DOM 契约）；
  **webview 内部交互与真实 VM 联动**仍未覆盖，需要 Playwright/CDP 驱动（`build/cdp-*.js`）或人工验收；
- **真实代理出网质量**（出口 IP 归属地、checkcc 评分）——依赖外部服务，只在 L4 手工验证；
- **构建产物内容**（asar 逐字节、安装包里的脚本版本）——构建后手工核验，见交接文档；
- **rootfs 首次导入**——一次性成本，L4 覆盖。

## 发版前手工 checklist（L4）

按顺序走完才算一个版本可发：

1. `npm test` 全绿（含 L3）；
2. **重建 rootfs**（2.0 客机脚本大改，旧镜像里没有单态化脚本）；
3. `npm run dist:win` 构建成功，安装新包；
4. 导入 YAML → 节点下拉出现且能选；未导入时点「启动」应被明确拒绝；
5. 启动 → 就绪（串流桌面约 10~20 秒），桌面画面正常；
6. 串流桌面：点 ✕ 能关窗（坑 12）；
7. 串流终端：`Ctrl+Space` 能切到万象拼音（坑 14）；Chrome 图标能打开登录页；
8. 切换画像（台北 ↔ 美国）→ 提示重建 → 停止/启动后检查报告里时区、语言自洽；
9. **点「环境检查报告」**：新窗口打开，主窗口桌面画面不消失、仍能操作；报告可导出 HTML；
10. **点「停止」再立刻点「启动」**——坑 15 的完整场景，必须成功；
11. 检查报告无失败项；`vm.log` 里无未预期的 `[vm!]` 错误。
