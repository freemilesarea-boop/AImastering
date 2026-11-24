#!/usr/bin/env node
/**
 * capture.mjs — walk every screen of the running dev app, photograph it, and
 * write down every control on it.
 *
 *   node scripts/feature-book/capture.mjs <outdir> [cdp-port]
 *
 * The book is built from what the app ACTUALLY shows, not from a list someone
 * maintained by hand: a feature book written from source drifts the first time
 * a button is renamed, and nobody finds out until a student does.  So each
 * scene is driven, settled, photographed, and its controls are read out of the
 * live DOM with their tooltips — which, since the tooltips are derived from
 * the command table, carry each control's shortcut with them.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const OUT = process.argv[2];
const PORT = process.argv[3] ?? '9333';
if (!OUT) { console.error('usage: capture.mjs <outdir> [cdp-port]'); process.exit(2); }
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything a user can press, read straight off the page. */
const CONTROLS = () => {
  const seen = [];
  const sel = 'button, select, input, textarea, [role="button"], [role="tab"], [role="menuitem"]';
  for (const el of document.querySelectorAll(sel)) {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    // Asked in the order a person would read it, and then the places a
    // developer leaves a name when the button is only an icon.  Without the
    // fallbacks a tenth of the book's rows said "(이름 없음)", which is a
    // feature book admitting it did not look very hard.
    let label = (el.getAttribute('aria-label')
      || el.innerText
      || el.getAttribute('placeholder')
      || el.value
      || el.getAttribute('data-testid')
      || el.getAttribute('name')
      || el.id
      || '').replace(/\s+/g, ' ').trim();
    if (!label) {
      const svgTitle = el.querySelector('svg title, title')?.textContent ?? '';
      label = svgTitle.replace(/\s+/g, ' ').trim();
    }
    if (!label && el.tagName === 'INPUT') {
      const wrap = el.closest('label');
      label = (wrap?.innerText ?? '').replace(/\s+/g, ' ').trim();
    }
    seen.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') ?? '',
      label: label.slice(0, 80),
      title: (el.getAttribute('title') ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      disabled: el.disabled === true,
      x: Math.round(box.x), y: Math.round(box.y),
      w: Math.round(box.width), h: Math.round(box.height),
    });
  }
  return seen;
};

/** Wait until the page stops adding controls — two equal reads in a row. */
async function settle(page, maxMs = 6000) {
  const count = () => page.evaluate(
    () => document.querySelectorAll('button, select, input, [role="button"]').length);
  const until = Date.now() + maxMs;
  let last = -1;
  while (Date.now() < until) {
    const now = await count().catch(() => -1);
    if (now === last && now >= 0) return now;
    last = now;
    await sleep(350);
  }
  return last;
}

const scenes = [];
async function shoot(page, { id, title, section, note }) {
  await settle(page);
  const file = path.join('shots', `${id}.png`);
  await page.screenshot({ path: path.join(OUT, file), scale: 'css' });
  const controls = await page.evaluate(CONTROLS);
  const heading = await page.evaluate(() => {
    const h = document.querySelector('h1, h2');
    return (h?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  });
  scenes.push({ id, title, section, note: note ?? '', shot: file, heading, controls });
  console.log(`  ${id.padEnd(26)} ${String(controls.length).padStart(4)} controls`);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools://'));
if (!page) { console.error('no page over CDP — is the dev app up?'); process.exit(1); }

// ONLY the restore toast.  The first version also pressed anything labelled
// 닫기, and on the settings and result screens that is the button that goes
// back home: every one of those screens photographed as the home page, and
// the pictures were identical enough that the mistake was visible only
// because two of them were the same file twice over.
const dismiss = () => page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    if ((b.innerText ?? '').trim() === '무시') b.click();
  }
});

// ── A real song, so the screens have something in them ──────────────────────
//
// An empty app photographs as an empty app: the mastering queue with no rows,
// the result screen bounced back to home, QC saying it has nothing to check.
// None of that is what the feature is.  So the book is shot over a real file
// that has been analysed and rendered, the same way the smoke does it.
const SR = 48000;
function writeWav(file, secs = 6) {
  const n = SR * secs;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of [60, 220, 1000, 4200, 9000]) v += 0.12 * Math.sin(2 * Math.PI * f * i / SR);
    const s16 = Math.max(-1, Math.min(1, v)) * 32767 | 0;
    buf.writeInt16LE(s16, 44 + i * 4); buf.writeInt16LE(s16, 44 + i * 4 + 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}
const SRC = writeWav(path.join(OUT, 'media', 'book-source.wav'));
console.log(`  source  ${SRC}`);

// A real keystroke before anything else.
//
// `setPage('result')` is REFUSED until the window has seen a pointerdown or a
// keydown — a guard that stops a stale route loading the result screen with
// no data behind it.  Without it the call returns quietly, the page does not
// change, and the screenshot is of whatever was there before: the first run
// of this script photographed the DAW and labelled it 결과.
await page.keyboard.press('Shift');
await sleep(200);
await dismiss();

/**
 * Go to a page and CHECK that we got there.
 *
 * The store's field is `currentPage`, and `setPage` can decline.  A capture
 * that does not read back what it asked for will photograph the wrong screen
 * under the right caption and look perfect doing it.
 */
async function goPage(id) {
  await page.evaluate((p) => import('/stores/appStore.ts')
    .then((m) => m.useAppStore.getState().setPage(p)), id);
  await sleep(1300);
  const at = await page.evaluate(() => import('/stores/appStore.ts')
    .then((m) => m.useAppStore.getState().currentPage));
  if (at !== id) throw new Error(`asked for page '${id}' and the app is on '${at}'`);
}

/** The same, for the DAW's own windows. */
async function goWindow(mode) {
  await page.evaluate((w) => import('/stores/dawStore.ts')
    .then((m) => m.useDawStore.getState().setWindow(w)), mode);
  await sleep(1100);
  const at = await page.evaluate(() => import('/stores/dawStore.ts')
    .then((m) => m.useDawStore.getState().window));
  if (at !== mode) throw new Error(`asked for window '${mode}' and the DAW is on '${at}'`);
}

await page.evaluate(async (p) => {
  const mod = await import('/stores/audioStore.ts');
  mod.useAudioStore.getState().clearQueue();
  mod.useAudioStore.getState().addFilesToQueue([p]);
}, SRC);
await sleep(1200);

// The home screen, with a file waiting in the queue.
await goPage('home');
await dismiss();
await shoot(page, { id: 'page-home', title: '홈',
  section: '화면', note: '처음 열리는 화면 — 파일을 끌어다 놓고, 프리셋을 고르고, 시작하는 곳' });

// The mastering screen is NOT a screen you browse.
//
// Entering it with a file selected starts a real run, and what it shows is
// that run's progress; with no file it sends you straight back home.  The
// first version of this script treated it as a page to visit and spent three
// attempts photographing whatever happened to be on screen instead.  So the
// book shows it doing its job, and then follows the app to where the app
// itself goes next — the result screen, which it routes to on its own.
await page.evaluate((p) => import('/stores/audioStore.ts')
  .then((m) => m.useAudioStore.getState().setFile(p)), SRC);
await sleep(400);
await goPage('mastering');
await shoot(page, { id: 'page-mastering', title: '마스터링 진행',
  section: '화면', note: '파일 검사 · 분석 · 톤 보정 · 라우드니스 · 사후 검증을 차례로 보여줍니다' });

const landed = await (async () => {
  for (let i = 0; i < 120; i++) {
    const at = await page.evaluate(() => import('/stores/appStore.ts')
      .then((m) => m.useAppStore.getState().currentPage));
    if (at === 'result') return true;
    await sleep(1000);
  }
  return false;
})();
console.log(`  master  ${landed ? 'finished — the app routed itself to 결과' : 'did not reach 결과 in 120s'}`);
if (!landed) throw new Error('the mastering run never reached the result screen');

for (const [id, title, note] of [
  ['result', '결과', '마스터링이 끝난 뒤 원본과 비교하고 저장하는 화면'],
  ['tweak', '세부 조정', '체인의 각 단을 직접 만지는 화면'],
  ['studio', '스튜디오', '모듈 랙 — 체인 전체를 손으로 쌓는 화면'],
  ['qc', 'QC 리포트', '납품 전 규격 검사'],
  ['settings', '설정', '앱 전체 설정 — 출력 폴더 · 엔진 · 라이선스'],
]) {
  await goPage(id);
  await dismiss();
  await shoot(page, { id: `page-${id}`, title, section: '화면', note });
}

// ── The DAW, window by window ────────────────────────────────────────────────
const WINDOWS = [
  ['edit', 'EDIT — 편집', '클립을 자르고 붙이고 옮기는 기본 창'],
  ['mix', 'MIX — 믹서', '채널 스트립 · 인서트 · 센드'],
  ['key', 'KEY — 피아노 롤', 'MIDI 노트를 그리고 다듬는 창'],
  ['chain', 'CHAIN — 체인', '트랙의 장치 체인을 쌓는 창'],
  ['session', 'SESSION — 세션', '클립을 칸에 놓고 실시간으로 띄우는 창'],
  ['steps', 'STEPS — 스텝', '스텝 시퀀서'],
  ['warp', 'WARP — 워프', '타이밍을 늘리고 당기는 창'],
  ['spectral', 'SPECTRAL — 스펙트럼', '주파수로 보고 고치는 창'],
  ['vocal', 'VOCAL — 보컬', '피치와 타이밍 보정'],
  ['stems', 'STEMS — 스템', '소스를 분리하는 창'],
  ['restore', 'RESTORE — 복원', '잡음 · 클릭 · 험 제거'],
  ['reference', 'REFERENCE — 레퍼런스', '기준 곡과 나란히 비교'],
  ['ai', 'AI — 어시스턴트', '분석과 제안'],
];
await goPage('daw');
await sleep(1200);
await dismiss();
// A session with tracks in it.  Empty lanes photograph as empty lanes, and a
// feature book made of those teaches nothing about the feature.
await page.evaluate(async () => {
  const ct = await import('/daw/model/course-templates.ts');
  const tt = await import('/daw/model/track-template.ts');
  const daw = await import('/stores/dawStore.ts');
  const band = ct.COURSE_TEMPLATES.find((t) => t.name === '밴드 믹스') ?? ct.COURSE_TEMPLATES[0];
  daw.useDawStore.getState().loadSession(tt.sessionFromTemplate(band).session);
});
await sleep(1600);
for (const [mode, title, note] of WINDOWS) {
  await goWindow(mode);
  await dismiss();
  await shoot(page, { id: `daw-${mode}`, title, section: 'DAW 창', note });
}

// ── The panels and overlays ──────────────────────────────────────────────────
await goWindow('edit');

// ── The right-click menus ───────────────────────────────────────────────────
//
// A feature book that only photographs what is visible misses the half of the
// app that lives behind the secondary click: twenty-seven commands on a track
// header, each of them printing its own shortcut.
{
  await goWindow('edit');
  const at = await page.evaluate(() => {
    const lanes = document.querySelectorAll(
      'div.flex-1.flex.overflow-y-auto > div.flex-1.relative.overflow-hidden');
    const lane = lanes[0];
    if (!lane) return null;
    const rows = [...lane.querySelectorAll(':scope > [data-track-id]')].map((el) => el.getBoundingClientRect());
    const header = lane.previousElementSibling?.getBoundingClientRect() ?? null;
    if (rows.length === 0 || !header) return null;
    return { x: header.left + header.width / 2, y: rows[0].top + rows[0].height * 0.5 };
  });
  if (at) {
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await sleep(700);
    const open = await page.evaluate(() => import('/stores/contextMenuStore.ts')
      .then((m) => Boolean(m.useContextMenuStore.getState().menu)));
    if (!open) throw new Error('the right-click opened no menu');
    await shoot(page, { id: 'menu-track', title: '트랙 헤더 우클릭 메뉴', section: '우클릭 메뉴',
      note: '트랙 위에서 오른쪽 버튼 — 각 줄이 자기 단축키를 함께 보여줍니다' });
    await page.keyboard.press('Escape');
    await sleep(400);
  } else {
    console.log('  menu-track                 skipped — no track row on screen');
  }
}

const OVERLAYS = [
  ['templates', '템플릿', '수업용 기본 템플릿과 내가 저장한 템플릿',
    () => import('/stores/dawStore.ts').then((m) => m.useDawStore.getState().setTemplatesOpen(true)),
    () => import('/stores/dawStore.ts').then((m) => m.useDawStore.getState().setTemplatesOpen(false))],
  ['help', '단축키 도움말', '244개 명령을 그룹과 단계로 보여주는 오버레이',
    () => import('/stores/workspaceStore.ts').then((m) => m.useWorkspaceStore.getState().setPanel('help', true)),
    () => import('/stores/workspaceStore.ts').then((m) => m.useWorkspaceStore.getState().setPanel('help', false))],
];
OVERLAYS.push(['palette', '명령 팔레트', '이름으로 244개 명령을 찾아 실행하는 창 (Mod+P)',
  () => import('/stores/workspaceStore.ts').then((m) => m.useWorkspaceStore.getState().setPanel('palette', true)),
  () => import('/stores/workspaceStore.ts').then((m) => m.useWorkspaceStore.getState().setPanel('palette', false))]);

for (const [id, title, note, open, close] of OVERLAYS) {
  await page.evaluate(open);
  await sleep(1200);
  await shoot(page, { id: `panel-${id}`, title, section: '패널', note });
  await page.evaluate(close);
  await sleep(500);
}

fs.writeFileSync(path.join(OUT, 'scenes.json'), `${JSON.stringify(scenes, null, 2)}\n`);
const total = scenes.reduce((n, s) => n + s.controls.length, 0);
console.log(`\n  ${scenes.length} scenes · ${total} controls photographed`);
// NOT closed: `browser.close()` over CDP closes the app, and leaving it up
// means a re-run costs a second rather than a fresh boot.
process.exit(0);
