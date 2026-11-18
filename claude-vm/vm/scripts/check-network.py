#!/usr/bin/env python3
"""Minimal, non-destructive runtime protection and exit-location check."""
import importlib.util
import ipaddress
import json
import os
import re
import subprocess
import time


def run(args, timeout=4):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None


def running(name):
    result = run(['pgrep', '-x', name])
    return result is not None and result.returncode == 0


def read(path):
    try:
        with open(path, encoding='utf-8') as stream:
            return stream.read()
    except OSError:
        return ''


def item(label, status, value, detail, advice=''):
    return dict(label=label, status=status, value=value, detail=detail, advice=advice)


def main():
    ready = os.path.isfile('/run/claude-vm/ready') and running('Xtigervnc')
    entries = []
    state = dict(line.split('=', 1) for line in read('/run/claude-vm/net-guard.state').splitlines() if '=' in line)
    pid = read('/run/claude-vm/net-guard.pid').strip()
    try:
        age = time.time() - int(state.get('ts', ''))
    except ValueError:
        age = float('inf')
    guard_alive = pid.isdecimal() and b'net-guard.sh' in read_bytes('/proc/' + pid + '/cmdline')
    routes = run(['python3', '/opt/scripts/net-guard.py', 'status'])
    try:
        route_state = json.loads(routes.stdout) if routes and routes.returncode == 0 else {}
    except ValueError:
        route_state = {}
    resolvers = [line.split()[1] for line in read('/etc/resolv.conf').splitlines()
                 if len(line.split()) > 1 and line.split()[0] == 'nameserver']
    tun = any(line.split(':', 1)[0].strip() == 'Meta' for line in read('/proc/net/dev').splitlines() if ':' in line)
    protected = (ready and guard_alive and -5 <= age <= 30 and state.get('state') == 'guarded'
                 and state.get('locked') == '1' and state.get('preflight') == 'pass'
                 and route_state.get('locked') is True and route_state.get('ipv6_disabled') is True
                 and running('mihomo') and tun and resolvers == ['127.0.0.1'])
    if protected:
        entries.append(item('网络保护', 'pass', '运行中', '守卫、路由、IPv6、代理内核和本机 DNS 配置已检查；这不是所有泄漏场景的实测保证。'))
    else:
        entries.append(item('网络保护', 'warn', '无法确认', '守卫、路由、代理内核或 DNS 状态尚未全部满足要求。', '请检查节点和环境状态后重试。'))
    if not protected:
        entries.append(item('出口地区', 'info', '未检查', '网络保护未确认，未发起出口查询。'))
    else:
        result = run(['curl', '-fsS', '--noproxy', '*', '--connect-timeout', '3', '--max-time', '8', 'https://ipinfo.io/json'], timeout=10)
        try:
            data = json.loads(result.stdout) if result and result.returncode == 0 else {}
            ip = ipaddress.ip_address(data.get('ip', ''))
            if not ip.is_global:
                raise ValueError('not a public address')
            address = str(ip)
            country = str(data.get('country', '')).strip().upper()
            if not re.fullmatch('[A-Z]{2}', country) or country in {'XX', 'ZZ'}:
                raise ValueError('country unavailable')
            spec = importlib.util.spec_from_file_location('claude_regions', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'claude-supported-regions.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            verdict = module.classify(country)
            if verdict == 'supported':
                entries.append(item('出口地区', 'pass', f'{country} · {address}', 'IP 信息服务报告的地区在本地官方名单快照中；这不能证明实际所在地或账号资格。'))
            elif verdict == 'unsupported':
                entries.append(item('出口地区', 'fail', f'{country} · {address}', 'IP 信息服务报告的地区不在本地官方名单快照中。', '核对官方支持地区及所选节点。'))
            else:
                raise ValueError('country unknown')
        except (ValueError, TypeError, AttributeError, OSError, ImportError):
            entries.append(item('出口地区', 'warn', '无法确认', '未能取得有效出口 IP、地区或支持地区名单。', '请检查节点和网络后重试。'))
    report = dict(version=1, runtimeUp=int(ready), groups=[dict(id='network', title='网络与安全', items=entries)])
    print(json.dumps(report, ensure_ascii=False))


def read_bytes(path):
    try:
        with open(path, 'rb') as stream:
            return stream.read()
    except OSError:
        return b''


if __name__ == '__main__':
    main()
