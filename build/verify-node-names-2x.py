#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读验证：修复后的 tun-merge.node_names 能解析真实订阅（坑 24）。"""
import importlib.util
import json
import sys

SRC = '/mnt/e/Web/FuckCladue/claude-vm/vm/scripts/tun-merge.py'
CFG = '/opt/config/clash.yaml'
NODE = 'LAX-Cogent-Reality'

spec = importlib.util.spec_from_file_location('tun_merge', SRC)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

lines = open(CFG, encoding='utf-8').read().replace('\r\n', '\n').split('\n')
names = m.node_names(lines)
hosts = m.node_hosts(lines)
print('node_names =', json.dumps(names, ensure_ascii=False))
print('node_hosts =', json.dumps(hosts, ensure_ascii=False))
print('选中节点在列表中 =', NODE in names)
print('strip_keys 后是否保留 proxies 段 =',
      any(l.strip().startswith('- type: vless') for l in m.strip_keys(lines, m.STRIP_KEYS)))
if NODE not in names:
    sys.exit(1)
