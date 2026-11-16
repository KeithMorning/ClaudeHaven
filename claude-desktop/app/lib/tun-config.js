'use strict';

// Clash/Mihomo YAML 导入（模块一：容器内内核 + TUN）
//
// 宿主侧只做「校验 + 定位配置 + 算指纹」，不解析也不改写 YAML：
// 用户继续用宿主的 Clash Verge / 文本编辑器改自己的订阅与规则，
// 我们每次启动读最新内容注入客机 —— 这就是「外部只是辅助修改」。
// 真正的配置合并（叠加 tun/dns 段、补节点路由）在客机 tun-merge.py 完成。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_NAME = 'clash.yaml';

/** 顶层键（顶格 key:），用于行级识别，不依赖 YAML 解析库。 */
function topKey(line) {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
  return m ? m[1] : null;
}

/** 提取 proxies 段里所有 server 值（IP 或域名），保序去重。 */
function extractNodeHosts(text) {
  const hosts = [];
  let inProxies = false;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const k = topKey(raw);
    if (k) {
      inProxies = (k === 'proxies');
      continue;
    }
    if (!inProxies) continue;
    const s = /^\s+(?:-\s+)?server\s*:\s*([^\s#]+)/.exec(raw);
    if (s) {
      const h = s[1].replace(/^["']|["']$/g, '');
      if (h && !hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

/** 最小充分校验：能交给 mihomo 的 YAML 至少要有 proxies 列表。 */
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
  const hosts = extractNodeHosts(s);
  if (!hosts.length) return { ok: false, error: 'proxies 里没有任何 server 字段' };
  const warnings = [];
  if (!hasGroupsOrRules) warnings.push('没有 proxy-groups / rules，mihomo 会按 mode 决定出口，建议确认分流结果');
  if (/^\s*mode\s*:\s*direct\s*$/im.test(s)) warnings.push('原配置为 DIRECT 模式，客机会自动纠正为 global');
  return { ok: true, hosts, warnings };
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
    } catch (e) {
      // 外部文件被移动/删除时不静默失败：退回缓存，并让调用方提示
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

/** 配置内容变了必须重建会话，不能「接管」旧 TUN 内核。 */
function tunFingerprint(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

module.exports = {
  CACHE_NAME,
  topKey,
  extractNodeHosts,
  validateClashYaml,
  readClashYaml,
  cacheClashYaml,
  tunFingerprint,
};
