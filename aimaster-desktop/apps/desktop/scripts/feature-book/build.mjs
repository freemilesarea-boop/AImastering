#!/usr/bin/env node
/**
 * build.mjs — assemble the feature book and print it to PDF.
 *
 *   node scripts/feature-book/build.mjs <dir>
 *
 * <dir> holds what `capture.mjs` and `book-inventory.ts` wrote: scenes.json,
 * inventory.json and shots/.  Nothing here is typed by hand — the screens come
 * from photographs of the running app, the controls from that app's own DOM,
 * and the commands, devices and instruments from the modules the app itself
 * imports.  A book written any other way is right on the day it is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const DIR = process.argv[2];
if (!DIR) { console.error('usage: build.mjs <dir>'); process.exit(2); }
const scenes = JSON.parse(fs.readFileSync(path.join(DIR, 'scenes.json'), 'utf8'));
const inv = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory.json'), 'utf8'));

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Group a scene's controls so fourteen identical mute buttons read as one row. */
function rows(controls) {
  const by = new Map();
  for (const c of controls) {
    const key = `${c.tag}\u0000${c.label}\u0000${c.title}`;
    const at = by.get(key);
    if (at) { at.count += 1; continue; }
    by.set(key, { ...c, count: 1 });
  }
  return [...by.values()].sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label, 'ko'));
}

const KIND = { button: '버튼', select: '선택', input: '입력', textarea: '글상자' };
const kindOf = (c) => (c.tag === 'input' && c.type ? `입력 · ${c.type}` : (KIND[c.tag] ?? c.tag));

const sections = [];
const push = (id, title, html) => sections.push({ id, title, html });

// ── 1부 — 화면 ───────────────────────────────────────────────────────────────
const bySection = new Map();
for (const s of scenes) {
  if (!bySection.has(s.section)) bySection.set(s.section, []);
  bySection.get(s.section).push(s);
}
let sceneHtml = '';
for (const [group, list] of bySection) {
  sceneHtml += `<h2 class="grp">${esc(group)}</h2>`;
  for (const s of list) {
    const r = rows(s.controls);
    sceneHtml += `
<section class="scene">
  <h3>${esc(s.title)}</h3>
  <p class="note">${esc(s.note)}</p>
  <img src="${esc(s.shot)}" alt="${esc(s.title)}">
  <p class="cap">이 화면의 컨트롤 ${s.controls.length}개 · 서로 다른 것 ${r.length}종</p>
  <table>
    <thead><tr><th>이름</th><th>종류</th><th>설명 · 단축키</th><th class="n">개수</th></tr></thead>
    <tbody>
    ${r.map((c) => `<tr${c.disabled ? ' class="off"' : ''}>
      <td>${esc(c.label) || '<span class="muted">(이름 없음)</span>'}</td>
      <td class="k">${esc(kindOf(c))}</td>
      <td class="d">${esc(c.title)}</td>
      <td class="n">${c.count > 1 ? `×${c.count}` : ''}</td></tr>`).join('')}
    </tbody>
  </table>
</section>`;
  }
}
push('screens', '1부 · 화면과 컨트롤', sceneHtml);

// ── 2부 — 명령 ───────────────────────────────────────────────────────────────
let cmdHtml = '';
for (const [gid, gtitle] of Object.entries(inv.groups)) {
  const list = inv.commands.filter((c) => c.group === gid);
  if (list.length === 0) continue;
  cmdHtml += `<h3>${esc(gtitle)} <span class="muted">${list.length}개</span></h3>
  <table><thead><tr><th>명령</th><th>단축키</th><th>설명</th></tr></thead><tbody>
  ${list.map((c) => `<tr${c.available ? '' : ' class="off"'}>
    <td>${esc(c.label)}</td>
    <td class="key">${c.chords.map((k) => `<code>${esc(k)}</code>`).join(' / ') || '<span class="muted">—</span>'}</td>
    <td class="d">${esc(c.note)}${c.available ? '' : ' <span class="muted">(이 빌드에서는 동작하지 않습니다)</span>'}</td>
  </tr>`).join('')}</tbody></table>`;
}
push('commands', `2부 · 명령 ${inv.commands.length}개`, cmdHtml);

// ── 3부 — 이펙트 ─────────────────────────────────────────────────────────────
const devHtml = inv.plugins.map((p) => `
<section class="dev">
  <h3>${esc(p.name)} <span class="muted">${esc(p.id)}</span></h3>
  ${p.params.length === 0 ? '<p class="note">조절할 파라미터가 없습니다 — 켜고 끄는 장치입니다.</p>' : `
  <table><thead><tr><th>파라미터</th><th>범위</th><th>기본값</th><th>단위</th></tr></thead><tbody>
  ${p.params.map((q) => `<tr><td>${esc(q.name)} <span class="muted">${esc(q.id)}</span></td>
    <td class="n">${q.min} ~ ${q.max}</td><td class="n">${q.default}</td><td>${esc(q.unit || '—')}</td></tr>`).join('')}
  </tbody></table>`}
</section>`).join('');
push('devices', `3부 · 이펙트 ${inv.plugins.length}개`, devHtml);

// ── 4부 — 악기 ───────────────────────────────────────────────────────────────
push('instruments', `4부 · 악기 ${inv.instruments.length}개`, `
<table><thead><tr><th>악기</th><th>id</th><th class="n">파라미터</th></tr></thead><tbody>
${inv.instruments.map((i) => `<tr><td>${esc(i.name)}</td><td><code>${esc(i.id)}</code></td><td class="n">${i.params}</td></tr>`).join('')}
</tbody></table>`);

// ── The book ─────────────────────────────────────────────────────────────────
const totalControls = scenes.reduce((n, s) => n + s.controls.length, 0);
const today = new Date().toISOString().slice(0, 10);
const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'), 'utf8'));

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>LV DAW 기능북</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
  :root { --ink:#15171c; --soft:#5d6472; --line:#d8dce4; --accent:#4b3fa7; --bg:#f7f8fb; }
  * { box-sizing: border-box; }
  body { font-family:'Noto Sans CJK KR','Noto Sans KR',sans-serif; color:var(--ink);
         font-size:9.6pt; line-height:1.5; margin:0; }
  code { font-family:'Noto Sans Mono CJK KR',monospace; font-size:8.6pt;
         background:var(--bg); border:1px solid var(--line); border-radius:3px; padding:0 3px; }
  h1 { font-size:30pt; margin:0 0 6pt; letter-spacing:-0.5pt; }
  h2.grp { font-size:15pt; margin:16pt 0 8pt; color:var(--accent); border-bottom:2px solid var(--accent);
           padding-bottom:3pt; break-after:avoid; break-before:auto; }
  h2.part { font-size:20pt; margin:0 0 10pt; color:var(--accent); break-before:page; }
  h3 { font-size:12pt; margin:12pt 0 5pt; break-after:avoid; }
  p { margin:0 0 6pt; }
  .note { color:var(--soft); margin:0 0 7pt; }
  .cap { color:var(--soft); font-size:8.4pt; margin:5pt 0 4pt; }
  .muted { color:var(--soft); font-weight:400; font-size:8.4pt; }
  img { width:100%; border:1px solid var(--line); border-radius:4px; display:block; }
  table { width:100%; border-collapse:collapse; margin:0 0 10pt; }
  th { text-align:left; font-size:8.2pt; color:var(--soft); text-transform:uppercase;
       letter-spacing:.4pt; border-bottom:1.5px solid var(--line); padding:3pt 4pt; }
  td { border-bottom:1px solid var(--line); padding:3pt 4pt; vertical-align:top; }
  td.k { color:var(--soft); white-space:nowrap; width:62pt; }
  td.d { color:#333; }
  td.n, th.n { text-align:right; white-space:nowrap; width:42pt; }
  td.key { white-space:nowrap; width:120pt; }
  tr.off td { color:#9aa1ae; }
  section.scene, section.dev { break-inside:avoid-page; margin:0 0 14pt; }
  .cover { height:247mm; display:flex; flex-direction:column; justify-content:center; }
  .cover .big { font-size:46pt; line-height:1.05; letter-spacing:-1pt; }
  .cover .sub { font-size:13pt; color:var(--soft); margin-top:8pt; }
  .facts { margin-top:26pt; border-top:2px solid var(--accent); padding-top:10pt; }
  .facts b { font-size:17pt; }
  .toc { list-style:none; padding:0; }
  .toc li { margin:4pt 0; display:flex; align-items:baseline; gap:6pt; font-size:11pt; }
  .toc li::after { content:''; flex:1; border-bottom:1px dotted var(--line); }
  .toc .pg { order:3; color:var(--soft); font-variant-numeric:tabular-nums; }
</style></head><body>

<div class="cover">
  <div class="big">LV DAW<br>기능북</div>
  <div class="sub">이 앱이 가진 모든 화면 · 모든 컨트롤 · 모든 명령</div>
  <div class="facts">
    <p><b>${scenes.length}</b> 화면 &nbsp;·&nbsp; <b>${totalControls}</b> 컨트롤 &nbsp;·&nbsp;
       <b>${inv.commands.length}</b> 명령 &nbsp;·&nbsp; <b>${inv.plugins.length}</b> 이펙트 &nbsp;·&nbsp;
       <b>${inv.instruments.length}</b> 악기</p>
    <p class="note">버전 ${esc(pkg.version)} · ${today} 기준 · 실행 중인 앱을 직접 찍고 읽어서 만들었습니다.</p>
  </div>
</div>

<h2 class="part">목차</h2>
<ul class="toc">${sections.map((s) => `<li>${esc(s.title)}<span class="pg">__PAGE_${s.id}__</span></li>`).join('')}</ul>
<p class="note">1부의 각 화면은 실제 스크린샷과, 그 화면에서 누를 수 있는 모든 컨트롤의 목록입니다.
같은 버튼이 여러 번 나오는 경우(채널 14개의 음소거 버튼처럼) 한 줄로 묶고 개수를 적었습니다.</p>

${sections.map((s) => `<h2 class="part">${esc(s.title)}</h2>${s.html}`).join('')}

</body></html>`;

const htmlPath = path.join(DIR, 'book.html');
const pdfPath = path.join(DIR, 'LV-DAW-기능북.pdf');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--headless'],
});
const page = await browser.newPage();

/**
 * Print once with the contents' page numbers left as placeholders, read the
 * numbers back out of that PDF, then print again with them filled in.
 *
 * A hundred-page reference whose contents cannot say WHERE anything is is a
 * hundred pages of scrolling.  There is no way to know a page number before
 * the pages exist, so the book is printed twice and the first one is thrown
 * away — which costs four seconds and is the whole of the trick.
 */
async function render(markup, out) {
  fs.writeFileSync(htmlPath, markup);
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: out, format: 'A4', printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: `<div style="width:100%;font-size:7pt;color:#8b93a1;
     font-family:'Noto Sans CJK KR',sans-serif;padding:0 14mm;display:flex;justify-content:space-between">
     <span>LV DAW 기능북 · ${today}</span><span class="pageNumber"></span></div>`,
  margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
  });
}

const draft = path.join(DIR, 'draft.pdf');
await render(html, draft);

// Which page each part landed on, read from the draft's own text.
const { execFileSync } = await import('node:child_process');
let numbers = {};
try {
  const txt = execFileSync('pdftotext', ['-layout', draft, '-'], { encoding: 'utf8' });
  const pages = txt.split('\f');
  for (const sec of sections) {
    const title = sec.title;
    // Skip the contents page itself, where every title also appears.
    const at = pages.findIndex((p, i) => i > 1 && p.indexOf(title) >= 0 && p.indexOf(title) < 400);
    if (at >= 0) numbers[sec.id] = at + 1;
  }
} catch (err) {
  console.warn(`  (no page numbers in the contents: ${String(err?.message ?? err)})`);
}
const finalHtml = html.replace(/__PAGE_([a-z]+)__/g,
  (_, id) => (numbers[id] ? String(numbers[id]) : ''));
await render(finalHtml, pdfPath);
fs.rmSync(draft, { force: true });
await browser.close();

const bytes = fs.statSync(pdfPath).size;
console.log(`  ${path.basename(pdfPath)}  ${(bytes / 1e6).toFixed(2)} MB`);
console.log(`  ${scenes.length} scenes · ${totalControls} controls · ${inv.commands.length} commands`
  + ` · ${inv.plugins.length} effects · ${inv.instruments.length} instruments`);
