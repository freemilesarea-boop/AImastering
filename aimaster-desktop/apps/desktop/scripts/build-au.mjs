// Build the Audio Unit addon — for the runtime that will actually load it.
//
// `node-gyp rebuild` on its own builds against the headers of whatever Node is
// running it.  The app's main process is not that Node: Electron 28 is
// NODE_MODULE_VERSION 119 and Node 22 is 127, so an addon built the plain way
// loads fine in `node` and fails in the app with a module-version mismatch —
// which arrives looking exactly like "the addon is missing".  So the default
// here builds against ELECTRON's headers, and `--for-node` is the opt-in for
// the one thing that runs outside Electron: the macOS smoke test.
//
//   node scripts/build-au.mjs              → for the app
//   node scripts/build-au.mjs --for-node   → for `node native/.../au-host-mac-smoke.mjs`

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auHost = path.join(desktop, 'native', 'au-host');
const forNode = process.argv.includes('--for-node');

if (process.platform !== 'darwin') {
  console.log('AudioToolbox 는 macOS 전용입니다 — 여기서는 빌드할 것이 없습니다.');
  console.log('로직 검증은 pnpm test:au-native 가 가짜 CoreAudio 로 합니다.');
  process.exit(0);
}

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: auHost, stdio: 'inherit', shell: false });

run('npm', ['install', '--no-audit', '--no-fund']);

const args = ['node-gyp', 'rebuild'];
if (!forNode) {
  const electron = require_('electron/package.json').version;
  console.log(`Electron ${electron} 의 헤더로 빌드합니다.`);
  args.push(
    `--target=${electron}`,
    '--runtime=electron',
    '--dist-url=https://electronjs.org/headers',
    `--arch=${process.arch}`,
  );
} else {
  console.log(`Node ${process.version} 의 헤더로 빌드합니다 (스모크 테스트용).`);
}
run('npx', args);

const out = path.join(auHost, 'build', 'Release', 'au_host.node');
if (!fs.existsSync(out)) {
  console.error(`빌드는 끝났는데 ${out} 이 없습니다.`);
  process.exit(1);
}
console.log(`\n${out}  (${fs.statSync(out).size} bytes)`);
console.log(forNode
  ? '이건 node 용입니다 — 앱에 넣으려면 인자 없이 다시 빌드하세요.'
  : 'electron-builder 가 extraResources 로 Resources/au-host/ 에 넣습니다.');
