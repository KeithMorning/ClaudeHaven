# 文档变更日志

> append-only，只追加不改写。格式参考 llm-wiki：`## [日期] 动作 | 标题`。
> 记录文档结构变更与重要知识更新；代码提交历史看 `git log`。

## [2026-11-17] ui | App Icon 接入（矢量真源 + 位图导出）

- 用户提供 `Dark Terminal Icon Without Badge.png`（深色圆角方块 + 橙色 `>_`），
  但那是 1199×1312 的非正方形位图。按用户要求不做裁图/像素处理，直接**手写 SVG 照着画**：
  `claude-desktop/app/renderer/assets/app-icon.svg`（512 viewBox / `rx=112` / `#14141f` 底 /
  `#f0825a` 橙 / `>` 折线 + 右上小方块 + 下方短横）。
- 系统窗口与安装包图标只认位图，`build/make-app-icon-2x.py` 用**同一套几何与色值**
  导出 `build/icon.png`(512) 与 `app/renderer/assets/app-icon.png`(256)，完全不依赖用户原图。
  三处接线：顶栏 `<img src="assets/app-icon.svg">`（去掉旧的橙色渐变底 + 手绘箭头）、
  主窗口与独立报告窗口 `icon: APP_ICON`；`package.json` 的 `build.icon` 原已指向
  `build/icon.png`，换同名文件即生效。
- 回归：`static/consistency.test.js` 新增 App Icon 断言（SVG 几何与色值、两份 PNG 存在、
  生成脚本与 SVG 同源且不依赖原图、三处接线、两个窗口都设图标、asar 打包路径）；
  `build/ui-smoke` 增加 `iconLoaded` 检查。全量 **143/143**，真实 Electron 冒烟
  `errors: []` / `iconLoaded: true`。
- 未打包（图标会在下次 `npm run dist:win` 时随 NSIS 生效），未重建 rootfs。

## [2026-11-17] ui | 坑 26：宿主假任务栏删除，任务栏归属虚拟机

- 用户指正：2.1 主界面在宿主 Electron DOM 里画了一套「假任务栏」（dock 四图标 /
  窗口标签 `New chat - Claude - Google Chrome` / 音量 / `new Date()` 时钟），
  与串流画面里 VM 自带的 tint2 面板上下叠成两条，出现两个时钟（`04:30 PST` vs `20:30` 本机）。
- 证据：VM 内 `entrypoint.sh:353` 启动 tint2，`vm/config/tint2rc` 为 `panel_items = LTSC`
  （启动器 / 任务栏 / 托盘 / 时钟）、`panel_position = bottom`，4 个 `claude-*.desktop`
  指向 `/opt/scripts/run-*.sh`，`time1_format=%H:%M` + `time2_format=%a %d %b`；
  面板窗口 `1574x46 +0+734`，客机 `TZ=America/Los_Angeles` → `04:37 / Tue 17 Nov`。
- 本轮范围（用户明确收敛）：**只删假任务栏**。`index.html` 去掉 `sb-top` 整行与
  `i-volume` 死图标，`statusbar` 62px→30px 单行；`renderer.js` 删 `updateClock` /
  `sbWindow` / dock 点击与 20s 定时器；`preload.js` 删 `launchGuest`；`main.js` 删
  `DOCK_SCRIPTS` 与客机启动 IPC（VM 的 .desktop 自己拉起程序，不经宿主）。
- **保留**：底部单行网络节点信息（`sbPersona` / `sbLatency` / `sbGuard` / `sbItems`）——
  这是宿主侧状态，不是任务栏。**不动** VM 内 tint2 配置与样式，保持现状。
- 回归防线：新增坑 26 两条静态断言（宿主 HTML/CSS/JS 不得再出现 dock / 窗口标签 /
  时钟 / 客机启动 IPC；tint2 是唯一真源且 4 个 .desktop 随镜像提供），更新 2.1 骨架与
  通道断言；`build/ui-smoke` 增加 `fakeTaskbar` / `statusRows` / `statusbarHeight` 检查。
- 全量 **142/142**；真实 Electron 冒烟 `errors: []`、`statusRows: 1`、`30px`、
  `fakeTaskbar: false`、网络节点信息行仍在。
- 未做：VM 任务栏美化（设计稿样式）、App Icon 接入
  （`~/Downloads/Dark Terminal Icon Without Badge.png`）、rootfs 重建、打包、提交 ——
  用户要求本轮只删假任务栏，留待后续。

## [2026-11-17] ui | 2.1 主界面改版（第一阶段，环境检查留到下一轮）

- 按 6 张设计稿重做主界面：深色自定义无边框顶栏（logo / 运行中徽章 / 工作区·环境检查·设置导航 / 窗口控制）、
  奶油色波浪串流舞台、双行深色状态栏（Dock / 窗口标题 / 画像·延迟·锁定 / 音量 / 时钟）、
  浅色设置弹窗（环境画像 / 网络与安全 / 工作区与输入 / 高级与重置 四个 tab）。
- 骨架与样式（`index.html` / `styles.css`）、主进程（`frame:false` + `win:*` + `guest:launch`
  白名单 + base64 避开吞 `$`）、preload 通道在上一阶段已落地；本轮补齐 **`renderer.js` 接线**：
  所有状态统一由 `running` 布尔派生，不再依赖已删除的旧 id；提示同时落在设置弹窗底部与状态栏，
  弹窗关着时也看得见；画像 / 延迟 / 守卫 / 时钟实时写进状态栏。
- 关键教训：UI 改版最容易断在「渲染层引用的 DOM id 已不存在」，且旧静态测试完全覆盖不到。
  新增 **2.1 DOM 契约**断言：扫描 `renderer.js` 所有 `$('id')` 与 `index.html` 的 id 求差集，
  并做反向自检（注入 `definitelyMissingId` 必须被抓到，实测生效）。
- 真实 Electron 冒烟：`build/ui-smoke/`（mock preload、不启动 VM、不弹可见窗口）加载真实页面，
  验证 `errors: []`、2 画像 / 3 节点 / 4 tab、状态栏地区与时钟、设置弹窗打开→切 tab→保存关闭。
  注意 WorkBuddy 自身是 Electron，子进程继承 `ELECTRON_RUN_AS_NODE=1`，运行前必须 `env -u` 清掉。
- 全量 **140/140**。本轮**只做主界面**：`report.html` / `report.js` 与检查浮层接线留到下一轮；
  未打包、未改版本号、未提交。
- 注（坑 26 更正）：本条里的「双行状态栏 / Dock / 窗口标签 / 音量 / 时钟 / `guest:launch`」
  已在坑 26 中删除 —— 那是画在宿主里的假任务栏，真正任务栏是 VM 内的 tint2 面板。
  此处保留原文作为历史记录；以坑 26 条目为准。

## [2026-11-17] fix | 坑 25：画像语言不跟浏览器走 + 节点延迟展示（2.0.3）

- 需求收敛：**不做「画像按出口 IP 自动对齐」**。真实出口只有内核起来后才知道，
  而 `TZ/LANG` 在 `spawnEntry(env)` 那一刻定死、运行中改不动；自动对齐要么两阶段启动、
  要么下次启动才生效。固定两套画像：**台北**（`Asia/Taipei` / `zh_TW` / `zh-TW`）与
  **洛杉矶**（`America/Los_Angeles` / `en_US` / `en-US`）。美区 id 仍为 `us`，
  避免旧 `config.json` 被 `byId` 兜底成台北。
- 现象：选美区画像后报告显示 `en-US` 全通过，实际浏览器仍是繁体中文。
- 根因（三处叠加）：
  1. `personas.js` 的 `chromeLang` 是**死字段**，没有任何客机脚本读它；
     entrypoint 的 `--set`、`chrome-login.sh`、`check-env.sh` 各自从 `LANG` 猜，
     `show-welcome.sh` 甚至写死 `--lang=en-US`。
  2. `chrome-lang.py --set` 只写 `intl.accept_languages`，**不写 `intl.app_locale`**
     （Chrome UI 语言）。`--lang` 在已有 Chrome 实例时会被忽略（`exec` 把 URL 交给旧实例），
     旧实例退出时还会把内存里的旧语言写回磁盘。
  3. 报告「浏览器语言头」是复制 Profile 到临时目录用 headless 测的 —— 测的是磁盘值，
     与活着的 Chrome 是两回事，所以报告假绿。
- 修复：主进程按画像下发 `CHROME_LANG` 并落盘 `runtime-env`；六个环节
  （main / entrypoint / chrome-login / show-welcome / chrome-lang.py / check-env）统一读它；
  `--set` 同时写 `app_locale`；启动期 `pkill -x chrome` 清残留实例；自检新增
  「浏览器 UI 语言」项，不一致直接判失败。`RUNTIME_REV` 13→14：画像 id 没变但时区变了，
  不 bump 会 resume 旧会话继续用美东时间。
- 延迟展示：`tun-merge.py` 生成 `external-controller: 127.0.0.1:9090`（仅客机回环，
  并剥离订阅的 `external-controller-pipe/cors`）；新增 `node-delay.py` 经控制 API 实测
  各节点往返延迟 → 宿主 `nodes:latency` IPC → 节点下拉显示 `· 197ms`、启动后自动测一次、
  也可手动点「测延迟」；检查报告新增「节点延迟」项读落盘摘要。
  节点名**复用 `tun-merge.node_names()` 从注入的 YAML 取**，不用 `/proxies` 的 type 黑名单 ——
  实测 mihomo v1.19.34 会把 `PASS-RULE` 等内置策略列出来，黑名单永远追不上版本。
- 验证：全量 **136/136**；真实 WSL 里两套画像语言落地（临时 Profile、故意让 `LANG` 冲突）、
  `mihomo -t` 报 `test is successful`、临时内核（无 TUN、测完即杀）实测
  `LAX-Cogent-Reality 197ms` / `LAX-NTT-Reality 213ms`，延迟结果只含 3 个真实节点。
- 版本 **2.0.2 → 2.0.3**；rootfs 同步重建（23 个脚本）。

## [2026-11-17] fix | 坑 24：节点解析两边分叉导致内核不启动（2.0.2 修复）

- 现象：装 2.0.1 后脚本同步已生效（`reason` 从 `no-proxy` 变成 2.0 的 `leak-detected`，
  画像/节点/env 全部正确），但自检仍 5 失败；日志给出直接原因：
  `[tun-core] 严重：配置合并失败：tun-merge.py: 选中的节点 'LAX-Cogent-Reality' 不在 proxies 节点列表中`。
- 根因：用户订阅把 `name` 写在列表项**第二行**（`  - type: vless` 后跟 `    name: xxx`）。
  宿主 `tun-config.js` 的 `extractNodes` 按 `^\s*-\s+` 切项、项内再找 name，所以界面能显示并选中；
  客机 `tun-merge.py` 的 `node_names()` 只认 `- name:` 开头 → 返回空列表 → 拒绝 merge →
  不写 tun-ready、不切 resolv.conf、不起内核 → net-guard 判 `leak-detected` 全断网。
  **同一份 YAML 两边解析规则分叉**，是 2.0 单节点改造时客机侧没跟齐宿主。
- 修复：`node_names()` 改为与宿主同构的列表项状态机（支持 name 在首键/第二行、引号、中文空格、
  行内注释、proxy-groups 里的 name 不误收）；另删掉 `net-guard.sh` 里
  `GUARD_DIR=# ====...` 这行垃圾（`#` 紧跟 `=` 不是注释，bash 会把 `====` 当命令执行）。
- 回归防线：`tests/unit/tun-merge.test.js`（8 例，含「客机与宿主解析同一份 YAML 结果一致」），
  `tests/static/consistency.test.js` 加「所有 .sh 不得有 VAR=# / 裸分隔线」与「两边解析同构」。
  全量 **125/125**。
- 真实环境验证：`build/verify-node-names-2x.py`（3 节点全解析、选中节点命中）、
  `build/verify-tun-e2e-2x.sh`（merge exit=0，生成 `mode: rule` + ClaudeVM 单节点组 +
  MATCH 兜底 + fake-ip 段，订阅分流已剥离）、`build/verify-mihomo-config-2x.sh`
  （`mihomo -t` 报 `test is successful`，三个脚本语法检查通过）。
- 版本 **2.0.1 → 2.0.2**；rootfs 同步重建。用户装完点「停止 → 启动」重建会话。

## [2026-11-17] fix | 坑 23：wsl.exe 吞 `$` 导致脚本同步假绿（2.0.1 修复）

- 现象：装 2.0.0 后自检 16 通过 / 5 注意 / 5 失败，报告文案是 2.0 的，
  却显示 `no-proxy`「未配置代理」这类 1.0.x 措辞；客机 mihomo 未运行、Meta 网卡不存在。
- 根因：`syncScripts()` 把含 `$f` / `$(basename)` 的脚本内联进 `bash -c` 交给 wsl.exe，
  `$` 被吞（实测 `X=hello; echo "X=$X"` → `X=`，与安装路径是否带空格无关）；
  `cp` 全失败被 `2>/dev/null` 吞掉，末尾 `echo SYNCED` 照常打印 → 判定同步成功（假绿）。
  发行版里一直跑 1.0.37 的 entrypoint/net-guard：它们要 `TUN_MODE=1` 才起内核，
  而 2.0 只传 `TUN_NODE`，于是内核没起、net-guard 按「未配置代理」熔断全断网。
- 证据：`/opt/scripts/entrypoint.sh=a85bf292`、`net-guard.sh=32d79b02` 与 1.0.37 包精确一致，
  时间戳停在 11-16 04:43；随包 `rootfs.tar.gz` 内脚本同样是 1.0.37 版。
- 修复：新增 [`app/lib/guest-cmd.js`](../claude-desktop/app/lib/guest-cmd.js)（base64 管道 +
  逐文件 md5 校验），同步失败直接中止启动；`cfg.tz/cfg.lang` 从配置里清除，
  env 一律由 `personas.byId()` 派生；`RUNTIME_REV` 12 → 13。
- 重建 rootfs：22 个脚本与源码逐字节一致，清除 `proxy-router.js`，保留 mihomo/GeoIP。
- 教训：脚本文件方式 / base64 管道正常，内联 `bash -c` 一律不得含裸 `$`；
  `grep -q` + `pipefail` 的 SIGPIPE 误判在重建脚本里又一次踩到，改为「条目落盘 + `grep -Fxq`」。
- 回归防线：`tests/unit/guest-cmd.test.js`（11 例）＋ `tests/static/consistency.test.js` 坑 23 四条断言；
  真实 WSL 端到端验证 22/22 md5 一致。全量测试 115/115。

## [2026-11-16] redesign | 2.0 单态化重构（删除冗余功能）

- 决策页：[`decisions/05-2.0重构-单态化.md`](decisions/05-2.0重构-单态化.md)。
- 四条：① 删外部代理链路，容器内 mihomo + TUN 全量单节点接管；② 删 wslg，只留串流桌面；
  ③ 伪装画像收敛成两套（台北 / 美国）；④ 检查报告改独立窗口、可导出 HTML。
- 主进程 `main.js` 1358 → 866 行；删除 `proxy-router.js` 及旧代理分支；
  配置字段换成 `persona / selectedNode / clashYamlPath`，env 换成 `TUN_NODE`。
- 新增 `app/lib/personas.js`、`renderer/report.html` + `report.js`；
  `tun-config.js` 增加节点名解析 / selectedNode / base64Chunks。
- 版本 1.0.37 → **2.0.0**，`RUNTIME_REV` 11 → 12。
- 索引置顶「当前架构」块，标注历史页面；`pitfalls/` 按约定不改写原文。
- 矛盾提示：`doc/desktop/02-显示模式.md`、`doc/decisions/01-显示模式选型.md`、
  `doc/network/03-直连盲点.md` 描述的是**已删除**的 1.0.x 能力，
  保留为历史依据，不作为实现依据；以 `decisions/05` 与 `network/02` 为准。
- 本轮交付：代码 + 全量测试；rootfs 重建与安装包留到下一轮。

## [2026-11-16] restructure | 拆分 开发交接.md 到 doc/ 技术文档 wiki

- 来源：`开发交接.md`（730 行，1.0.37）。原始全文复制到 `doc/raw/开发交接-原始全文-20261116.md`，只读保留。
- 建立分类：`overview/` `network/` `desktop/` `platform/` `engineering/` `security/` `pitfalls/` `decisions/` `references/`。
- 建立 `doc/index.md`（内容目录 + 维护约定）与本日志。
- 分流原则：机制与「当前做法」写主题文档；22 个踩坑实录原文按类归入 `pitfalls/` 五个文件，主题文档只引用坑编号，不复制全文。
- 新增决策记录 4 篇、外部参考 2 篇：把此前只在会话里的调研结论（Claude Cage、OrbStack、防封 PDF、arm64、TUN 架构纠正）固化下来。
- 待办：更新 `README.md` / `claude-vm/README.md` / `build/pack-dev-src.py` 的引用与源码包白名单。

## [2026-11-16] knowledge | 内置 Mihomo + TUN 架构纠正（坑 22）

- 结论：容器内自带内核 + YAML + TUN，宿主 Clash 只是编辑 YAML 的辅助工具，不进运行时链路。
- 产品脚本端到端实测通过（DNS 归属 198.19.0.4、三源出口一致、杀内核立刻断）；详见 `build/TUN-SPIKE-结果.md` 第四轮。
- 归档到 `network/02-TUN与Mihomo.md` 与 `decisions/03-网络架构演进.md`。

## [2026-11-16] knowledge | 一键环境重置落地（坑 21）

- 顺序硬约束：先 `stopRuntime()` 再 `destroyAll()`；两后端销毁语义不同；界面两段式确认。
- 归档到 `security/02-一键环境重置.md`。

## [2026-11-09] knowledge | 输入法定案 fcitx5 + 零候选修复（坑 18/19/20）

- IBus 面板到天花板 → 换 fcitx5（换壳不换引擎）；CJK 扩展 B 区补 HanaMin；零候选时关 client preedit 保住候选窗。
- 归档到 `desktop/01-输入法.md` 与 `pitfalls/03-输入法.md`。

---
*最后更新: 2026-11-16*
