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
import DawPage from '../src/renderer/pages/DawPage.js';
import TrackHeader from '../src/renderer/components/daw/TrackHeader.js';
import MixerStrip, { faderPosition, faderDb } from '../src/renderer/components/daw/MixerStrip.js';
import TrackWaveform from '../src/renderer/components/daw/TrackWaveform.js';
import { trackPalette, trackColor, roleLabel } from '../src/renderer/components/daw/TrackColors.js';
import InsertRack, {
  addableModules, inEngineOrder, startingValues, TRACK_FORBIDDEN, ENGINE_ORDER,
  type InsertState,
} from '../src/renderer/components/daw/InsertRack.js';
import { loadPaneSizes, PANE_LIMITS } from '../src/renderer/components/daw/usePaneSizes.js';
import { MODULE_IDS } from '../src/renderer/audio/parameters/parameter-state.js';
import type { StemTrackState } from '../src/renderer/stores/stemStore.js';
import { STEM_ROLES } from '../src/renderer/audio/presets/stem-defaults.js';
import { ALL_MODULE_PARAMETER_DEFS as ALL_PARAM_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';

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

// ── 4. The DAW shell ─────────────────────────────────────────────────────────

console.log('\n=== THE DAW SHELL ===\n');

{
  let out = '';
  let threw = '';
  try { out = html(React.createElement(DawPage)); } catch (e) { threw = (e as Error).message; }
  check(
    'the DAW workspace mounts without throwing',
    threw === '' && out.length > 0,
    threw || `${out.length}자`,
  );
  check(
    'every region of the window is there',
    ['Inspector', 'Tracks', 'Master Bus', 'MixConsole', 'MASTER'].every((r) => out.includes(r)),
    '인스펙터 · 트랙 · 마스터 버스 · 믹스콘솔 · 마스터 채널',
  );
  check(
    'the transport carries a clock',
    out.includes('0:00.0') && out.includes('TRACKS') === false,
    '세션이 없으면 NO SESSION, 시계는 항상',
  );
  check(
    'an empty session explains itself rather than showing an empty grid',
    out.includes('트랙을 불러오세요') && out.includes('타임라인 편집은 없습니다'),
    '없는 기능을 있는 척하지 않는다',
  );
}

{
  const header = html(React.createElement(TrackHeader, {
    name: 'Lead Vox', role: roleLabel('vocal'), color: trackColor('vocal'),
    gainDb: -2.5, mute: false, solo: true, audible: true, selected: true,
    height: 68, status: 'ready', warning: undefined,
    onSelect: () => {}, onGain: () => {}, onMute: () => {}, onSolo: () => {}, onRemove: () => {},
  }));
  check(
    'a track header shows name, instrument, trim and its transport buttons',
    header.includes('Lead Vox') && header.includes('리드 보컬') &&
    header.includes('-2.5') && header.includes('>M<') && header.includes('>S<'),
    '헤더 한 줄에서 트랙을 알아보고 손댈 수 있다',
  );
  check(
    'and a soloed track looks soloed',
    header.includes('amber'),
    '솔로가 눌린 것이 눈에 보인다',
  );
}

{
  const strip = html(React.createElement(MixerStrip, {
    name: 'Bass DI', role: roleLabel('bass'), color: trackColor('bass'),
    gainDb: 0, pan: -0.5, mute: false, solo: false, audible: true, selected: false,
    inserts: ['EQ', 'Compressor', 'Low Focus'], level: 0.6,
    onSelect: () => {}, onGain: () => {}, onPan: () => {}, onMute: () => {},
    onSolo: () => {}, onOpenInserts: () => {},
  }));
  check(
    'a console strip carries the whole channel',
    strip.includes('Bass DI') && strip.includes('베이스') && strip.includes('Inserts') &&
    strip.includes('Compressor') && strip.includes('L50') && strip.includes('daw-fader'),
    '이름 · 악기 · 인서트 · 팬 · 페이더가 콘솔 순서대로',
  );
}

{
  const many = html(React.createElement(MixerStrip, {
    name: 'Drums', role: roleLabel('drums'), color: trackColor('drums'),
    gainDb: 0, pan: 0, mute: false, solo: false, audible: true, selected: false,
    inserts: ['EQ', 'Compressor', 'Transient', 'Imager', 'De-esser'], level: null,
    onSelect: () => {}, onGain: () => {}, onPan: () => {}, onMute: () => {},
    onSolo: () => {}, onOpenInserts: () => {},
  }));
  check(
    'a strip with more inserts than fit says how many are hidden',
    many.includes('+2'),
    '5개 중 3개만 보이고 나머지는 수로',
  );
}

{
  // The fader curve is what makes a console fader feel like one: most of the
  // travel around unity, where the decisions are, and a compressed bottom.
  const unity = faderPosition(0);
  const roundTrip = [-60, -30, -12, -6, 0, 6, 12]
    .every((db) => Math.abs(faderDb(faderPosition(db)) - db) < 0.01);
  check(
    'the fader curve round-trips and puts unity high on the throw',
    roundTrip && unity > 0.8 && unity < 0.95,
    `0 dB = 페이더 ${(unity * 100).toFixed(0)}% 지점 — 선형이면 83%, 아래쪽이 압축돼 있다`,
  );
  check(
    'and half the travel is spent in the top 20 dB',
    faderPosition(-20) < 0.75 && faderPosition(-20) > 0.4,
    `-20 dB = ${(faderPosition(-20) * 100).toFixed(0)}%`,
  );
}

{
  const empty = html(React.createElement(TrackWaveform, {
    peaks: null, color: '#3b82f6', height: 68, zoom: 1, scroll: 0,
  }));
  check(
    'a lane renders before its waveform has arrived',
    empty.includes('<canvas'),
    '피크가 없어도 레인은 그려진다 — 늦게 도착하는 것은 그림뿐',
  );
}

{
  const colors = new Set(['kick', 'bass', 'vocal', 'guitar', 'keys', 'fx'].map((r) =>
    trackColor(r as never)));
  check(
    'instruments are told apart by colour, not by reading',
    colors.size === 6,
    `${colors.size}가지 색 — 어레인지 창은 읽는 게 아니라 훑는 것`,
  );
}

// ── The workspace is white, and wears the instrument ─────────────────────────
{
  // The theme is one attribute on the root, and it is what re-points the
  // design-system variables the plugin views inline. If it stopped being
  // rendered, the DAW would keep its white Tailwind classes and the plugin
  // panel inside it would go back to charcoal — a half-dark screen that no
  // test asserting on Tailwind alone would notice.
  const daw = html(React.createElement(DawPage));
  check(
    'the DAW declares the light theme on its root',
    daw.includes('data-loui-theme="light"'),
    '이 속성이 플러그인 뷰의 디자인 토큰을 밝은 값으로 바꾼다',
  );
  check(
    'and paints white rather than charcoal',
    daw.includes('bg-white') && !/class="[^"]*bg-zinc-9/.test(daw),
    'zinc-900 계열이 남아 있지 않다',
  );

  // Each role's own colours have to reach the DOM, or the classification is
  // a table nobody sees.
  for (const role of ['kick', 'bass', 'vocal'] as const) {
    const p = trackPalette(role, 'light');
    const header = html(React.createElement(TrackHeader, {
      name: `${role} take`, role: roleLabel(role),
      color: p.accent, tint: p.tint, ink: p.ink,
      gainDb: 0, mute: false, solo: false, audible: true, selected: true,
      height: 64, status: 'ready',
      onSelect: () => {}, onGain: () => {}, onMute: () => {},
      onSolo: () => {}, onRemove: () => {},
    }));
    check(
      `a selected ${role} header wears its instrument's colour`,
      header.includes(p.accent) && header.includes(p.tint) && header.includes(p.ink),
      `${p.accent} / ${p.tint} / ${p.ink}`,
    );
  }

  // A silenced track keeps its identity but stops looking live.
  const muted = html(React.createElement(TrackHeader, {
    name: 'muted', role: roleLabel('kick'),
    color: trackPalette('kick', 'light').accent,
    tint: trackPalette('kick', 'light').tint,
    ink: trackPalette('kick', 'light').ink,
    gainDb: 0, mute: true, solo: false, audible: false, selected: false,
    height: 64, status: 'ready',
    onSelect: () => {}, onGain: () => {}, onMute: () => {},
    onSolo: () => {}, onRemove: () => {},
  }));
  check(
    'a silenced track greys its spine instead of keeping the accent',
    !muted.includes(`background:${trackPalette('kick', 'light').accent}`)
      && !muted.includes(`background: ${trackPalette('kick', 'light').accent}`),
    '들리지 않는 트랙은 색을 잃는다 — 악기는 그대로다',
  );
}

// ── 5. The plugin rack ───────────────────────────────────────────────────────

console.log('\n=== THE PLUGIN RACK ===\n');

function ins(id: string, bypass = false): InsertState {
  return { id: id as never, bypass, parameters: {} };
}

{
  const out = html(React.createElement(InsertRack, {
    inserts: [ins('dynamics'), ins('parametric-eq'), ins('deess', true)],
    openId: null,
    onOpen: () => {}, onAdd: () => {}, onRemove: () => {}, onToggleBypass: () => {},
  }));
  check(
    'the rack lists what is on the channel and offers to add more',
    out.includes('글루 컴프레서') && out.includes('치찰음 제거') && out.includes('+ 플러그인 추가'),
    '기존 모듈이 그대로 플러그인으로 올라온다',
  );
  check(
    'a bypassed plugin looks bypassed',
    out.includes('line-through'),
    '꺼진 것과 켜진 것을 눈으로 구별할 수 있다',
  );
}

{
  const out = html(React.createElement(InsertRack, {
    inserts: [], openId: null,
    onOpen: () => {}, onAdd: () => {}, onRemove: () => {}, onToggleBypass: () => {},
  }));
  check(
    'an empty rack says it is empty rather than showing nothing',
    out.includes('비어 있음'),
    '빈 슬롯과 고장난 화면은 달라 보여야 한다',
  );
}

{
  const forbidden = addableModules([]).filter((m) => TRACK_FORBIDDEN.includes(m));
  check(
    'the picker never offers a master-only plugin on a track',
    forbidden.length === 0,
    '리미터·디더는 마스터 버스의 것 — 고를 수 있게 두면 조용히 버려지는 선택지가 된다',
  );
}

{
  const already = addableModules([ins('dynamics')]);
  check(
    'and never offers something already on the channel',
    !already.includes('dynamics' as never) && already.length > 0,
    `${already.length}개 추가 가능`,
  );
}

{
  const ordered = inEngineOrder([ins('imager'), ins('declick'), ins('dynamics'), ins('eq')]);
  check(
    'the rack lists plugins in the order the engine runs them',
    JSON.stringify(ordered.map((i) => i.id)) === JSON.stringify(['declick', 'eq', 'dynamics', 'imager']),
    `${ordered.map((i) => i.id).join(' → ')} — 복원 · 톤 · 다이나믹 · 스테레오`,
  );
}

{
  const missing = MODULE_IDS.filter((m) => !ENGINE_ORDER.includes(m));
  check(
    'every module has a place in that order',
    missing.length === 0,
    missing.length === 0
      ? `${ENGINE_ORDER.length}개`
      : `순서가 없는 모듈: ${missing.join(', ')} — 끝으로 밀려 위치를 속이게 된다`,
  );
}

{
  const start = startingValues('dynamics' as never);
  const def = ALL_PARAM_DEFS.dynamics;
  const bad = def.parameters.filter((p: { id: string }) => start.parameters[p.id] === undefined);
  check(
    'a newly added plugin arrives with every parameter set and switched on',
    bad.length === 0 && start.bypass === false,
    bad.length === 0
      ? '추천값으로 시작하고 켜져 있다 — 이름을 지목해서 추가한 것을 꺼둔 채 주지 않는다'
      : `값이 빠진 파라미터: ${bad.map((p: { id: string }) => p.id).join(', ')}`,
  );
}

// ── 6. Resizable panes ───────────────────────────────────────────────────────

console.log('\n=== PANES ===\n');

{
  const sizes = loadPaneSizes();
  const inRange = (['inspector', 'rack', 'console'] as const).every((k) =>
    sizes[k] >= PANE_LIMITS[k].min && sizes[k] <= PANE_LIMITS[k].max);
  check(
    'pane sizes start inside their limits',
    inRange,
    `인스펙터 ${sizes.inspector} · 랙 ${sizes.rack} · 콘솔 ${sizes.console}`,
  );
}

{
  localStorage.setItem('loui.daw.panes', JSON.stringify({ inspector: 2, rack: 9999, console: -5 }));
  const sizes = loadPaneSizes();
  check(
    'a stored size outside the limits is clamped, not obeyed',
    sizes.inspector === PANE_LIMITS.inspector.min &&
    sizes.rack === PANE_LIMITS.rack.max &&
    sizes.console === PANE_LIMITS.console.min,
    `${sizes.inspector} / ${sizes.rack} / ${sizes.console} — 2픽셀짜리 패널은 사용자가 의도한 레이아웃이 아니다`,
  );
  localStorage.removeItem('loui.daw.panes');
}

{
  localStorage.setItem('loui.daw.panes', 'not json at all');
  const sizes = loadPaneSizes();
  check(
    'and corrupt storage falls back rather than throwing',
    sizes.inspector === PANE_LIMITS.inspector.initial,
    '저장된 레이아웃이 깨져도 창은 열린다',
  );
  localStorage.removeItem('loui.daw.panes');
}

// ── 7. The escape hatch ──────────────────────────────────────────────────────

console.log('\n=== LIVE PLUGINS CAN BE TURNED OFF ===\n');

{
  // The audio thread is the one place in this app where a fault takes the
  // whole window with it, so the way out has to be on the toolbar and has to
  // survive a restart — a switch the user must find again after every
  // relaunch is not an escape hatch.
  const out = html(React.createElement(DawPage));
  check(
    'the toolbar carries the live-plugin switch',
    out.includes('실시간 플러그인 ON'),
    '기본은 켜짐 — 끄면 페이더·팬·솔로만 남고 믹스다운에는 그대로 적용된다',
  );
}

{
  localStorage.setItem('loui.daw.liveChains', 'off');
  const out = html(React.createElement(DawPage));
  check(
    'and the stored choice is what the window opens with',
    out.includes('실시간 플러그인 OFF'),
    '재시작할 때마다 다시 꺼야 한다면 도피처가 아니다',
  );
  localStorage.removeItem('loui.daw.liveChains');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
