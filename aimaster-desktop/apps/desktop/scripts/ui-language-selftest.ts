/**
 * ui-language-selftest — one DAW, one language.
 *
 * The app is Korean.  The audit counted, per file, how many of its visible
 * strings are Korean and how many are English-only, and one panel stood out:
 *
 *   KeyEditorInspector    17 EN /  0 KO
 *   WarpEditor             6 EN /  3 KO
 *   EditWindow             7 EN / 26 KO
 *   IntelPanel             2 EN / 34 KO
 *
 * KeyEditorInspector was not a deliberately English panel — its help text
 * ("코드 버튼: 선택 노트의 최저음을 근음으로 코드를 만듭니다") and every one of
 * its toasts ('벨로시티 100', '크레셴도') were already Korean.  Only the labels
 * had never been translated, so the user read 'Apply Quantize' and then got
 * told '퀀타이즈 적용' by the toast it raised.  WarpEditor had three English
 * verbs in the same Action row as 템포 검출.
 *
 * ── What this does NOT hold ─────────────────────────────────────────────────
 *
 * Not "no English anywhere".  A DAW's jargon is English in every Korean studio
 * and translating it would make the app harder to use, not easier:
 *
 *   • transport and lane abbreviations — SNAP, LOOP, LINK, UNIV, DLY, BYP,
 *     OFFLINE, PUNCH, TAKES, MASTER, TEMPO, WARP;
 *   • units and meters — LUFS, LRA, dBTP, ms, Hz;
 *   • processor names the industry uses untranslated — De-click, De-hum,
 *     De-reverb, Noise Reduction, LFO.
 *
 * What it holds is narrower and is the actual defect: a VERB PHRASE or a
 * SENTENCE aimed at the user, in a panel that otherwise speaks Korean.  Those
 * are the strings a Korean user reads as untranslated rather than as jargon.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:ui-language
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * Source with comments removed.  Three checks in this repo have now been
 * written that matched the SENTENCE describing a defect instead of the defect
 * — including the first draft of this one, which read a section comment that
 * still said 'Scale Assistant' and reported the label as un-translated.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const FILES = execSync(
  "find src/renderer/components/daw src/renderer/pages -name '*.tsx' ! -name '*.stories.tsx'",
  { encoding: 'utf8' },
).trim().split('\n');

/** Every string the user can read: JSX text, and the attributes that show. */
function visibleStrings(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1] ?? '');
    for (const m of line.matchAll(/\b(?:title|label|placeholder|aria-label|blurb|runLabel)=["']([^"']+)["']/g)) {
      out.push(m[1] ?? '');
    }
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const korean = (s: string): boolean => /[가-힣]/.test(s);

/**
 * Is this English aimed at a user, rather than jargon?
 *
 * Two or more English WORDS, or one word that is a verb in the imperative —
 * "Apply Quantize", "Extract from Part", "Unwarp".  A single capitalised noun
 * or an all-caps abbreviation is jargon and passes.
 */
const IMPERATIVES = /^(apply|set|show|snap|extract|quantize|compress|unwarp|warp|humanize|transpose|randomize|catch|reset|clear|add|remove|open|close|save|load|export|import|start|stop)\b/i;
function isSentenceLike(s: string): boolean {
  if (korean(s)) return false;
  // Not code that leaked through the crude JSX scan.
  if (/[{}()[\];=&|]|=>|\.\w+\(/.test(s)) return false;
  if (!/^[A-Za-z][A-Za-z0-9 '’./-]*$/.test(s)) return false;
  const words = s.split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w));
  if (words.length === 0) return false;
  // All-caps is a lane toggle or an abbreviation however many words it has:
  // SNAP, DLY, FOLLOW TEMPO, MAX WIDTH, TAB→TRANSIENT.  A Korean engineer
  // reads these; spelling them out in Korean would make the strip unreadable.
  if (s === s.toUpperCase()) return false;
  return words.length >= 2 || IMPERATIVES.test(s);
}

/** Jargon that is two words but still jargon — the industry's own names. */
const ALLOWED = new Set([
  'Noise Reduction', 'De-click', 'De-clip', 'De-hum', 'De-reverb', 'De-ess',
  'Dynamic EQ', 'Stereo Imager', 'True Peak', 'Target LUFS', 'Limiter Strength',
  'Mastering Engine', 'True Peak Ceiling', 'Smart Controls', 'Key Editor',
  'Gtr ##', 'Gtr 01',
  // The mastering pages name their DSP parameters in English and explain them
  // in Korean underneath — "Target LUFS" with "-14 = YouTube/Spotify …".  That
  // is consistent WITHIN the panel and matches every plugin a user owns, so it
  // is a house style, not an untranslated label.
  'Output Gain', 'Stereo Width', 'Low Cut', 'Low-Mono Freq', 'Dry/Wet',
]);

interface Hit { file: string; text: string }
const hits: Hit[] = [];
let scanned = 0;
for (const file of FILES) {
  const strings = visibleStrings(readFileSync(file, 'utf8'));
  scanned += strings.length;
  for (const s of strings) {
    if (ALLOWED.has(s)) continue;
    if (isSentenceLike(s)) hits.push({ file: file.replace('src/renderer/', ''), text: s });
  }
}

check('the scan is actually reading the app', () => {
  // Thousands of visible strings across the DAW; near zero means the JSX
  // scan stopped matching and every check below is vacuous.
  assert(scanned > 500, `only ${scanned} visible strings found — the scan is not seeing the app`);
  assert(FILES.length > 40, `only ${FILES.length} files walked`);
});

check('no panel asks the user to do something in English', () => {
  assert(hits.length === 0,
    `${hits.length} English phrase(s) aimed at the user: `
    + hits.map((h) => `${h.file} "${h.text}"`).join(' | '));
});

check('the key editor inspector speaks the language the rest of it does', () => {
  // The panel this started with.  Its toasts were always Korean; the labels
  // above the buttons that raised them were not.
  const src = stripComments(readFileSync('src/renderer/components/daw/midi/KeyEditorInspector.tsx', 'utf8'));
  const strings = visibleStrings(src);
  const ko = strings.filter(korean).length;
  assert(ko >= 20, `only ${ko} Korean strings in the inspector — it was 0`);
  for (const gone of ['Apply Quantize', 'Scale Assistant', 'Extract from Part', 'Apply Groove']) {
    assert(!src.includes(gone), `'${gone}' is back in the inspector`);
  }
});

check('a verb is a verb in the same row as its neighbours', () => {
  // WarpEditor had Warp to Tempo / Auto-Warp / Unwarp beside 템포 검출 —
  // the same Action component, the same row, two languages.
  const src = stripComments(readFileSync('src/renderer/components/daw/warp/WarpEditor.tsx', 'utf8'));
  for (const gone of ['Warp to Tempo', 'Auto-Warp', 'Unwarp']) {
    assert(!src.includes(`>${gone}<`), `'${gone}' is back in the warp editor`);
  }
  assert(src.includes('템포 검출'), 'the Korean neighbour this was matched to is gone');
});

check('the jargon nobody translates is still there', () => {
  // The other half of the promise: this must not turn into a crusade that
  // renames SNAP to 스냅 and De-click to 디클릭.  A Korean engineer reads those,
  // and every plugin they own is labelled that way.
  //
  // Checked against the strings the user SEES, not against the file.  The
  // first version asked whether the word appeared anywhere, and passed on a
  // file where the rendered label had been translated and only the identifier
  // `SNAP_LABELS` and a `{/* De-click */}` comment still carried the word —
  // which is the same defect this suite already fixed twice, in a guard
  // written to prevent it.
  const shown = (file: string): string[] => visibleStrings(stripComments(readFileSync(file, 'utf8')));
  const edit = shown('src/renderer/components/daw/edit/EditWindow.tsx');
  for (const kept of ['UNIV', 'LINK', 'FOLLOW']) {
    assert(edit.includes(kept), `${kept} is no longer a label in the edit window — it is jargon, not a sentence`);
  }
  // SNAP is the piano roll's, not the arrangement's — the first version of
  // this check asked EditWindow for it and failed on a clean tree.
  const keys = shown('src/renderer/components/daw/midi/KeyEditor.tsx');
  for (const kept of ['SNAP', 'Grid']) {
    assert(keys.includes(kept), `${kept} is no longer a label in the key editor — it is jargon, not a sentence`);
  }
  const restore = shown('src/renderer/components/daw/restore/RestorePanel.tsx');
  for (const kept of ['De-click', 'De-hum', 'Noise Reduction']) {
    assert(restore.includes(kept), `${kept} is no longer a module title — it is the industry's own name`);
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== UI language: one DAW, one language ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${scanned} visible strings across ${FILES.length} files`);
console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
