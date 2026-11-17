#!/usr/bin/env node
/**
 * 消除 Chrome「恢复页面 / Chrome didn't shut down correctly」气泡。
 * 每次强制停止环境都会留下 exited_cleanly=false，下次启动必弹。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(os.homedir(), '.config', 'google-chrome');

function patch(file) {
  try {
    const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    j.profile = j.profile || {};
    j.profile.exit_type = 'Normal';
    j.profile.exited_cleanly = true;
    j.homepage = 'https://ip.net.coffee/claude/';
    j.homepage_is_newtabpage = false;
    j.browser = j.browser || {};
    j.browser.show_home_button = true;
    j.bookmark_bar = j.bookmark_bar || {};
    j.bookmark_bar.show_on_all_tabs = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    return true;
  } catch {
    return false;
  }
}

function ensureClaudeBookmark(profile) {
  const file = path.join(profile, 'Bookmarks');
  try {
    const bookmarks = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      version: 1,
      roots: {
        bookmark_bar: { children: [], id: '1', name: 'Bookmarks bar', type: 'folder' },
        other: { children: [], id: '2', name: 'Other bookmarks', type: 'folder' },
        synced: { children: [], id: '3', name: 'Mobile bookmarks', type: 'folder' },
      },
    };
    const bar = bookmarks.roots && bookmarks.roots.bookmark_bar;
    if (!bar || !Array.isArray(bar.children)) return;
    const containsClaude = (node) => {
      if (node.type === 'url' && /^https:\/\/claude\.ai\/?$/i.test(node.url || '')) return true;
      return Array.isArray(node.children) && node.children.some(containsClaude);
    };
    if (Object.values(bookmarks.roots).some(containsClaude)) return;
    let maxId = 3n;
    const scanIds = (node) => {
      if (/^\d+$/.test(String(node.id || ''))) {
        const id = BigInt(node.id);
        if (id > maxId) maxId = id;
      }
      if (Array.isArray(node.children)) node.children.forEach(scanIds);
    };
    Object.values(bookmarks.roots).forEach(scanIds);
    bar.children.push({
      date_added: String((BigInt(Date.now()) + 11644473600000n) * 1000n),
      guid: crypto.randomUUID(),
      id: String(maxId + 1n),
      name: 'Claude',
      type: 'url',
      url: 'https://claude.ai/',
    });
    fs.mkdirSync(profile, { recursive: true });
    const tmp = `${file}.claude-vm.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bookmarks, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error(`[chrome-prefs] 无法添加 Claude 收藏：${error.message}`);
  }
}

let n = 0;
let hasDefault = false;
if (fs.existsSync(BASE)) {
  for (const d of fs.readdirSync(BASE)) {
    if (d === 'Default') hasDefault = true;
    const prefs = path.join(BASE, d, 'Preferences');
    if (fs.existsSync(prefs) && patch(prefs)) n++;
  }
}
if ((!hasDefault || !fs.existsSync(path.join(BASE, 'Default', 'Preferences'))) &&
    patch(path.join(BASE, 'Default', 'Preferences'))) n++;
ensureClaudeBookmark(path.join(BASE, 'Default'));
if (process.env.VERBOSE) console.log(`[chrome-prefs] 已复位 ${n} 个 profile`);
