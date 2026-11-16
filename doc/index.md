# ClaudeVM 技术文档索引

> 这是项目的技术文档 wiki，由 `开发交接.md`（730 行）按主题拆分而来。
> 原始全文不可变副本：[`raw/开发交接-原始全文-20261116.md`](raw/开发交接-原始全文-20261116.md)。
> 拆分的创建与变更记录见 [`log.md`](log.md)。

## 维护约定

- **单一信息源**：机制与「当前正确做法」写在本索引列出的主题文档；**踩坑实录原文**集中在 [`pitfalls/`](pitfalls/index.md)，主题文档用链接引用坑编号，不复制全文。
- **不可变源**：`raw/` 下的原文只读保留，用于核对拆分是否丢信息；不要直接编辑。
- **交叉引用**：正文使用相对路径 Markdown 链接（GitHub 可直接点击）；每个页面页脚标注更新日期与来源。
- **新增知识**：外部调研归 `references/`，决策结论归 `decisions/`，两者都回链到主题文档；随后在 `log.md` 追加一条。
- **坑编号**：全局唯一、只增不改；新增坑追加到 [`pitfalls/index.md`](pitfalls/index.md) 速查表并在测试里加断言。

## 概览 · overview

- [项目概览](overview/00-项目概览.md) — 两个工程、版本、主路径方向（WSLg 优先）、fail-closed 与画像定位
- [环境与启动](overview/01-环境与启动.md) — 环境要求、rootfs 获取两条路、npm 启动与首次导入耗时
- [目录地图与 IPC](overview/02-目录地图与IPC.md) — 代码树逐文件职责、界面与主进程的关键 channel

## 网络 · network

- [网络熔断](network/01-网络熔断.md) — netlink 改路由实现 fail-closed、预检/看门狗顺序、代理唯一出口
- [TUN 与 Mihomo](network/02-TUN与Mihomo.md) — 容器内内核接管、四条硬约束、端到端实测结论
- [直连盲点](network/03-直连盲点.md) — 代理软件运行中切 Direct 导致界面假绿（1.0.35 未修）
- [环境评分](network/04-环境评分.md) — checkcc 41 分构成、归因为「本地配置错误」的 0 分

## 桌面 · desktop

- [输入法](desktop/01-输入法.md) — IBus→fcitx5/Rime 万象演进、快捷键、零候选修复；实录见坑档案
- [显示模式](desktop/02-显示模式.md) — wslg 与 desktop(noVNC) 逐项对比、剪贴板/快捷键/输入边界

## 平台 · platform

- [Windows / WSL2](platform/01-Windows-WSL2.md) — 系统前置、WSLg 前提、发行版导入方式
- [macOS / 容器后端](platform/02-macOS-容器后端.md) — Docker/OrbStack、Rosetta、容器模型与验证清单

## 工程 · engineering

- [构建与打包](engineering/01-构建与打包.md) — 打包命令、rootfs 无 Docker 增量重建、版本对齐流程
- [测试体系](engineering/02-测试体系.md) — 三层结构（unit/static/integration）、跑法、发版 checklist
- [调试手法](engineering/03-调试手法.md) — CDP 调试、容器内自查命令、日志位置、常用脚本

## 安全 · security

- [身份与画像](security/01-身份与画像.md) — 独立身份只生成一次、时区语言对齐、画像不做伪装的边界
- [一键环境重置](security/02-一键环境重置.md) — 先停后销毁的顺序、两后端差异、保留项
- [已知边界](security/03-已知边界.md) — 网络/输入/显示的能力边界总览与未修问题索引

## 踩坑档案 · pitfalls

- [22 坑速查表](pitfalls/index.md) — 编号、一句话、归属主题、档案文件
- [脚本同步与假活](pitfalls/01-脚本同步与假活.md) — 坑 1/2/13
- [网络与代理](pitfalls/02-网络与代理.md) — 坑 3/8/15/22
- [输入法](pitfalls/03-输入法.md) — 坑 9/11/16/17/18/19/20
- [桌面与 Electron](pitfalls/04-桌面与Electron.md) — 坑 5/6/7/12/14
- [画像身份与构建](pitfalls/05-画像身份与构建.md) — 坑 4/10/21

## 架构决策 · decisions

- [显示模式选型](decisions/01-显示模式选型.md) — 为什么 WSLg 是主路径、noVNC 退居可选
- [输入法演进](decisions/02-输入法演进.md) — IBus→lxterminal→fcitx5 的取舍与「换壳不换引擎」
- [网络架构演进](decisions/03-网络架构演进.md) — netlink 熔断→容器内置内核 + TUN 的架构纠正
- [平台与范围取舍](decisions/04-平台与范围取舍.md) — Mac 后端、arm64、指纹浏览器、Claude Cage 的定位

## 外部参考 · references

- [防封教程要点](references/01-防封教程要点.md) — 夙愿学长 PDF 九章浓缩与对本项目的映射
- [Claude Cage 对比](references/02-Claude-Cage对比.md) — 强制点、租约、架构差异与可迁移点

---
*建立: 2026-11-16 | 来源: `开发交接.md`（730 行）| 全文 22 坑、9 章已全部分流*
