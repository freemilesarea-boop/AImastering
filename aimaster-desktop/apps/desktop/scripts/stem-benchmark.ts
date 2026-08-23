// Measure the separator against real stems — on YOUR machine, with YOUR music.
//
//   pnpm --filter @aimaster/desktop benchmark:stems "~/Downloads/LOOK GOOD Stems"
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Every number the separator reports about itself so far comes from a mix this
// repository synthesised: four parts built to carry exactly the cues the
// separator looks for.  It is a fair test of whether the code does what it
// claims, and it is EASIER than real music in ways that are hard to enumerate —
// no reverb tails, no bus compression gluing the parts together, no two
// instruments doubling the same line.
//
// A folder of real stems is the ground truth that fixes that.  Sum them and you
// have the mix; separate the mix and you can measure, per instrument, how much
// of it came back and how much of everything else came with it.
//
// ── Nothing leaves the machine ───────────────────────────────────────────────
//
// The audio is read, measured and dropped.  What comes out is a table of
// numbers.  That matters because a folder of stems is somebody's record, and
// "send me the files" is the wrong answer to "how good is it on real music".
//
// ── Filenames ────────────────────────────────────────────────────────────────
//
// Matched loosely against the Moises / Music.AI naming, which is what most
// separators and most session exports produce:
//
//   0 Lead Vocals.wav   1 Backing Vocals.wav   2 Drums.wav   3 Bass.wav
//   4 Guitar.wav        5 Keyboard.wav         6 Percussion.wav ...
//
// Anything this app cannot make on its own is folded into the stem that WILL
// hold it — a guitar belongs in 그 외, a shaker in 드럼 — so the comparison is
// against what the separator is actually trying to do rather than against a
// taxonomy it has never claimed to reach.

import fs from 'node:fs';
import path from 'node:path';

import {
  DETAILED_STEMS, STEM_KINDS, separate, stemLabel, type StemKind,
} from '../src/renderer/daw/audio/separate/separate.js';
import { classifyStemFile } from './stem-names.js';
import { readWav } from './wav-read.js';

// ── Measurement ──────────────────────────────────────────────────────────────

function siSdr(estimate: readonly Float32Array[], truth: readonly Float32Array[]): number {
  let dot = 0;
  let tt = 0;
  for (let c = 0; c < truth.length; c++) {
    const e = estimate[c] ?? estimate[0]!;
    const t = truth[c]!;
    for (let i = 0; i < t.length; i++) { dot += (e[i] ?? 0) * (t[i] ?? 0); tt += (t[i] ?? 0) ** 2; }
  }
  if (tt <= 0) return Number.NaN;
  const scale = dot / tt;
  let signal = 0;
  let error = 0;
  for (let c = 0; c < truth.length; c++) {
    const e = estimate[c] ?? estimate[0]!;
    const t = truth[c]!;
    for (let i = 0; i < t.length; i++) {
      const s = scale * (t[i] ?? 0);
      signal += s * s;
      error += ((e[i] ?? 0) - s) ** 2;
    }
  }
  return 10 * Math.log10(signal / Math.max(error, 1e-30));
}

function share(estimate: readonly Float32Array[], truth: readonly Float32Array[]): number {
  let dot = 0;
  let tt = 0;
  for (let c = 0; c < truth.length; c++) {
    const e = estimate[c] ?? estimate[0]!;
    const t = truth[c]!;
    for (let i = 0; i < t.length; i++) { dot += (e[i] ?? 0) * (t[i] ?? 0); tt += (t[i] ?? 0) ** 2; }
  }
  return tt > 0 ? (100 * dot) / tt : 0;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const secondsArg = args.find((a) => a.startsWith('--seconds='));
const fromArg = args.find((a) => a.startsWith('--from='));
const detailed = args.includes('--detailed');
const diagnose = args.includes('--diagnose');
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 60;
const fromSec = fromArg ? Number(fromArg.split('=')[1]) : 30;

if (!folder) {
  console.log(`스템 폴더로 분리기를 채점합니다.  오디오는 이 기계를 떠나지 않습니다.

  tsx scripts/stem-benchmark.ts <스템 폴더> [옵션]

  --seconds=60   잴 길이 (기본 60초).  0 이면 전체
  --from=30      시작 지점 (기본 30초 — 인트로는 대표성이 없습니다)
  --detailed     리드/코러스 · 킥/나머지까지 나눠서 잽니다
  --diagnose     어느 주파수 대역에서 새는지까지 찍습니다 (붙여넣기용)

파일 이름은 Moises 식 이름(0 Lead Vocals.wav, 2 Drums.wav …)에 맞춰
느슨하게 읽습니다.  이 앱이 못 만드는 스템(기타 · 건반 · 스트링 …)은
그것을 담게 되어 있는 스템에 합쳐서 비교합니다.`);
  process.exit(1);
}

const dir = folder.replace(/^~/, process.env['HOME'] ?? '~');
if (!fs.existsSync(dir)) { console.error(`폴더가 없습니다: ${dir}`); process.exit(1); }

const files = fs.readdirSync(dir).filter((f) => /\.wave?$/i.test(f)).sort();
if (files.length === 0) { console.error(`${dir} 에 WAV 가 없습니다`); process.exit(1); }

console.log(`${dir}\n${files.length}개 WAV\n`);

const truth = new Map<StemKind, Float32Array[]>();
const notes = new Set<string>();
const skipped: string[] = [];
let sampleRate = 0;
let length = 0;
let channelCount = 2;

for (const file of files) {
  const target = classifyStemFile(file);
  if (!target) { skipped.push(file); continue; }
  const wav = readWav(path.join(dir, file));
  if (sampleRate === 0) {
    sampleRate = wav.sampleRate;
    channelCount = Math.min(2, wav.channels.length);
  } else if (wav.sampleRate !== sampleRate) {
    console.error(`${file}: 샘플레이트가 ${wav.sampleRate} 인데 나머지는 ${sampleRate} 입니다`);
    process.exit(1);
  }
  length = Math.max(length, wav.length);
  if (target.note) notes.add(target.note);

  const existing = truth.get(target.into)
    ?? Array.from({ length: channelCount }, () => new Float32Array(0));
  const grown = existing.map((ch) => {
    if (ch.length >= wav.length) return ch;
    const next = new Float32Array(wav.length);
    next.set(ch);
    return next;
  });
  for (let c = 0; c < channelCount; c++) {
    const src = wav.channels[c] ?? wav.channels[0]!;
    const dst = grown[c]!;
    for (let i = 0; i < wav.length; i++) dst[i] = (dst[i] ?? 0) + (src[i] ?? 0);
  }
  truth.set(target.into, grown);
  console.log(`  ${file.padEnd(28)} → ${stemLabel(target.into)}`);
}
if (skipped.length > 0) console.log(`  건너뜀: ${skipped.join(', ')}`);
for (const note of notes) console.log(`  ※ ${note}`);

// Trim to the window being measured.
const start = Math.min(length, Math.round(fromSec * sampleRate));
const stop = seconds > 0 ? Math.min(length, start + Math.round(seconds * sampleRate)) : length;
if (stop <= start) { console.error('잴 구간이 비어 있습니다 — --from 을 줄이세요'); process.exit(1); }
const window = stop - start;

const cut = (chs: Float32Array[]): Float32Array[] =>
  chs.map((ch) => {
    const out = new Float32Array(window);
    for (let i = 0; i < window; i++) out[i] = ch[start + i] ?? 0;
    return out;
  });

const parts = new Map<StemKind, Float32Array[]>();
for (const [kind, chs] of truth) parts.set(kind, cut(chs));

// The mix is the sum of the stems — the same convention MUSDB uses, and the
// only one available when the master is not in the folder.
const mix = Array.from({ length: channelCount }, () => new Float32Array(window));
for (const chs of parts.values()) {
  for (let c = 0; c < channelCount; c++) {
    for (let i = 0; i < window; i++) mix[c]![i]! += chs[c]![i] ?? 0;
  }
}
let peak = 0;
for (const ch of mix) for (const v of ch) peak = Math.max(peak, Math.abs(v));

console.log(`\n${(window / sampleRate).toFixed(0)}초 (${fromSec}초부터) · ${sampleRate} Hz · `
  + `${channelCount === 1 ? '모노' : '스테레오'} · 합친 믹스 피크 ${peak.toFixed(2)}\n`);

// Only split as deep as the folder can score.
//
// A folder with one "Drums.wav" cannot tell a kick stem from the rest of the
// kit, and asking for the split anyway scores 나머지 드럼 against the whole
// kit INCLUDING the kick that correctly went to the other stem — measured, it
// reported −1.3 dB for a stem that had done nothing wrong.  A family is split
// only when both of its children have ground truth of their own.
const FAMILIES: ReadonlyArray<{ parent: StemKind; children: readonly StemKind[] }> = [
  { parent: 'vocals', children: ['lead', 'backing'] },
  { parent: 'drums', children: ['kick', 'kit'] },
];
let wanted: StemKind[] = [...STEM_KINDS];
if (detailed) {
  wanted = [];
  for (const kind of STEM_KINDS) {
    const family = FAMILIES.find((f) => f.parent === kind);
    if (family && family.children.every((c) => parts.has(c))) wanted.push(...family.children);
    else wanted.push(kind);
  }
  const folded = FAMILIES.filter((f) => wanted.includes(f.parent));
  if (folded.length > 0) {
    console.log(`  ※ ${folded.map((f) => stemLabel(f.parent)).join(' · ')} 은(는) 나누지 않고 잽니다 —`
      + ` ${folded.flatMap((f) => f.children).map(stemLabel).join(' · ')} 의 정답 파일이 폴더에 없습니다\n`);
  }
}

const began = Date.now();
const report = separate(mix, sampleRate, { wanted }, (f, what) => {
  // Pad to a fixed width and rewind, so a shorter label does not leave the
  // tail of a longer one behind it.
  process.stdout.write(`\r  ${`${(f * 100).toFixed(0)}% ${what}`.padEnd(36)}`);
});
process.stdout.write(`\r${' '.repeat(40)}\r`);
console.log(`분리 ${((Date.now() - began) / 1000).toFixed(1)}초 `
  + `(${(window / sampleRate / ((Date.now() - began) / 1000)).toFixed(1)}배속) · `
  + `합 − 원본 ${report.reconstructionDb.toFixed(0)} dB\n`);

// Roll the truth up to whatever level is being measured.
const roll = (kind: StemKind): Float32Array[] | null => {
  if (parts.has(kind)) return parts.get(kind)!;
  const children: Partial<Record<StemKind, StemKind[]>> = {
    vocals: ['lead', 'backing'], drums: ['kick', 'kit'],
  };
  const kids = children[kind];
  if (!kids) return null;
  const present = kids.filter((k) => parts.has(k));
  if (present.length === 0) return null;
  const out = Array.from({ length: channelCount }, () => new Float32Array(window));
  for (const kid of present) {
    const chs = parts.get(kid)!;
    for (let c = 0; c < channelCount; c++) for (let i = 0; i < window; i++) out[c]![i]! += chs[c]![i] ?? 0;
  }
  return out;
};

const rows = report.stems.map((s) => s.kind).filter((k) => roll(k) !== null);
const width = Math.max(...rows.map((k) => stemLabel(k).length)) + 2;

console.log('  스템          SI-SDR    회수    가장 많이 섞인 것');
console.log('  ' + '─'.repeat(52));
for (const kind of rows) {
  const stem = report.stems.find((s) => s.kind === kind)!;
  const own = roll(kind)!;
  const sdr = siSdr(stem.channels, own);
  const kept = share(stem.channels, own);
  const others = rows.filter((k) => k !== kind)
    .map((k) => ({ k, v: share(stem.channels, roll(k)!) }))
    .sort((a, b) => b.v - a.v);
  const worst = others[0];
  console.log(`  ${stemLabel(kind).padEnd(width)}`
    + `${sdr.toFixed(1).padStart(7)} dB`
    + `${kept.toFixed(0).padStart(7)} %`
    + `   ${worst ? `${stemLabel(worst.k)} ${worst.v.toFixed(0)} %` : ''}`);
}

const sdrs = rows.map((k) => siSdr(report.stems.find((s) => s.kind === k)!.channels, roll(k)!))
  .filter((v) => Number.isFinite(v));
const mean = sdrs.reduce((a, b) => a + b, 0) / Math.max(1, sdrs.length);
console.log('  ' + '─'.repeat(52));
console.log(`  평균 SI-SDR ${mean.toFixed(2)} dB`);
console.log(`\n비교용: MUSDB18-HQ 에서 학습된 최신 모델이 9.8–12 dB, 믹스를 그대로 내면 약 −5 dB.`);
console.log('이 숫자는 곡 하나짜리라 그 벤치마크와 직접 비교할 수는 없습니다 — 우리 자신의 변화를 재는 기준선입니다.');
for (const note of report.notes) console.log(`· ${note}`);

// ── Where it goes wrong, by frequency ────────────────────────────────────────
import {
  BAND_NAMES, bandShare, energyByBand, leakByBand,
} from './band-leak.js';

if (diagnose) {
  console.log('\n대역별 에너지 분포 (%) — 각 줄의 합이 100');
  console.log('              ' + BAND_NAMES.map((n) => n.padStart(5)).join(''));
  for (const kind of rows) {
    console.log(`정답 ${stemLabel(kind).padEnd(9)}` + bandShare(energyByBand(roll(kind)!, sampleRate)));
  }
  for (const kind of rows) {
    const stem = report.stems.find((s) => s.kind === kind)!;
    console.log(`스템 ${stemLabel(kind).padEnd(9)}` + bandShare(energyByBand(stem.channels, sampleRate)));
  }

  console.log('\n대역 안에서 정답의 몇 %가 그 스템에 들어갔나  (· = 그 대역에 정답이 거의 없음)');
  console.log('              ' + BAND_NAMES.map((n) => n.padStart(5)).join(''));
  for (const from of rows) {
    for (const into of rows) {
      const stem = report.stems.find((s) => s.kind === into)!;
      const overall = share(stem.channels, roll(from)!);
      // Its own stem, or a leak big enough to be worth chasing.
      if (from !== into && overall < 12) continue;
      const perBand = leakByBand(stem.channels, roll(from)!, sampleRate);
      const mark = from === into ? ' ' : '!';
      console.log(`${mark}${stemLabel(from).padEnd(6)}→${stemLabel(into).padEnd(6)}`
        + perBand.map((v) => (v === null ? '·' : Math.round(Math.min(999, v)).toString()).padStart(5)).join('')
        + `  (전체 ${overall.toFixed(0)}%)`);
    }
  }
  console.log('\n※ 이 두 표를 그대로 붙여주세요 — 어느 대역이 문제인지가 여기 나옵니다.');
}
