#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""经 mihomo 本地控制 API 实测每个代理节点的往返延迟。

设计前提：
  · 只访问 127.0.0.1:9090（客机本地回环），宿主不直接连这个端口，也不依赖
    WSL 的 localhost 转发 —— 由宿主通过 runWsl 执行本脚本，拿 stdout 的 JSON。
  · 内核没起或 API 不通时返回 ok=false，界面显示「未测」，绝不编造延迟数字。
  · --file 时把结果原子写到 /run/claude-vm/node-delay.json，检查报告直接读，
    不用再发起一轮测速（那会让每次自检都多等十几秒）。

用法：
  node-delay.py [--file]          实测全部节点，输出 JSON
  node-delay.py --summary        只读已保存的结果，输出一行人类可读摘要
"""

import importlib.util
import json
import os
import sys
import urllib.parse
import urllib.request

API = 'http://127.0.0.1:9090'
CLASH_CFG = '/opt/config/clash.yaml'
# 与自身同目录：客机里是 /opt/scripts/tun-merge.py，单元测试里是源码目录的那份
MERGE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tun-merge.py')
TEST_URL = 'http://www.gstatic.com/generate_204'
TIMEOUT_MS = 3000
STATE = '/run/claude-vm/node-delay.json'


def api_get(path, timeout=8):
    with urllib.request.urlopen(API + path, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def node_names_from_yaml():
    """真实节点名来自注入客机的 clash.yaml，与宿主 extractNodes 同构。

    不能用 `/proxies` 的 type 黑名单：mihomo 会把 COMPATIBLE / PASS-RULE /
    REJECT-DROP 等内置策略也列进 /proxies，黑名单永远追不上版本 —— v1.19.34
    实测就漏了 PassRule，报告里会多出「PASS-RULE 超时」这种脏数据。
    复用 tun-merge.py 的 node_names（坑 24 已与宿主对齐）保证三方同构。
    """
    spec = importlib.util.spec_from_file_location('tun_merge', MERGE_SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    with open(CLASH_CFG, 'r', encoding='utf-8') as f:
        lines = f.read().replace('\r\n', '\n').replace('\r', '\n').split('\n')
    return m.node_names(lines)


def measure(name):
    q = urllib.parse.urlencode({'url': TEST_URL, 'timeout': TIMEOUT_MS})
    path = '/proxies/%s/delay?%s' % (urllib.parse.quote(name, safe=''), q)
    try:
        d = api_get(path, timeout=TIMEOUT_MS / 1000 + 4)
        ms = d.get('delay')
        return int(ms) if isinstance(ms, int) and ms > 0 else None
    except Exception:
        return None


def read_state():
    try:
        with open(STATE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def summary(data):
    delays = (data or {}).get('delays') or {}
    if not delays:
        return ''
    parts = []
    for name, ms in delays.items():
        parts.append('%s %s' % (name, ('%dms' % ms) if isinstance(ms, int) else '超时'))
    return ' | '.join(parts)


def main():
    if '--summary' in sys.argv:
        s = summary(read_state())
        print(s)
        return 0 if s else 1

    try:
        names = node_names_from_yaml()
        api_get('/version', timeout=3)   # 内核不在线就别逐个节点空等超时
    except Exception as e:
        out = {'ok': False, 'delays': {},
               'error': '内核控制 API 或节点配置不可用（%s）：先启动环境再测延迟'
                        % type(e).__name__}
        print(json.dumps(out, ensure_ascii=False))
        return 1

    delays = {n: measure(n) for n in names}
    out = {'ok': True, 'delays': delays, 'testUrl': TEST_URL,
           'timeout': TIMEOUT_MS}
    s = json.dumps(out, ensure_ascii=False)
    print(s)
    if '--file' in sys.argv:
        try:
            os.makedirs(os.path.dirname(STATE), exist_ok=True)
            tmp = STATE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(s)
            os.replace(tmp, STATE)
        except OSError:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
