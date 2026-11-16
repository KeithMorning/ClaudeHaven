# 内置 Mihomo + TUN 全局接管

> 1.0.37 落地，并存可选，**默认仍走旧链路**（netlink 删路由 + 显式代理）。
> 这套架构纠正了前三轮 spike 的方向错误，是本项目网络层的产品形态。

## 架构（这才是产品形态）

```
应用（无 -x / 无 HTTP_PROXY / Chrome 无 --proxy-server）
  -> TUN Meta（mihomo auto-route，table 2022 策略路由覆盖）
  -> 容器内 mihomo（DNS 127.0.0.1:53、fake-ip 198.19.x、规则来自导入的 YAML）
  -> 用户 YAML 里的上游节点
  -> eth0 on-link（net-guard 保留的唯一通路）

宿主 Clash：只提供/编辑 YAML，不参与 DNS、不参与路由决策、不是运行时依赖。
net-guard：仍删 main 表默认路由，作为 fail-closed 底座。
```

**关键认知**：宿主软件从「运行时依赖」降级为「导入/编辑 YAML 的辅助工具」。按此重做后，
「宿主切 Direct 会不会假绿」「DNS 被宿主 fake-ip 污染」「要不要关 Clash」三个问题一次性消失，
**用户不需要改任何宿主设置**。此前纠结这些是把测试脚手架当成了产品架构 —— 决策复盘见
[网络架构演进](../decisions/03-网络架构演进.md)。

## fail-closed 为什么更干净

内核活着：table 2022 覆盖路由把全部流量送进 TUN。
内核一挂：TUN 与策略路由一起消失，而 main 表没有默认路由 → **立刻全断，无需检测动作**。
这比旧链路「看门狗发现异常再断」更结构化。底座仍是[网络熔断](01-网络熔断.md)。

## 四条硬约束（改这块前先读）

1. **tun-core 必须在 net-guard 熔断之前启动**：内核要在还有默认路由时解析节点域名、
   读预置 MMDB、补 `/32` 主机路由；默认路由一删这些全做不了。MMDB 必须随镜像预置，
   否则 DNS 指向内核自己后启动会撞上「下载 MMDB 解析失败」的死锁。
2. **DNS 必须收进 127.0.0.1，并等显式 `tun-ready` 标记**：网卡先于 resolv.conf 切换出现，
   只等 Meta 网卡会让 getent 问到 WSL 的 DNS 代理（返回宿主 fake-ip 198.18.x）。
   mihomo 只监听 `127.0.0.1:53` —— `0.0.0.0:53` 会被 WSL 自带 DNS 代理占用。
3. **TUN 分支的预检/看门狗一律裸 curl**：`PROXY_URL` 必须为空，硬编码 `-x "$PROXY_URL"`
   会去测一个不存在的端口（这是旧版假绿的来源）。同时清掉 `/opt/config/local-proxy`，
   否则 Chrome 仍带 `--proxy-server` 形成双层代理。
4. **YAML 用 base64 分块注入**：Windows `execFile` 命令行上限 32767 字符，订阅 YAML 动辄
   100KB+；把原文拼进 `bash -c` 还会被引号/$/反斜杠打断。配置内容进 `cfgFingerprint`，
   外部改了订阅必须重建会话，不能「接管」旧内核。

## 落地文件

| 文件 | 作用 |
| --- | --- |
| `claude-vm/vm/Dockerfile` | TARGETARCH 装 mihomo（amd64/arm64）、iproute2、预置 geoip.metadb / geosite.dat |
| `vm/scripts/tun-merge.py` | 剥离用户 YAML 的 tun/dns/mode 段、解析节点域名、给节点/DNS 补 /32 主机路由、生成 route-exclude-address |
| `vm/scripts/tun-core.sh` | 起内核、切 DNS 到 127.0.0.1、tun-ready 标记、看门狗自动拉起 |
| `vm/scripts/entrypoint.sh` | TUN_MODE 分支，必须在 net-guard 之前；清 local-proxy 避免双层代理 |
| `vm/scripts/net-guard.sh` | TUN 分支裸 curl 预检、pgrep mihomo + Meta 网卡存活检查、占位 lock |
| `app/lib/tun-config.js` | 宿主侧校验 / 读外部 YAML / 缓存(600) / 配置指纹 |
| `app/main.js` | base64 分块注入、clash:pick IPC、TUN_MODE env、RUNTIME_REV 11 |
| 界面 / preload | TUN 开关、外部 YAML 选择、联动灰显旧代理输入 |

用户 YAML 的 `mode: direct` 会被纠正为 `global`，否则 TUN 里的流量会全部直连。
`route-exclude-address` 只保留 main 表直连网段 + 节点/DNS 的 /32，避免内核出站回灌 TUN 成环。

## 实测结论

`build/tun-product-verify.sh`（产品脚本端到端，**全程未动宿主 Clash**）：

| 验证项 | 结果 |
| --- | --- |
| DNS 归属 | `198.19.0.4`，容器内内核分配，不再是宿主 198.18.x |
| 裸 curl 三源出口 | ipify / ipinfo / ip.sb 一致 |
| `net-guard.sh once` | 退出码 0，`state=guarded` |
| 杀内核 | 策略路由随 TUN 消失 + main 表无默认路由 → 立刻全断 |
| 清理 | resolv.conf / 默认路由 / Meta 网卡 / 进程全部复原 |

测试：坑 22 静态断言 6 条 + `tun-config` 单测 7 条。四轮 spike 的完整过程（含三个中途坑：
53 端口被占、default interface lost、MMDB 死锁）见 `build/TUN-SPIKE-结果.md`。

## 限制

- 上游节点是域名时，在「还有默认路由」阶段解析成 IP 并补 /32；解析不了直接判失败并保持全断网。
- 1.0.37 之前生成的 rootfs 不含内核与数据库，**换机器 / 全新安装必须重建**，见
  [构建与打包](../engineering/01-构建与打包.md)。
- arm64 只覆盖了内核二进制，apt 源 / Node / Chrome / PATH 仍是 amd64，见
  [平台与范围取舍](../decisions/04-平台与范围取舍.md)。

---
*更新: 2026-11-16 | 来源: `开发交接.md` 第 7 节 TUN 部分 + 坑 22 + `build/TUN-SPIKE-结果.md`*
