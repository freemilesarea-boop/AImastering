// stems-ui-selftest — the stem mixer screen renders.
//
// Everything else in this session is measured audio. This one is about the
// screen, and it exists because the failure it catches is the one that
// cannot be caught by reading: a component that throws on mount shows a
// white window with nothing in the console the user can act on, and the
// whole session's work looks broken.
//
// `renderToStaticMarkup` runs the component tree for real — the selectors,
// the `useMemo`s, the JSX — without needing Electron, jsdom or a worker.
// Effects do not run, so this proves the screen paints, not that playback
// works; playback is covered by `stem-preview-selftest`.
//
// # Why the content is checked on the row rather than on the page
//
// Under `renderToStaticMarkup`, zustand's hook returns the store's state as
// of module load: seeding the store and re-rendering shows the empty screen
// either way (measured — `hook=0 direct=1` on a store that had just been
// given four stems). Asserting against a page driven that way would be
// asserting against a fixture that never changes.
//
// So the page is checked for the thing a page-level render can honestly
// prove — that it mounts without throwing, which is what stops a white
// window — and the per-stem content is checked by rendering the row with
// real props, which is exactly what `phase-e-render-safety` does and for
// the same reason.
//
// Run:  pnpm --filter @aimaster/desktop test:stems-ui

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StemsPage, { StemRow, Transport } from '../src/renderer/pages/StemsPage.js';
import type { StemTrackState } from '../src/renderer/stores/stemStore.js';
import { STEM_ROLES } from '../src/renderer/audio/presets/stem-defaults.js';

// The store reads localStorage when it loads and the page reads `window`.
// The store's own read is guarded, so a hoisted import is harmless; what
// matters is that both exist before anything renders or persists.
function installBrowserGlobals(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  const w = globalThis as { window?: unknown; matchMedia?: unknown };
  if (!w.window) {
    w.window = {
      localStorage: (globalThis as { localStorage: unknown }).localStorage,
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      // No electronAPI: the page must render in a browser-ish environment
      // without one, which is also what a failed preload looks like.
    };
  }
}
installBrowserGlobals();


let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

function html(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

function stem(over: Partial<StemTrackState> = {}): StemTrackState {
  return {
    id: 's1', filePath: '/session/Kick In.wav', name: 'Kick In',
    role: 'kick', roleLocked: false, confidence: 0.95, basis: 'name+spectrum',
    why: '이름과 측정이 일치합니다 — 킥, 중심 52 Hz, 크레스트 16.0 dB',
    gainDb: 0, pan: 0, mute: false, solo: false, status: 'ready',
    ...over,
  };
}

function row(track: StemTrackState, over: { audible?: boolean; custom?: boolean } = {}): string {
  return html(React.createElement(StemRow, {
    track,
    audible: over.audible ?? true,
    custom: over.custom ?? false,
    onEdit: () => {},
    onReset: () => {},
  }));
}

// ── 1. The page mounts ───────────────────────────────────────────────────────

console.log('\n=== THE SCREEN PAINTS ===\n');

{
  let out = '';
  let threw = '';
  try { out = html(React.createElement(StemsPage)); } catch (e) { threw = (e as Error).message; }
  check(
    'the stem mixer mounts without throwing',
    threw === '' && out.length > 0,
    threw || `${out.length}자 — 마운트에서 던지면 사용자는 흰 창만 본다`,
  );
  check(
    'an empty session says what to do',
    out.includes('스템을 불러오세요') && out.includes('스템 추가'),
    '빈 화면에 안내와 버튼이 함께 있다',
  );
  check(
    'the transport and the master bus are there from the start',
    out.includes('미리듣기') && out.includes('마스터 버스'),
    '스템이 없어도 화면 구조는 보인다',
  );
  check(
    'the master bus offers real presets with their targets',
    out.includes('Streaming Pro') && out.includes('KPOP Loud') && out.includes('없음 (합산만)'),
    '앱이 이미 쓰는 마스터링 프리셋 그대로',
  );
}

// ── 2. A channel strip ───────────────────────────────────────────────────────

console.log('\n=== A CHANNEL STRIP ===\n');

{
  const out = row(stem());
  check(
    'the row shows the stem, its instrument and its explanation',
    out.includes('Kick In') && out.includes('value="kick"') && out.includes('중심 52 Hz'),
    '이름 · 악기 · 근거가 한 줄에',
  );
  check(
    'the instrument picker offers every role',
    STEM_ROLES.every((r) => out.includes(`value="${r}"`)),
    `${STEM_ROLES.length}개 악기 선택지`,
  );
  check(
    'the fader and the balance show their values',
    out.includes('>0.0<') && out.includes('>C<'),
    '0 dB, 가운데',
  );
  check(
    'and it offers to open the stem in the Studio',
    out.includes('>편집<'),
    '스템별 편집 진입점',
  );
}

{
  const out = row(stem({ gainDb: -3.5, pan: 0.4 }));
  check(
    'a moved fader and balance read back',
    out.includes('-3.5') && out.includes('R40'),
    '-3.5 dB, 오른쪽 40%',
  );
}

{
  const out = row(stem({ gainDb: 2 }));
  check(
    'a boost is signed',
    out.includes('+2.0'),
    '올린 값은 + 부호가 붙는다',
  );
}

{
  const out = row(stem({
    warning: '이름은 리드 보컬인데 측정은 킥에 가깝습니다.',
    role: 'vocal', confidence: 0.5, basis: 'name',
  }));
  check(
    'a disagreement is shown next to the stem it is about',
    out.includes('이름은 리드 보컬인데 측정은 킥에 가깝습니다') && out.includes('amber'),
    '판단 근거를 못 보면 사용자가 고칠 수도 없다',
  );
}

{
  const out = row(stem({ status: 'error', error: '이 파일을 읽지 못했습니다' }));
  check(
    'a stem that failed to analyse says so',
    out.includes('이 파일을 읽지 못했습니다') && out.includes('red'),
    '에러가 조용히 사라지지 않는다',
  );
}

{
  const out = row(stem(), { custom: true });
  check(
    'a hand-edited stem is marked and offers a reset',
    out.includes('편집됨') && out.includes('초기화') && out.includes('악기를 바꿔도 이 체인은 유지됩니다'),
    '직접 만든 체인이 조용히 사라지지 않는다는 것을 화면이 말해준다',
  );
}

{
  const muted = row(stem({ mute: true }), { audible: false });
  const heard = row(stem());
  check(
    'a stem that will not be heard is dimmed',
    muted.includes('opacity-40') && !heard.includes('opacity-40'),
    '뮤트·솔로로 빠진 줄은 눈에 띄게 다르다',
  );
}

// ── 3. The transport ─────────────────────────────────────────────────────────

console.log('\n=== THE TRANSPORT ===\n');

const idle = { state: 'idle' as const, position: 0, duration: 0, memoryBytes: 0, error: null };

{
  const out = html(React.createElement(Transport, {
    status: idle, preparing: false, stale: false,
    onPrepare: () => {}, onPlay: () => {}, onPause: () => {}, onSeek: () => {},
  }));
  check(
    'an unprepared session offers to prepare',
    out.includes('미리듣기') && out.includes('0:00 / 0:00'),
    '준비 전에는 재생이 아니라 미리듣기',
  );
}

{
  const out = html(React.createElement(Transport, {
    status: { state: 'playing' as const, position: 74.5, duration: 212.4, memoryBytes: 640_000_000, error: null },
    preparing: false, stale: false,
    onPrepare: () => {}, onPlay: () => {}, onPause: () => {}, onSeek: () => {},
  }));
  check(
    'while playing it offers to pause and shows the position',
    out.includes('일시정지') && out.includes('1:14 / 3:32'),
    '74.5초 → 1:14, 212.4초 → 3:32',
  );
  check(
    'and it says what the preview costs in memory',
    out.includes('640 MB'),
    '실시간 멀티트랙의 진짜 제약을 숨기지 않는다',
  );
}

{
  const out = html(React.createElement(Transport, {
    status: { state: 'ready' as const, position: 0, duration: 100, memoryBytes: 1000, error: null },
    preparing: false, stale: true,
    onPrepare: () => {}, onPlay: () => {}, onPause: () => {}, onSeek: () => {},
  }));
  check(
    'a chain change offers a re-bake rather than playing something stale',
    out.includes('다시 굽기'),
    '체인이 바뀐 뒤에도 옛 소리를 들려주면 안 된다',
  );
}

{
  const out = html(React.createElement(Transport, {
    status: idle, preparing: true, stale: false,
    onPrepare: () => {}, onPlay: () => {}, onPause: () => {}, onSeek: () => {},
  }));
  check(
    'preparing disables the button rather than queueing another bake',
    out.includes('준비 중') && out.includes('disabled'),
    '굽는 동안 또 누르지 못하게',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
