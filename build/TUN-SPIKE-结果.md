# TUN 技术验证 spike 实测结果（2026-11-16）

> ## 最终结论（17:45）：**通过，产品代码已落地**
>
> 下面前三轮的「未通过」是**把测试脚手架误当成了产品架构**。我拿宿主
> `192.168.240.1:7897` 当「宿主代理软件」来纠结要不要关 Clash；而用户指出的
> 正确形态是 —— **容器内自带 mihomo 内核 + TUN，宿主 Clash 只是导入/编辑 YAML
> 的辅助工具，运行时链路里没有它**。按这个架构重做后（见文末「第四轮」），
> DNS 归属、fake-ip 冲突、假绿、「要不要关 Clash」一次性全部消失，
> **用户不需要改动宿主任何设置**。
>
> 前三轮记录保留作排障史料，其中的结论已被第四轮推翻，别照着改代码。

**第一~三轮结论（历史）：未通过，未落地 TUN 产品代码。** 当时的判断是
「测试环境被宿主机的代理软件污染、裸 curl 并不裸」，据此要求用户关掉
Clash 的 TUN/系统代理再复测 —— **这个方向是错的**，见上面的最终结论。

> **2026-11-16 16:58 更正**：下面第 1 节「auto-route 没改默认路由」是误判。
> `/proc/net/route` 只显示 main 表（254）；用 netlink dump 全表后发现
> mihomo 把覆盖路由加在 **table 2022**（策略路由），共 22 条
> `0.0.0.0/1`、`128.0.0.0/2`、`192.0.0.0/9` … 全部指向 `198.18.0.2 dev Meta`。
> 即 **auto-route 是生效的**，DNS 劫持也生效（`getent` 返回 fake-ip `198.18.2.24`）。
> 真正卡住的是 fake-ip 记录缺失，见第 2 节。详见 `build/tun-diag2.sh` 与
> `build/tun-routes.py`。

复跑命令（不改产品代码，只写 /tmp/tun-spike，trap 自动恢复网络）：

```
MSYS_NO_PATHCONV=1 wsl.exe -d claude-vm -u root -- bash /mnt/e/Web/FuckCladue/build/tun-spike.sh
MSYS_NO_PATHCONV=1 wsl.exe -d claude-vm -u root -- bash /mnt/e/Web/FuckCladue/build/tun-diag.sh
```

## 环境与二进制

- WSL2 内核 `6.6.87.2-microsoft-standard-WSL2`；`/dev/net/tun` 存在（10,200），
  `tun` 模块已加载 → **TUN 设备本身可用**。
- `ip` 命令 MISSING（iproute2 未装），mihomo 未装。
- mihomo `v1.19.34` linux-amd64（22 MB gz）从 GitHub 经宿主 7897 下载成功。
- spike 前 VM 无桌面会话、net-guard 未运行，不影响用户环境。
- 代理节点 `192.168.240.1:7897`，WSL 内裸 curl 出口实测 `38.150.32.117`
  （正是本次分析过的美国 Cogent 节点）。

## 实测到的三件事实

### 1. TUN 能起来，但 auto-route 没改默认路由

启动后 `/proc/net/dev` 出现 `Meta` 网卡，`/proc/net/route` 只多了一条
`Meta 198.18.0.0/30` 的直连路由：

```
Meta  000012C6  00000000  0001 ... FCFFFFFF
```

默认路由**仍然是** `eth0 → 192.168.240.1`（和启动前逐字节一致）。
mihomo 日志：`[TUN] Tun adapter listening at: Meta([198.18.0.1/30]),
auto route: true, ip stack: Mips`，无 auto-route 报错。
→ 说明在 WSL2 里 `auto-route: true` 只创建了 TUN 网段路由，没有把默认路由切到 TUN。
   可能和 WSL 自己的网络管理/接口监控有关（日志有
   `[TUN] default interface changed by monitor, => eth0`）。**这是必须解决的头号问题**，
   否则流量根本不进 TUN，谈不上全局接管。

### 2. DNS 劫持生效，但 fake-ip 记录丢失导致连接失败

`curl -v --noproxy '*' https://api.ipify.org` 解析到 `198.18.2.24`（fake-ip 段）、
TCP 连上了，但 TLS 握手 `unexpected eof while reading` 失败。
mihomo debug 日志给出根因：

```
[Metadata PreHandle] error: fake DNS record 198.18.2.24 missing
[Metadata PreHandle] failed to sniff a domain for connection 198.18.0.1:52794 --> 198.18.2.24:443, give up
```

`/etc/resolv.conf` 仍是 WSL 自动生成的 `nameserver 10.255.255.254`，
**DNS 请求没有进 mihomo 的 1053 监听**，所以 fake-ip 映射表里没有记录，
TUN 收到的包反查不到域名就放弃了。
→ 必须让客机 DNS 真正指向 mihomo（改 resolv.conf + 关 WSL 自动生成，
   或启用 `dns-hijack` 配 `auto-redirect`），不能只配 `dns-hijack` 就以为生效。

### 3. 「kill 内核后应该断网」没有验成 —— 因为宿主代理接管了

spike 的 [C] 项本意是验证 fail-closed：杀掉 mihomo 后裸 curl 必须不通。
实测**反而通了**，出口 `38.150.32.117`。这不是 TUN 漏了，而是
VM 的默认路由一直指向 `192.168.240.1`（宿主网关），宿主机的 Clash Verge
在网关侧把 WSL 流量接管并转发到自己的节点。
所以这台机器上「不带 -x 的 curl」从一开始就不是裸连，
**用它测 fail-closed 或出口一致性都是无效的**。

WSL 每次调用还打印 `A localhost proxy configuration was detected but not
mirrored into WSL. WSL in NAT mode does not support localhost proxies.` —
与上面判断一致。

## 宿主 Clash 到底要不要关（用户 16:54 提问）

**不要整个关掉，但确实需要它「别接管」WSL 流量。**

- 关掉整个 Clash 会连带去掉 `192.168.240.1:7897` —— 那正是 spike 里
  mihomo 的唯一上游节点，关了就没出口可测，等于测不了。
- 真正污染测试的是 **Clash Verge 的 TUN / 系统代理 / DNS 劫持**：
  实测 VM 内没有任何 mihomo 时，`getent hosts api.ipify.org` 仍返回
  `198.18.2.24`（fake-ip 段），`/etc/resolv.conf` 是 WSL 自动生成的
  `10.255.255.254`，查询被宿主 Clash 接管并返回它自己 fake-ip 段的地址。
  VM 内 mihomo 收到目标 `198.18.2.24` 的包，查自己的 fake-ip 表必然
  `fake DNS record missing` → TLS 握手 `unexpected eof`。
- 所以最小改动：**在 Clash Verge 里关掉 TUN 模式 / 系统代理，只保留
  mixed-port 7897 监听（Allow LAN 保持开启）**。这样 WSL 的裸流量不再被
  网关侧接管，7897 仍能当上游。改完不用重启 VM。

## 为什么先不改产品代码

「TUN 并存可选」的决策不变（默认仍走现有 netlink 删路由链路）。
但 spike 暴露的前置问题没解决前，写进去的 TUN 模式会变成
「看起来开了、实际没接管」的假功能 —— 比不做更危险。必须先复测通过。

## 下一轮复测要做的三件事（按依赖顺序）

1. **宿主只关 TUN/系统代理，保留 7897**（用户手动，见上节）。
   判定标准：`curl --noproxy '*' https://api.ipify.org` 在 VM 内拿不到
   `38.150.32.117`，或直连超时 —— 证明「裸 curl 真的裸」。
2. **让 DNS 真正进 mihomo**：关 `/etc/wsl.conf` 的 `generateResolvConf`、
   写 `nameserver 127.0.0.1`、`dns.listen: 0.0.0.0:53`；
   **并且把 GeoIP/GeoSite 数据库预置到 `-d` 目录**，否则 mihomo 初始化时
   要下载 MMDB，而此刻 DNS 已指向它自己 → 死锁（`build/tun-diag3.sh`
   已踩到：`can't download MMDB: dns resolve failed ... 127.0.0.1:53
   connection refused`）。两阶段启动也不够，必须预置文件。
   再把 `fake-ip-range` 改成不与宿主撞的段（如 `198.19.0.1/16`）。
3. **用 netlink 全表 dump 验收**（`build/tun-routes.py`）：
   确认 table 2022 的覆盖路由指向 Meta；裸 curl 出口与三源一致；
   杀掉 mihomo 后策略路由随 TUN 一起消失、裸 curl 立刻不通。

三项通过后，再按「并存可选」的策略落产品代码：
`Dockerfile`（TARGETARCH 装 mihomo + iproute2）、配置新增 TUN 开关与 YAML 导入、
`entrypoint.sh` 分支、`net-guard.py` 改为「校验默认路由指向 TUN 且无第二条出口」、
静态断言与交接文档。

## 清理状态

spike 后已确认：路由表与启动前一致、无 Meta 网卡、无残留 mihomo 进程、
`resolv.conf` 已恢复为 `10.255.255.254`（diag3 的 trap 生效）。
恢复脚本 `build/tun-restore.py` 幂等，
异常退出后可执行 `python3 /mnt/e/Web/FuckCladue/build/tun-restore.py eth0 192.168.240.1`。

## 复跑资产（都在 build/，均不改产品代码）

| 文件 | 作用 |
|---|---|
| `tun-spike.sh` | 初版三场景（环路/接管/fail-closed），trap 自动恢复 |
| `tun-diag.sh` | 完整路由表 + curl -v，看出 fake-ip 与 TLS 失败 |
| `tun-routes.py` | netlink dump **所有**路由表，能看到策略路由 table 2022 |
| `tun-diag2.sh` | 证实 auto-route 生效（table 2022 共 22 条覆盖路由） |
| `tun-diag3.sh` | 把 DNS 收进 VM 内的尝试，暴露 MMDB 初始化死锁 |
| `tun-restore.py` | 幂等恢复默认路由 |

---

## 第四轮：按「容器内内核」架构重做（17:30-17:45，全绿）

复跑：`tun-builtin-spike.sh`（隔离验证）、`tun-product-verify.sh`（产品脚本端到端）。
**全程没有关闭或修改宿主 Clash**，它开着的 TUN / 系统代理 / 7897 全部保持原状。

### 架构（这才是产品形态）

```
应用（无 -x、无 HTTP_PROXY、Chrome 无 --proxy-server）
  -> TUN Meta（mihomo auto-route，table 2022 策略路由覆盖）
  -> 容器内 mihomo（DNS 127.0.0.1:53，fake-ip 198.19.x，规则来自导入的 YAML）
  -> 用户 YAML 里的上游节点（spike 用 192.168.240.1:7897 模拟海外节点）
  -> eth0 on-link（net-guard 保留的唯一通路）

宿主 Clash：只提供/编辑 YAML，不参与 DNS、不参与路由决策、不是运行时依赖。
net-guard：仍删 main 表默认路由，作为 fail-closed 底座。
```

关键点：把宿主 7897 **当成 YAML 里的一个上游节点**，而不是「宿主代理软件」。
这样 WSL 自动生成的 DNS 代理（10.255.255.254）与宿主 fake-ip 段（198.18.x）
都被绕开 —— DNS 指向容器内 127.0.0.1 后，查询根本不会到宿主那儿去。

### 实测结果

| 验证项 | 结果 |
|---|---|
| net-guard lock | main 表默认路由删除成功，只留 192.168.240.0/20 |
| TUN 接管 | table 2022 共 22 条覆盖路由全部指向 Meta（198.19.0.2） |
| DNS 归属 | `getent api.ipify.org` → **198.19.0.4**，由容器内内核分配，不再是宿主 198.18.x |
| 应用侧裸 curl（无 -x、清掉代理环境变量） | api.ipify.org / ipinfo.io / api.ip.sb **三源一致 38.150.32.117** |
| net-guard.sh once（TUN 分支预检） | 退出码 0，state=guarded，出口 38.150.32.117 · US · Los Angeles |
| **fail-closed** | 杀掉内核 → table 2022 随 TUN 消失 + main 表无默认路由 → 立刻全断 |
| 清理 | resolv.conf、默认路由、Meta 网卡、进程全部恢复干净 |

### 过程中修掉的三个真问题

1. **53 端口被占**：`10.255.255.254:53` 是 WSL 自带 DNS 代理，
   mihomo 绑 `0.0.0.0:53` 会 `bind: address already in use`。
   → 只监听 `127.0.0.1:53`（resolv.conf 本来就指这里）。
2. **default interface lost by monitor**：main 表没默认路由时
   `auto-detect-interface: true` 找不到默认接口。
   → 改 `auto-detect-interface: false` + 显式 `interface-name: eth0`（由 tun-merge.py 动态取）。
3. **MMDB 初始化死锁**：DNS 指向内核自己后，启动时要下载 GeoIP 会解析失败。
   → 数据库预置进镜像（Dockerfile），tun-core.sh 启动前检查，缺了就保持全断网。

还有一个时序坑：只等 Meta 网卡出现就继续是不够的，网卡先于 resolv.conf
切换出现，那个窗口里 `getent` 仍会问到 WSL 的 DNS 代理（返回 198.18.2.24）。
→ 加显式 `/run/claude-vm/tun-ready` 标记，entrypoint 与验证脚本一律等它。

### 产品落地清单（本轮已写）

| 文件 | 作用 |
|---|---|
| `claude-vm/vm/Dockerfile` | TARGETARCH 装 mihomo（amd64/arm64）、iproute2、预置 geoip.metadb / geosite.dat |
| `claude-vm/vm/scripts/tun-merge.py` | 合并用户 YAML 与 TUN 增强段；解析节点域名、补 /32 主机路由、生成 route-exclude-address |
| `claude-vm/vm/scripts/tun-core.sh` | 起内核、切 DNS、就绪标记、看门狗自动拉起 |
| `claude-vm/vm/scripts/entrypoint.sh` | TUN_MODE 分支，必须在 net-guard 之前；清 local-proxy 避免双层代理 |
| `claude-vm/vm/scripts/net-guard.sh` | TUN 分支：裸 curl 预检/看门狗、内核+网卡存活检查、占位 lock |
| `claude-desktop/app/lib/tun-config.js` | 宿主侧校验 / 读外部 YAML / 缓存 / 配置指纹 |
| `claude-desktop/app/main.js` | base64 分块注入 YAML、clash:pick IPC、TUN_MODE env、指纹接线、RUNTIME_REV 11 |
| 界面 / preload | TUN 开关、选择外部 YAML、联动灰显旧代理输入 |
| 测试 | 坑 22 共 6 条静态断言 + tun-config 7 条单测，合计 108/108 全绿 |

### 仍需注意

- **当前 VM 的 rootfs 是旧镜像**，没有随包内核。本轮验证是把 spike 下载的
  mihomo 与 geoip.metadb 临时装进 `/usr/local/bin/mihomo`、`/opt/mihomo/` 跑通的；
  脚本已同步进 VM 与已安装应用，但**换一台机器 / 全新安装必须重建 rootfs**。
- 上游节点是域名时，`tun-merge.py` 会在「还有默认路由」时解析成 IP 并补 /32 路由；
  解析不了直接判失败、保持全断网，不会带病放行。
- 用户导入的 `mode: direct` 会被纠正为 `global`，否则 TUN 里的流量会全部直连。
- TUN 模式下 `route-exclude-address` 只保留 main 表的直连网段 + 节点/DNS 的 /32，
  避免内核自己的出站回灌 TUN 形成环路。
