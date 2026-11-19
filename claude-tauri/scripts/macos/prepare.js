'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function prepare(project) {
  const env = { ...process.env };
  const addToPath = (...entries) => {
    const paths = (env.PATH || '').split(path.delimiter).filter(Boolean);
    env.PATH = [...new Set([...entries, ...paths])].join(path.delimiter);
  };
  const capture = (command, args) => {
    const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const run = (command, args) => {
    const { status, error } = spawnSync(command, args, { cwd: project, env, stdio: 'inherit' });
    if (status !== 0) throw new Error(`[macOS] ${command} 失败：${error?.message || `退出码 ${status ?? '未知'}`}`);
  };

  const translated = capture('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']);
  if (translated === '1' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('[macOS] 请在原生终端使用与芯片架构匹配的 Node.js，再运行 npm run build。');
  }
  if (capture('/usr/bin/xcode-select', ['-p']) === null || capture('/usr/bin/xcrun', ['--find', 'clang']) === null) {
    throw new Error('[macOS] 缺少 Xcode Command Line Tools。请运行 xcode-select --install，或在已安装 Xcode 时选择有效的开发工具，然后重试。');
  }

  const brewBin = process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin';
  const homebrew = path.join(brewBin, 'brew');
  addToPath(path.join(os.homedir(), '.cargo', 'bin'), brewBin);
  const brew = fs.existsSync(homebrew) ? homebrew : 'brew';
  const hasBrew = () => capture(brew, ['--version']) !== null;
  if (capture('cargo', ['--version']) === null || capture('rustc', ['-vV']) === null) {
    if (!hasBrew()) {
      throw new Error('[macOS] 缺少 Rust 工具链。请安装 Rust 或 Homebrew 后重试。');
    }
    console.log('[macOS] 正在通过 Homebrew 安装 Rust。');
    run(brew, ['install', 'rust']);
    const prefix = capture(brew, ['--prefix', 'rust']);
    if (prefix) addToPath(path.join(prefix, 'bin'));
  }
  const rustTarget = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const rustInfo = capture('rustc', ['-vV']);
  if (!rustInfo?.split(/\r?\n/).includes(`host: ${rustTarget}`) || capture('cargo', ['--version']) === null) {
    throw new Error(`[macOS] 请使用 ${rustTarget} 的原生 Rust 工具链。`);
  }

  if (capture('limactl', ['--version']) === null) {
    if (hasBrew()) {
      console.log('[macOS] 正在通过 Homebrew 安装 Lima。');
      try {
        run(brew, ['install', 'lima']);
        const prefix = capture(brew, ['--prefix']);
        if (prefix) addToPath(path.join(prefix, 'bin'));
      } catch (error) {
        console.warn(`${error.message}。仍可编译和查看界面，进入虚拟桌面前需要 Lima。`);
      }
    } else {
      console.warn('[macOS] 未找到 Lima 或 Homebrew。可以编译和查看界面，虚拟桌面需要先安装 Lima。');
    }
  }

  const cliPackages = ['@tauri-apps/cli/tauri.js', `@tauri-apps/cli-darwin-${process.arch}`];
  if (cliPackages.some(name => !resolves(name, project))) {
    const args = ['ci', '--include=dev', '--include=optional'];
    if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...args]);
    else run('npm', args);
  }

  prepareRootfs(project);
  return env;
}

function resolves(name, project) {
  try {
    require.resolve(name, { paths: [project] });
    return true;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return false;
  }
}

function prepareRootfs(project) {
  const filename = process.arch === 'arm64' ? 'rootfs-linux-arm64.tar.gz' : 'rootfs.tar.gz';
  const runtime = path.join(project, 'runtime');
  const target = path.join(runtime, filename);
  const isArchive = file => {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat?.isFile() && stat.size > 0;
  };
  if (isArchive(target)) return;

  const configured = process.env.CLAUDE_HAVEN_ROOTFS;
  const source = configured ? path.resolve(project, configured) : path.resolve(project, '..', 'dist', filename);
  if (!isArchive(source)) {
    if (configured) throw new Error(`[macOS] CLAUDE_HAVEN_ROOTFS 指向的镜像不存在或为空：${source}`);
    console.warn(`[macOS] 未找到 ${filename}。界面可以启动，进入 Linux 桌面前请将镜像放入 runtime/ 或 dist/。`);
    return;
  }

  fs.mkdirSync(runtime, { recursive: true });
  const staging = fs.mkdtempSync(path.join(runtime, '.rootfs-'));
  const temporary = path.join(staging, filename);
  try {
    console.log(`[macOS] 正在准备 ${filename}。`);
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { prepare };
