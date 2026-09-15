/**
 * ui-consistency-selftest — the small things the audit found last.
 *
 * None of these is dramatic on its own.  Together they are the difference
 * between an app that behaves like one thing and one that behaves like six
 * people's work:
 *
 *   • two close glyphs.  × in 42 places, ✕ in 8, no rule.
 *   • close buttons with no name — nothing for a tooltip, nothing for a
 *     screen reader, and the only thing in the box is a symbol.
 *   • one `window.alert`, the last native modal in an app that says
 *     everything else through the toast — and the branch that chose it had
 *     two arms doing exactly the same thing.
 *   • an unbounded loudness field.  `Number('')` is 0, so clearing it asked
 *     for 0 LUFS and pinned every track at the +6 dB the model allows.
 *   • FFmpeg's absence, computed by the main process since the beginning,
 *     logged, recorded as a failure, and never once shown to anyone.
 *   • a queue that fills at 20 and greys out two controls without saying why.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:ui-consistency
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ffmpegWarning, readFfmpegWarning } from '../src/renderer/lib/ffmpeg-notice.js';
import { clampTargetLufs, TARGET_LUFS_MIN, TARGET_LUFS_MAX } from '../src/renderer/daw/album/album-levels.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
const pending: Promise<void>[] = [];
function checkAsync(name: string, fn: () => Promise<void>): void {
  pending.push(fn().then(
    () => { results.push({ name, pass: true, detail: '' }); },
    (e: unknown) => { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); },
  ));
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; }).join('\n');
}

const RENDERER = execSync(
  "find src/renderer \\( -name '*.tsx' -o -name '*.ts' \\) ! -name '*.stories.tsx' ! -path '*/public/*'",
  { encoding: 'utf8' },
).trim().split('\n');

// ── 1. One close glyph, and every one of them named ─────────────────────────

check('there is one close glyph, not two', () => {
  // ✕ survives in three places and all three are STATUS, not an action: a
  // warp problem's severity, a bullet in the AI panel's refusal list, and a
  // step channel's muted state.  A close button is ×.
  const users: string[] = [];
  for (const file of RENDERER) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (!code.includes('✕')) continue;
    users.push(file.replace('src/renderer/', ''));
  }
  const allowed = new Set([
    'components/daw/warp/WarpEditor.tsx',
    'components/daw/intel/IntelPanel.tsx',
    'components/daw/steps/StepSequencer.tsx',
    'components/product/modules/LouiFreeEqBandList.tsx',
  ]);
  const unexpected = users.filter((f) => !allowed.has(f));
  assert(unexpected.length === 0,
    `✕ is back as an action glyph in: ${unexpected.join(', ')} — close buttons use ×`);
});

check('every close button says that it closes', () => {
  // A button whose whole content is a symbol has no name at all without one.
  const closers = [
    'components/daw/DawMediaBay.tsx',
    'components/daw/DawShortcutHelp.tsx',
    'components/daw/plugin/ExternalPluginManager.tsx',
    'components/daw/chain/RackPanel.tsx',
    'components/daw/smart/SmartControlPanel.tsx',
  ];
  for (const rel of closers) {
    const src = readFileSync(`src/renderer/${rel}`, 'utf8');
    const at = src.indexOf('×</button>');
    assert(at > 0, `${rel} no longer has a × close button`);
    const button = src.slice(src.lastIndexOf('<button', at), at);
    assert(/title=|aria-label=/.test(button), `${rel}'s close button has no name`);
  }
});

// ── 2. The app speaks in its own voice ──────────────────────────────────────

check('nothing stops the window with a native dialog', () => {
  for (const file of RENDERER) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert(!/\bwindow\.(alert|confirm|prompt)\s*\(/.test(code),
      `${file.replace('src/renderer/', '')} uses a native dialog — the app notifies through the toast`);
  }
});

check('saving an assistant key reports what happened, and which kind', () => {
  // The defect was not only the alert: the two arms of the branch called the
  // same function with the same argument, throwing away `ok` — which is the
  // difference between "could not save" and "saved, but unencrypted".
  const src = readFileSync('src/renderer/components/daw/intel/IntelPanel.tsx', 'utf8');
  const at = src.indexOf('const saveKey = async');
  assert(at > 0, 'saveKey is gone');
  const body = stripComments(src.slice(at, src.indexOf('\n  };', at)));
  assert(/notify\(/.test(body), 'saveKey no longer notifies');
  assert(/result\.ok \? 'warning' : 'error'/.test(body),
    'saveKey throws `ok` away again — a warning and a failure would read the same');
});

// ── 3. A number field that refuses nonsense ─────────────────────────────────

check('the album target holds a loudness a record could have', () => {
  eq(clampTargetLufs(-14, -14), -14, 'an ordinary target');
  eq(clampTargetLufs(-9, -14), -9, 'a loud one');
  eq(clampTargetLufs(0, -14), TARGET_LUFS_MAX, 'an empty field reads 0 — clamp it');
  eq(clampTargetLufs(-999, -14), TARGET_LUFS_MIN, 'absurdly quiet');
  eq(clampTargetLufs(NaN, -11), -11, 'not a number keeps what was there');
  assert(TARGET_LUFS_MIN < TARGET_LUFS_MAX, 'the range is inside out');
});

check('the field itself refuses before the clamp has to', () => {
  const src = readFileSync('src/renderer/components/AlbumPanel.tsx', 'utf8');
  const at = src.indexOf('value={targetLufs}');
  assert(at > 0, 'the target field is gone');
  const input = src.slice(src.lastIndexOf('<input', at), src.indexOf('/>', at));
  assert(/min=\{TARGET_LUFS_MIN\}/.test(input) && /max=\{TARGET_LUFS_MAX\}/.test(input),
    'the target field lost its bounds');
  assert(/clampTargetLufs\(/.test(input), 'the target field accepts whatever is typed again');
});

// ── 4. FFmpeg says so before it is needed ───────────────────────────────────

check('a missing encoder is a warning, not a surprise at export time', () => {
  assert(ffmpegWarning({ available: true, ffprobeAvailable: true }) === null,
    'a working install warns about nothing');
  const missing = ffmpegWarning({ available: false });
  assert(missing !== null && missing.includes('FFmpeg'), 'a missing FFmpeg says so');
  // Specifically the reassurance, not just the letters W-A-V: the sentence
  // already says "WAV 외 파일 불러오기", so `includes('WAV')` passed against a
  // message with the reassurance deleted.
  assert(missing !== null && /WAV는 그대로/.test(missing),
    'and says what still works — WAV export is a plain copy and never touches ffmpeg');
  const noProbe = ffmpegWarning({ available: true, ffprobeAvailable: false });
  assert(noProbe !== null && noProbe.includes('ffprobe'), 'a missing ffprobe is its own case');
  assert(ffmpegWarning(null) === null, 'not being able to ask is not a warning');
});

checkAsync('a channel that throws does not invent a warning', async () => {
  const warn = await readFfmpegWarning(async () => { throw new Error('unknown channel'); });
  assert(warn === null, 'an older main process produced an FFmpeg warning out of nothing');
});

check('something actually asks at startup', () => {
  const main = readFileSync('src/renderer/main.tsx', 'utf8');
  assert(/readFfmpegWarning\s*\(/.test(main), 'nothing asks for the ffmpeg status — it is write-only again');
  assert(/notify\(warning/.test(main), 'the answer is read and then dropped');
});

// ── 5. A control that goes dead says why ────────────────────────────────────

check('the full queue explains itself', () => {
  const src = readFileSync('src/renderer/pages/HomePage.tsx', 'utf8');
  // Anchor on the DISABLING CONDITION, not on the handler: `handleOpenMulti`
  // is wired to two buttons and the first one found was the always-enabled
  // 파일 탐색기로 열기 link, which needs no explanation because it never goes
  // dead.  A check that reads the wrong element is a check that passes for
  // the wrong reason — or, as here, fails for one.
  const at = src.indexOf('disabled={isBatchRunning || queue.length >= MAX_QUEUE_SIZE}');
  assert(at > 0, 'the queue-limit disable is gone');
  const button = src.slice(src.lastIndexOf('<button', at), src.indexOf('</button>', at));
  assert(/title=/.test(button), 'the 열기 button goes dead at the limit with no reason given');
  assert(/MAX_QUEUE_SIZE/.test(button), 'its tooltip does not name the limit');
  assert(/큐가 찼습니다/.test(src), 'nothing on screen says the queue is full without hovering');
});

// ── 6. The channels that had no caller ──────────────────────────────────────

check('the two dead channels are gone from both sides', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  const handlers = readFileSync('src/main/ipc/fileHandlers.ts', 'utf8');
  for (const dead of ['file:save-dialog', 'file:get-recent']) {
    assert(!stripComments(preload).includes(`'${dead}'`), `${dead} is exposed again`);
    assert(!handlers.includes(`ipc.handle('${dead}'`), `${dead} has a handler again`);
  }
});

check('the dormant licence channels say that they are dormant', () => {
  // Kept, not deleted — the same call license-free-selftest already holds for
  // the service behind them.  What was missing was anyone saying so in the
  // list that is supposed to document this surface.
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  const at = preload.indexOf('// License IPC channels');
  assert(at > 0, 'the licence block lost its heading');
  const block = preload.slice(at, preload.indexOf("'license:revalidate'", at));
  assert(/DORMANT/.test(block), 'nothing says these five have no caller');
  assert(/LICENSE_ENFORCED/.test(block), 'the comment does not name the switch that decides it');
  for (const live of ['license:status', 'license:activate']) {
    assert(preload.includes(`'${live}'`), `${live} was removed — it has a caller`);
  }
});

check('every channel the preload exposes still has a handler', () => {
  // Removing two is how a third gets removed by accident.
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  const i = preload.indexOf('const INVOKE_CHANNELS = [');
  const list = preload.slice(i, preload.indexOf('];', i));
  const channels = [...stripComments(list).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  assert(channels.length > 60, `only ${channels.length} channels parsed — the list moved`);
  const mainSrc = execSync("find src/main -name '*.ts'", { encoding: 'utf8' })
    .trim().split('\n').map((f) => readFileSync(f, 'utf8')).join('\n');
  const orphans = channels.filter((c) => !mainSrc.includes(`'${c}'`));
  assert(orphans.length === 0, `exposed with no handler: ${orphans.join(', ')}`);
});

check('the new module is reachable at all', () => {
  assert(existsSync('src/renderer/lib/ffmpeg-notice.ts'), 'ffmpeg-notice.ts is gone');
});

void (async () => {
  await Promise.all(pending);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== UI consistency: the small things ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
})();
