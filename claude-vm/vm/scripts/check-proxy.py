#!/usr/bin/env python3
"""Check the public IP observed through the running guest network."""
import concurrent.futures
import ipaddress
import json
import urllib.request


SOURCES = {
    'ipinfo': 'https://ipinfo.io/json',
    'ipify': 'https://api.ipify.org',
    'ip.sb': 'https://api.ip.sb/ip',
}


def fetch(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers={'User-Agent': 'ClaudeVM/1.0'})
    with opener.open(request, timeout=8) as response:
        return response.read(32768).decode('utf-8').strip()


def probe(name, url):
    try:
        body = fetch(url)
        data = json.loads(body) if name == 'ipinfo' else {'ip': body}
        address = str(ipaddress.ip_address(data.get('ip', '').strip()))
        return {'ip': address, 'data': data}
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def build_report(results):
    valid = {name: result for name, result in results.items() if result}
    addresses = sorted({item['ip'] for item in valid.values()})
    items = []
    if not valid:
        items.append({'status': 'fail', 'label': '出口 IP', 'value': '无法获取',
                      'detail': '三个查询来源均未返回有效 IP。',
                      'advice': '检查所选节点的连接状态后重试。'})
    else:
        info = valid.get('ipinfo', {})
        data = info.get('data', {})
        items.append({'status': 'info', 'label': '出口 IP',
                      'value': info.get('ip') or next(iter(valid.values()))['ip']})
        location = ' · '.join(str(data[key]) for key in ('country', 'region', 'city') if data.get(key))
        items.append({'status': 'info', 'label': '出口地区', 'value': location or '未获取',
                      'detail': '地区来自 IP 信息服务，实际位置可能存在偏差。'})
        items.append({'status': 'info', 'label': '网络组织', 'value': data.get('org') or '未获取'})
        if len(addresses) > 1:
            items.append({'status': 'warn', 'label': '多源出口', 'value': '查询到不同 IP',
                          'detail': '；'.join('%s：%s' % (name, result['ip']) for name, result in valid.items())})
        elif len(valid) >= 2:
            items.append({'status': 'pass', 'label': '多源出口',
                          'value': '%d/3 个来源一致' % len(valid),
                          'detail': '一致的地址为 %s。' % addresses[0]})
        else:
            items.append({'status': 'warn', 'label': '多源出口', 'value': '仅 1/3 个来源返回',
                          'detail': '来源不足，无法比较出口是否一致。'})
    summary = {status: sum(item['status'] == status for item in items)
               for status in ('pass', 'warn', 'fail', 'info')}
    return {'version': 1, 'runtimeUp': True, 'summary': summary,
            'groups': [{'title': '代理出口', 'items': items}]}


def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(SOURCES)) as executor:
        futures = {name: executor.submit(probe, name, url) for name, url in SOURCES.items()}
        results = {name: future.result() for name, future in futures.items()}
    print(json.dumps(build_report(results), ensure_ascii=False))


if __name__ == '__main__':
    main()
