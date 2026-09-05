/**
 * provenance-selftest — what made the recording, written into the recording.
 *
 * The chunks are PARSED back the way a reader parses them (walk the chunk
 * list, honour every size field) rather than searched for as strings.  A file
 * whose sizes are wrong still contains all the right text, so a substring
 * search passes on a file no tool can open — which is the exact failure this
 * has to catch.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:provenance
 */

import { encodeWav } from '../src/renderer/daw/engine/wav.js';
import {
  BASIS_LABELS, describeProvenance, emptyProvenance, isDerivative, provenanceProblem,
  usedAi, withAiStep, withHumanWork, withSource, type Provenance,
} from '../src/renderer/daw/model/provenance.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

// ── A reader, not a search ───────────────────────────────────────────────────

interface Chunk { id: string; body: Uint8Array }

/** Walk a RIFF file exactly as a reader does, refusing anything malformed. */
function parseRiff(bytes: Uint8Array): { format: string; chunks: Chunk[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, n: number): string =>
    String.fromCharCode(...bytes.subarray(at, at + n));
  assert(ascii(0, 4) === 'RIFF', 'starts with RIFF');
  const riffSize = view.getUint32(4, true);
  assert(riffSize + 8 === bytes.length,
    `RIFF size ${riffSize} does not match the file (${bytes.length - 8} bytes follow it)`);

  const chunks: Chunk[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(at, 4);
    const size = view.getUint32(at + 4, true);
    assert(at + 8 + size <= bytes.length,
      `chunk '${id}' says ${size} bytes but the file ends first`);
    chunks.push({ id, body: bytes.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size % 2);   // odd chunks carry a pad byte
  }
  assert(at === bytes.length, `chunk walk ended at ${at}, file is ${bytes.length}`);
  return { format: ascii(8, 4), chunks };
}

function infoTagsOf(chunks: readonly Chunk[]): Map<string, string> {
  const list = chunks.find((c) => c.id === 'LIST');
  const out = new Map<string, string>();
  if (!list) return out;
  const body = list.body;
  assert(String.fromCharCode(...body.subarray(0, 4)) === 'INFO', 'the LIST is an INFO list');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let at = 4;
  while (at + 8 <= body.length) {
    const id = String.fromCharCode(...body.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    const text = new TextDecoder().decode(body.subarray(at + 8, at + 8 + size)).replace(/\0+$/, '');
    out.set(id, text);
    at += 8 + size + (size % 2);
  }
  return out;
}

const APP = '3.6.1';
const AT = new Date('2026-09-05T12:00:00Z');
const silence = [new Float32Array(64), new Float32Array(64)];

function encoded(p: Provenance): Uint8Array {
  return encodeWav(silence, 48000, 24, 'none', { provenance: p, appVersion: APP, at: AT });
}

/** A real case: a remix of a licensed track, AI-mastered. */
function remix(): Provenance {
  let p = emptyProvenance('You Make Me Wanna (Loui Remix)', 'theblank');
  p = { ...p, year: 2026, copyright: '© 2026 theblank' };
  p = withHumanWork(p, '편곡·믹스');
  p = withHumanWork(p, '보컬 재녹음');
  p = withAiStep(p, { kind: 'mastering', detail: 'Loui AI Pop · −10 LUFS' });
  p = withAiStep(p, { kind: 'separation', detail: '보컬/반주 분리' });
  p = withSource(p, {
    title: 'You Make Me Wanna', artist: 'Original Artist',
    isrc: 'KRA382600001', basis: 'licensed', note: 'sync licence #4412',
  });
  return p;
}

// ── The file is still a file ─────────────────────────────────────────────────

check('a file with metadata is still a well-formed WAV', () => {
  const { format, chunks } = parseRiff(encoded(remix()));
  assert(format === 'WAVE', 'it is a WAVE');
  const ids = chunks.map((c) => c.id);
  assert(ids.includes('fmt '), 'fmt is there');
  assert(ids.includes('data'), 'data is there');
  assert(ids.indexOf('fmt ') < ids.indexOf('data'), 'and fmt comes first');
});

check('the audio survives being pushed off byte 44', () => {
  // Metadata moves `data`.  Anything that assumed offset 44 now reads the
  // metadata as samples — a burst of noise where the music starts.
  const bare = parseRiff(encodeWav(silence, 48000, 24, 'none'));
  const tagged = parseRiff(encoded(remix()));
  const dataOf = (cs: Chunk[]): Uint8Array => cs.find((c) => c.id === 'data')!.body;
  assert(dataOf(tagged.chunks).length === dataOf(bare.chunks).length,
    'the same samples are there');
  assert(dataOf(tagged.chunks).every((b, i) => b === dataOf(bare.chunks)[i]),
    'and byte for byte identical');
  const fmtA = bare.chunks.find((c) => c.id === 'fmt ')!.body;
  const fmtB = tagged.chunks.find((c) => c.id === 'fmt ')!.body;
  assert(fmtA.every((b, i) => b === fmtB[i]), 'the format block is untouched');
});

check('every chunk length is honest, including the odd ones', () => {
  // An odd-length chunk needs a pad byte that its SIZE does not count.  Get
  // this wrong and every later chunk is read at the wrong offset — parseRiff
  // above refuses the file rather than limping.
  const odd = withHumanWork(emptyProvenance('A', 'B'), 'x'.repeat(7));
  const { chunks } = parseRiff(encoded(odd));   // throws if any size lies
  assert(chunks.length >= 4, `fmt, LIST, bext, LOUI, data — got ${chunks.map((c) => c.id).join(',')}`);
});

// ── What it says ─────────────────────────────────────────────────────────────

check('the tags every player reads carry the title, artist and comment', () => {
  const tags = infoTagsOf(parseRiff(encoded(remix())).chunks);
  assert(tags.get('INAM') === 'You Make Me Wanna (Loui Remix)', `INAM: ${tags.get('INAM')}`);
  assert(tags.get('IART') === 'theblank', `IART: ${tags.get('IART')}`);
  assert(tags.get('ICOP') === '© 2026 theblank', `ICOP: ${tags.get('ICOP')}`);
  assert(tags.get('ICRD') === '2026', `ICRD: ${tags.get('ICRD')}`);
  assert((tags.get('ISFT') ?? '').includes('Louver Mastering AI'), 'ISFT names the app');
});

check('Korean and the © sign survive the round trip', () => {
  // ASCII-only encoding would turn 편곡 into mojibake, and the field a claim
  // reviewer reads is the one that has to be legible.
  const tags = infoTagsOf(parseRiff(encoded(remix())).chunks);
  const comment = tags.get('ICMT') ?? '';
  assert(comment.includes('편곡·믹스'), `the Korean is intact: ${comment.slice(0, 60)}`);
  assert((tags.get('ICOP') ?? '').includes('©'), 'and the copyright sign');
});

check('the comment says what the AI did and what the person did', () => {
  const comment = infoTagsOf(parseRiff(encoded(remix())).chunks).get('ICMT') ?? '';
  assert(comment.includes('사람 작업'), 'the human work is named');
  assert(comment.includes('AI 마스터링'), 'the AI mastering is named');
  assert(comment.includes('AI 음원 분리'), 'and the separation');
  assert(comment.includes('2차 창작'), 'and that it is a derivative');
  assert(comment.includes('You Make Me Wanna'), 'naming the source');
  assert(comment.includes(BASIS_LABELS.licensed), 'and the right it was used under');
});

check('an original work says so, rather than staying silent', () => {
  // Silence reads as "nobody filled it in".  A track that IS original should
  // say it, because that is the answer a reviewer is looking for.
  let p = emptyProvenance('Mine', 'theblank');
  p = withAiStep(p, { kind: 'mastering', detail: 'YouTube Safe · −14 LUFS' });
  const comment = infoTagsOf(parseRiff(encoded(p)).chunks).get('ICMT') ?? '';
  assert(comment.includes('원저작물'), `says it is original: ${comment}`);
  assert(!isDerivative(p), 'and the model agrees');
});

check('no AI is stated, not left blank', () => {
  const p = emptyProvenance('Handmade', 'theblank');
  assert(!usedAi(p), 'nothing ran');
  assert(describeProvenance(p).includes('AI 작업: 없음'), 'and the file says so out loud');
});

// ── The professional chunk ───────────────────────────────────────────────────

check('bext is exactly the size the standard says, with room for history', () => {
  const bext = parseRiff(encoded(remix())).chunks.find((c) => c.id === 'bext');
  assert(bext !== undefined, 'the chunk is written');
  assert(bext!.body.length > 602, `602 fixed bytes plus CodingHistory — got ${bext!.body.length}`);
  const view = new DataView(bext!.body.buffer, bext!.body.byteOffset, bext!.body.byteLength);
  assert(view.getUint16(346, true) === 2, 'declares bext version 2');
  const history = new TextDecoder().decode(bext!.body.subarray(602));
  assert(history.includes('Louver Mastering AI'), 'the history names the app');
  assert(history.includes('원곡'), 'and the source work');
  assert(history.split('\r\n').length > 2, 'as CRLF lines, which is the format');
});

check('bext does not claim a loudness measurement nobody made', () => {
  // 0x7FFF is the spec's "not measured".  A zero here reads as 0.0 LUFS, and
  // a mastering engineer believes the file.
  const bext = parseRiff(encoded(remix())).chunks.find((c) => c.id === 'bext')!;
  const view = new DataView(bext.body.buffer, bext.body.byteOffset, bext.body.byteLength);
  for (let off = 412; off <= 420; off += 2) {
    assert(view.getInt16(off, true) === 0x7fff,
      `loudness field at ${off} must say "not measured", got ${view.getInt16(off, true)}`);
  }
});

check('the exact record is readable back without guessing', () => {
  const loui = parseRiff(encoded(remix())).chunks.find((c) => c.id === 'LOUI');
  assert(loui !== undefined, 'the JSON record is written');
  const record = JSON.parse(new TextDecoder().decode(loui!.body)) as {
    schema: string; derivative: boolean;
    aiWork: { kind: string }[]; derivedFrom: { basis: string; isrc?: string }[];
  };
  assert(record.schema === 'loui.provenance/1', `schema: ${record.schema}`);
  assert(record.derivative === true, 'it knows it is a derivative');
  assert(record.aiWork.map((s) => s.kind).sort().join(',') === 'mastering,separation',
    'both AI steps are there');
  assert(record.derivedFrom[0]!.basis === 'licensed', 'with the basis');
  assert(record.derivedFrom[0]!.isrc === 'KRA382600001', 'and the ISRC');
});

// ── Refusing to lie ──────────────────────────────────────────────────────────

check('the same AI step recorded twice is still one fact', () => {
  let p = emptyProvenance('T', 'A');
  p = withAiStep(p, { kind: 'mastering', detail: 'AI Pop' });
  p = withAiStep(p, { kind: 'mastering', detail: 'AI Pop' });
  assert(p.aiWork.length === 1, `mastering twice is one step, got ${p.aiWork.length}`);
  // A DIFFERENT setting is a different fact and must survive.
  p = withAiStep(p, { kind: 'mastering', detail: 'KPOP Loud' });
  assert(p.aiWork.length === 2, 'a different chain is a different step');
});

check('an unestablished right is a problem, not a blank', () => {
  let p = emptyProvenance('Remix', 'me');
  p = withSource(p, { title: 'Some Song', artist: 'Someone', basis: 'unknown' });
  const problem = provenanceProblem(p);
  assert(problem !== null && problem.includes('미확인'),
    `an unknown basis has to be raised — got ${problem}`);
  // And it still writes, saying "미확인" rather than nothing.
  const comment = infoTagsOf(parseRiff(encoded(p)).chunks).get('ICMT') ?? '';
  assert(comment.includes(BASIS_LABELS.unknown), 'the file says the right is unestablished');
});

check('a nameless track is caught before it is sent anywhere', () => {
  assert(provenanceProblem(emptyProvenance('', 'someone')) !== null, 'no title');
  assert(provenanceProblem(emptyProvenance('song', '')) !== null, 'no artist');
  assert(provenanceProblem(emptyProvenance('song', 'someone')) === null, 'both present is fine');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Provenance: what made the recording, written into it ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
