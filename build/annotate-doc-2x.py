#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 doc/ 里描述 1.0.x 已删能力的页面加顶部「历史档案」注记。

按 llm-wiki 的约定：不删除旧内容，只加带日期的更新注记并指向当前架构页。
可重复执行（已加过注记的文件跳过）。
"""
import os

ROOT = r'E:\Web\FuckCladue\doc'

# 文件 -> 该页里已经过时的具体点
PAGES = {
    'overview/00-项目概览.md': 'WSLg 主路径、双模式分支、HTTP_PROXY 旧链路、TUN 并存',
    'overview/01-环境与启动.md': '两种显示模式选择、wslg 启动耗时',
    'overview/02-目录地图与IPC.md': '代理探测、wslg 专用 IPC、显示模式配置',
    'network/01-网络熔断.md': '宿主代理端口、netlink 删路由作为唯一手段、坑 15 网关解析',
    'network/02-TUN与Mihomo.md': '「并存可选，默认仍走旧链路」的开关描述',
    'network/03-直连盲点.md': '整页：宿主代理软件运行中切 Direct 导致假绿（2.0 已从架构上消除）',
    'desktop/02-显示模式.md': '整页：wslg 与 desktop 双模式对比（2.0 只剩 desktop）',
    'platform/01-Windows-WSL2.md': 'wslg(:0) 分支、WSLg 窗口存活、旧代理网关死锁',
    'platform/02-macOS-容器后端.md': '「macOS 只有串流桌面（没有 WSLg）」这句现已全局成立',
    'security/03-已知边界.md': '「旧链路直连盲点 ❌」与两种显示模式的能力边界',
    'decisions/01-显示模式选型.md': '整页：为什么 WSLg 是主路径（2.0 已删 WSLg）',
    'decisions/03-网络架构演进.md': '「TUN 并存可选、默认旧链路」的兼容策略',
    'pitfalls/02-网络与代理.md': '坑 3/8/15 描述的是已删除的宿主代理链路',
    'pitfalls/04-桌面与Electron.md': '坑 7/14 描述的是已删除的 wslg / 双模式',
    'engineering/02-测试体系.md': '坑 3/15 相关的旧单测已删除',
    'engineering/03-调试手法.md': 'DISPLAY=:0、wslg-* 脚本、chrome-proxy-test.sh',
    'references/01-防封教程要点.md': '「我们曾用 netlink 删默认路由」的时态描述',
}

HEADER = (
    '> **⚠️ 历史档案（2.0 起部分内容已过时，{date}）**\n'
    '> 本页保留 1.0.x 时期的完整记录，作为「为什么不再这么做」的依据。\n'
    '> 已过时的点：**{what}**。\n'
    '> **当前架构以 [`decisions/05-2.0重构-单态化.md`](../decisions/05-2.0重构-单态化.md) 与\n'
    '> [`network/02-TUN与Mihomo.md`](../network/02-TUN与Mihomo.md) 为准。**\n'
    '\n'
)

MARK = '历史档案（2.0 起部分内容已过时'
done, skipped = [], []
for rel, what in PAGES.items():
    p = os.path.join(ROOT, rel.replace('/', os.sep))
    if not os.path.isfile(p):
        print(f'[跳过] 不存在: {rel}')
        continue
    with open(p, 'r', encoding='utf-8') as f:
        text = f.read()
    if MARK in text:
        skipped.append(rel)
        continue
    lines = text.split('\n')
    # 在 H1 标题之后插入注记；没有 H1 就放最前面
    idx = 1 if lines and lines[0].startswith('# ') else 0
    block = HEADER.format(date='2026-11-16', what=what).rstrip('\n').split('\n')
    lines[idx:idx] = block + ['']
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write('\n'.join(lines))
    done.append(rel)

print(f'已标注 {len(done)} 页，跳过 {len(skipped)} 页（已有注记）')
for d in done:
    print('  +', d)
