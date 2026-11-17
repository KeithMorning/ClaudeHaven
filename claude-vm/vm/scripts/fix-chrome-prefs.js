#!/usr/bin/env node
/**
 * 消除 Chrome「恢复页面 / Chrome didn't shut down correctly」气泡。
 * 每次强制停止环境都会留下 exited_cleanly=false，下次启动必弹。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    return true;
  } catch {
    return false;
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
if (process.env.VERBOSE) console.log(`[chrome-prefs] 已复位 ${n} 个 profile`);
