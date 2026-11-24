#!/usr/bin/env node
/**
 * 设置 Chrome 主页和默认外观，并消除意外退出后的恢复提示。
 * 每次强制停止环境都会留下 exited_cleanly=false，下次启动必弹。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(os.homedir(), '.config', 'google-chrome');
const DEFAULT_BOOKMARKS = [
  { name: 'Claude', url: 'https://claude.ai/' },
  { name: 'Net.Coffee IP 检测', url: 'https://ip.net.coffee/claude/' },
];
const appearanceOnly = process.argv.includes('--appearance-only');
const SYSTEM_COLOR_SCHEME = 0;
const DARK_COLOR_SCHEME = 2;

function patch(file) {
  try {
    const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (!appearanceOnly) {
      j.profile = j.profile || {};
      j.profile.exit_type = 'Normal';
      j.profile.exited_cleanly = true;
    }
    j.homepage = 'https://fuck-claude.vercel.app/';
    j.homepage_is_newtabpage = false;
    j.browser = j.browser || {};
    j.browser.show_home_button = true;
    j.browser.theme = j.browser.theme || {};
    const scheme = j.browser.theme.color_scheme2 ?? SYSTEM_COLOR_SCHEME;
    if (scheme === SYSTEM_COLOR_SCHEME) {
      j.browser.theme.color_scheme2 = DARK_COLOR_SCHEME;
    }
    j.bookmark_bar = j.bookmark_bar || {};
    j.bookmark_bar.show_on_all_tabs = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    return true;
  } catch {
    return false;
  }
}

function ensureDefaultBookmarks(profile) {
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
    const normalizeUrl = (url) => url.replace(/\/$/, '').toLowerCase();
    const existingUrls = new Set();
    let maxId = 3n;
    const scan = (node) => {
      if (node.type === 'url' && typeof node.url === 'string') {
        existingUrls.add(normalizeUrl(node.url));
      }
      if (/^\d+$/.test(String(node.id || ''))) {
        const id = BigInt(node.id);
        if (id > maxId) maxId = id;
      }
      if (Array.isArray(node.children)) node.children.forEach(scan);
    };
    Object.values(bookmarks.roots).forEach(scan);
    const missing = DEFAULT_BOOKMARKS.filter(({ url }) => !existingUrls.has(normalizeUrl(url)));
    if (!missing.length) return;
    for (const bookmark of missing) {
      maxId += 1n;
      bar.children.push({
        ...bookmark,
        date_added: String((BigInt(Date.now()) + 11644473600000n) * 1000n),
        guid: crypto.randomUUID(),
        id: String(maxId),
        type: 'url',
      });
    }
    fs.mkdirSync(profile, { recursive: true });
    const tmp = `${file}.claude-vm.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bookmarks, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error(`[chrome-prefs] 无法添加默认收藏：${error.message}`);
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
if (!appearanceOnly) ensureDefaultBookmarks(path.join(BASE, 'Default'));
if (process.env.VERBOSE) console.log(`[chrome-prefs] 已复位 ${n} 个 profile`);
