'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
const root = path.resolve(__dirname, '../../claude-vm/vm/scripts');
const script = String.raw`
import importlib.util, json, pathlib, sys, types
root = pathlib.Path(sys.argv[1])
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, root / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
regions = load('regions', 'claude-supported-regions.py')
assert regions.classify('US') == 'supported'
assert regions.classify('tw') == 'supported'
assert regions.classify('CN') == 'unsupported'
assert regions.classify('HK') == 'unsupported'
assert regions.classify('RU') == 'unsupported'
assert regions.classify('CF') == 'supported'
assert regions.classify('PR') == 'supported'
assert regions.classify('UA') == 'unknown'
assert regions.classify('') == 'unknown'
assert regions.classify('ZZ') == 'unknown'
net = load('network_check', 'check-network.py')
net.os.path.isfile = lambda _: True
net.time.time = lambda: 1000
net.running = lambda _: True
net.read_bytes = lambda _: b'bash /opt/scripts/net-guard.sh'
def fake_read(path):
    if path.endswith('net-guard.pid'): return '42'
    if path.endswith('net-guard.state'): return 'state=guarded\nlocked=1\npreflight=pass\nts=995\n'
    if path.endswith('resolv.conf'): return 'nameserver 127.0.0.1\n'
    if path.endswith('/net/dev'): return ' Meta: 0 0\n'
    return ''
net.read = fake_read
calls = []
state = {'locked': True, 'ipv6_disabled': True}
country = ['US']
def fake_run(args, timeout=4):
    calls.append(args)
    if args[0] == 'curl':
        return types.SimpleNamespace(returncode=0, stdout=json.dumps({'ip': '8.8.8.8', 'country': country[0]}))
    return types.SimpleNamespace(returncode=0, stdout=json.dumps(state))
net.run = fake_run
net.main()
country[0] = 'CN'
net.main()
country[0] = ''
net.main()
state['locked'] = False
net.main()
assert sum(args[0] == 'curl' for args in calls) == 3
`;

test('地区名单与网络保护：保护未确认时不发起出口请求', { skip: !hasPython && '需要 Python 3' }, () => {
  const result = spawnSync(python, ['-c', script, root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const [healthy, unsupported, unknown, unsafe] = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(healthy.groups[0].items.map((i) => i.status), ['pass', 'pass']);
  assert.deepEqual(unsupported.groups[0].items.map((i) => i.status), ['pass', 'fail']);
  assert.deepEqual(unknown.groups[0].items.map((i) => i.status), ['pass', 'warn']);
  assert.deepEqual(unsafe.groups[0].items.map((i) => i.status), ['warn', 'info']);
});
