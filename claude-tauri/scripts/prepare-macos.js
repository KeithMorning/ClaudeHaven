'use strict';

if (process.platform !== 'darwin') process.exit(0);

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const native = path.join(project, 'native');
const runtime = path.join(project, 'runtime', 'native');
for (const file of ['kernel.tar.xz', 'initrd', 'system.squashfs', 'image-version']) {
  if (!fs.existsSync(path.join(runtime, file))) {
    console.error('Missing the native ARM64 VM image. Build it with claude-vm/macos/build-image.sh.');
    process.exit(1);
  }
}
const executable = path.join(runtime, 'haven-vm');
const moduleCache = path.join(runtime, '.swift-cache');
try {
  execFileSync('xcrun', [
    'swiftc', '-O', '-module-cache-path', moduleCache, '-target', 'arm64-apple-macos13.0',
    path.join(native, 'HavenVM.swift'), path.join(native, 'HostNpm.swift'), '-o', executable,
  ], { stdio: 'inherit' });
} finally {
  fs.rmSync(moduleCache, { recursive: true, force: true });
}

const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
const options = identity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
execFileSync('codesign', [
  '--force', '--sign', identity, ...options,
  '--entitlements', path.join(native, 'virtualization.entitlements'), executable,
], { stdio: 'inherit' });
