'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const project = path.resolve(__dirname, '..');

const [mode, ...args] = process.argv.slice(2);
if (mode !== 'build' && mode !== 'dev') {
  console.error('用法：node scripts/run-tauri.js build|dev');
  process.exit(1);
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: project, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return result.status === 0;
}

try {
  const env = process.platform === 'darwin'
    ? require('./macos/prepare').prepare(project)
    : process.env;
  if (run(process.execPath, [path.join(__dirname, 'sync-runtime.js')], env)) {
    const cli = require.resolve('@tauri-apps/cli/tauri.js');
    run(process.execPath, [cli, mode, ...args], env);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
