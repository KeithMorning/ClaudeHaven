'use strict';

// Clash/Mihomo YAML 导入（2.0：容器内内核 + TUN 是唯一网络路径）。
//
// 宿主侧只做「校验 + 定位配置 + 解析节点 + 算指纹」，不改写 YAML 内容：
// 用户继续用宿主的 Clash Verge / 文本编辑器改自己的订阅，我们每次启动读最新内容
// 注入客机 —— 这就是「外部只是辅助修改」。
// 真正的配置合并（叠加 tun/dns 段、按选中节点生成单节点组、补节点路由）在
// 客机 tun-merge.py 完成。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_NAME = 'clash.yaml';

/** 顶层键（顶格 key:），用于行级识别，不依赖 YAML 解析库。 */
function topKey(line) {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
  return m ? m[1] : null;
}

const unquote = (s) => String(s || '').trim().replace(/^["']|["']$/g, '');

/**
 * 解析 proxies 段里的节点列表，返回 [{ name, type, server }]。
 * 零依赖、行级状态机：Clash 的 proxies 是顶格 `proxies:` + 缩进的 `- name:` 列表。
 * 节点名可能含中文/空格/引号，所以只 strip 成对引号，不做多余清洗。
 */
function extractNodes(text) {
  const nodes = [];
  let inProxies = false;
  let cur = null;
  const flush = () => {
    if (cur && cur.name) nodes.push(cur);
    cur = null;
  };
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const k = topKey(raw);
    if (k) {
      if (inProxies) flush();
      inProxies = (k === 'proxies');
      continue;
    }
    if (!inProxies) continue;
    // 新节点开始（`- name: xxx` 或单独一行 `- type: xxx`）
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item) {
      flush();
      cur = { name: '', type: '', server: '' };
      const nm = /^name\s*:\s*(.+)$/.exec(item[1]);
      if (nm) cur.name = unquote(nm[1]);
      continue;
    }
    if (!cur) continue;
    const kv = /^\s+(name|type|server)\s*:\s*([^\s#][^#]*)$/.exec(raw);
    if (kv) {
      const v = unquote(kv[2]);
      if (kv[1] === 'name') cur.name = v;
      else if (kv[1] === 'type') cur.type = v;
      else if (kv[1] === 'server') cur.server = v;
    }
  }
  flush();
  // 同名节点去重（保序）：mihomo 里重名节点本身就是非法配置
  const seen = new Set();
  return nodes.filter((n) => {
    if (seen.has(n.name)) return false;
    seen.add(n.name);
    return true;
  });
}

/** 提取 proxies 段里所有 server 值（IP 或域名），保序去重。 */
function extractNodeHosts(text) {
  const hosts = [];
  for (const n of extractNodes(text)) {
    if (n.server && !hosts.includes(n.server)) hosts.push(n.server);
  }
  if (hosts.length) return hosts;
  // 兼容没有 name 字段的极简配置：退回原来的 server 行扫描
  let inProxies = false;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const k = topKey(raw);
    if (k) { inProxies = (k === 'proxies'); continue; }
    if (!inProxies) continue;
    const s = /^\s+(?:-\s+)?server\s*:\s*([^\s#]+)/.exec(raw);
    if (s) {
      const h = unquote(s[1]);
      if (h && !hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

/** 最小充分校验：能交给 mihomo 的 YAML 至少要有 proxies 节点列表。 */
function validateClashYaml(text) {
  const s = String(text || '');
  if (!s.trim()) return { ok: false, error: '配置文件为空' };
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  let hasProxies = false;
  let hasGroupsOrRules = false;
  for (const line of lines) {
    const k = topKey(line);
    if (!k) continue;
    if (k === 'proxies') hasProxies = true;
    if (k === 'proxy-groups' || k === 'rules') hasGroupsOrRules = true;
  }
  if (!hasProxies) return { ok: false, error: 'YAML 里没有 proxies 节点列表，无法作为出口配置' };
  const nodes = extractNodes(s);
  if (!nodes.length) return { ok: false, error: 'proxies 里没有解析出任何节点（需要 - name: 字段）' };
  const hosts = extractNodeHosts(s);
  if (!hosts.length) return { ok: false, error: 'proxies 里没有任何 server 字段' };
  const warnings = [];
  if (hasGroupsOrRules) warnings.push('全量单节点模式会忽略订阅原有的分流规则（proxy-groups / rules），所有流量走选中节点');
  if (/^\s*mode\s*:\s*direct\s*$/im.test(s)) warnings.push('原配置为 DIRECT 模式，客机会纠正为 global');
  return { ok: true, nodes, hosts, warnings };
}

/**
 * 读最新配置：优先 cfg.clashYamlPath（用户外部工具在改的那份），
 * 读不到再退回上次缓存。返回 { ok, text, source, validation }。
 */
function readClashYaml(cfg, userDir) {
  const p = String((cfg && cfg.clashYamlPath) || '').trim();
  let text = '';
  let source = '';
  if (p) {
    try {
      text = fs.readFileSync(p, 'utf8');
      source = p;
    } catch {
      text = '';
    }
  }
  if (!text) {
    try {
      text = fs.readFileSync(path.join(userDir, CACHE_NAME), 'utf8');
      source = 'cache';
    } catch {
      return { ok: false, error: p
        ? `读取 Clash 配置失败：${p}（文件不存在或不可读），且没有可用缓存。请重新选择 YAML 文件。`
        : '尚未导入 Clash 配置文件。请先在设置里选择一个 YAML 文件。' };
    }
  }
  const validation = validateClashYaml(text);
  if (!validation.ok) return { ok: false, error: validation.error, source };
  return { ok: true, text, source, validation };
}

/** 把外部配置缓存进 userData，避免原文件被删后启动直接失败。 */
function cacheClashYaml(text, userDir) {
  fs.mkdirSync(userDir, { recursive: true });
  const p = path.join(userDir, CACHE_NAME);
  fs.writeFileSync(p, String(text).replace(/\r\n?/g, '\n'), { mode: 0o600 });
  return p;
}

/**
 * 最终使用的节点名：优先用户在界面里选的，且必须仍存在于当前 YAML；
 * 未选 / 选的已失效时退回第一个节点（UI 会提示）。
 */
function selectedNode(cfg, text) {
  const nodes = extractNodes(text || '');
  if (!nodes.length) return '';
  const want = String((cfg && cfg.selectedNode) || '').trim();
  if (want && nodes.some((n) => n.name === want)) return want;
  return nodes[0].name;
}

/** 配置内容变了必须重建会话，不能「接管」旧 TUN 内核。 */
function tunFingerprint(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

/** base64 分块注入（Windows execFile 命令行上限 32767 字符）。 */
const CHUNK = 8000;
function base64Chunks(text) {
  const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
  const out = [];
  for (let i = 0; i < b64.length; i += CHUNK) out.push(b64.slice(i, i + CHUNK));
  return out;
}

module.exports = {
  CACHE_NAME,
  CHUNK,
  topKey,
  extractNodes,
  extractNodeHosts,
  validateClashYaml,
  readClashYaml,
  cacheClashYaml,
  selectedNode,
  tunFingerprint,
  base64Chunks,
};
