// Measure the chord detector against real records — on YOUR machine, with
// YOUR music.
//
//   pnpm --filter @aimaster/desktop benchmark:chords "~/Music/annotated"
//   pnpm --filter @aimaster/desktop benchmark:chords "~/Music/song.wav"
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Every accuracy number stages A to C printed came from audio this repository
// rendered itself, out of instruments it wrote, playing progressions it chose.
// Those numbers are real and they measure the code against the cases it was
// built for.  They cannot tell you how it does on a record, and no amount of
// making the synthetic fixtures harder turns them into one: real music has
// reverb tails smearing one chord into the next, a guitar doubling the vocal a
// third above, and a producer leaving a suspended fourth hanging for three
// bars because it sounded good.
//
// ── Two modes, because annotations are the scarce thing ──────────────────────
//
// SCORED.  A folder with `song.wav` next to `song.lab` — the reference format
// the public sets use (Isophonics, McGill Billboard, RWC).  Point this at a
// corpus somebody else annotated by hand and you get numbers.
//
// REPORT.  Audio with no annotation beside it: the chart it found is printed,
// with the bars it is least sure about marked, and a `.lab` is written next to
// nothing — the text goes to the terminal.  That is not a score, and it is not
// pretending to be; it is the thing you read while listening, which is how you
// find out whether a detector is any good on music nobody has annotated.
//
// ── Nothing leaves the machine ───────────────────────────────────────────────
//
// The audio is read, measured and dropped.  What comes out is a table of
// numbers and a chord chart.  A folder of records is somebody's music, and
// "send me the files" is the wrong answer to "how good is it on real music".

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { detectChordsFromAudio } from '../src/renderer/daw/audio/chroma/chord-detect-audio.js';
import {
  formatLab, parseLab, scoreChords, segmentsToSpans,
  SCORE_TIERS, type ChordScore, type LabSpan,
} from '../src/renderer/daw/audio/chroma/chord-lab.js';
import { detectTransientMarks } from '../src/renderer/daw/edit/transient.js';
import { detectTempo } from '../src/renderer/daw/model/tempo-detect.js';
import { formatChord } from '../src/renderer/daw/model/chords.js';
import { readWav } from './wav-read.js';
import { describeGrid, type GridReport } from './lib/grid-label.js';

// ── Input ────────────────────────────────────────────────────────────────────

const raw = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const writeLab = process.argv.includes('--write-lab');
const target = expandHome(raw[0] ?? '');

if (!target) {
  console.error('사용법: pnpm --filter @aimaster/desktop benchmark:chords "<폴더 또는 .wav>"');
  console.error('  .wav 옆에 같은 이름의 .lab 이 있으면 점수를 냅니다. 없으면 찾은 코드를 인쇄합니다.');
  console.error('  --write-lab  결과를 .lab 형식으로 터미널에 출력합니다.');
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`${target} 이(가) 없습니다.`);
  process.exit(2);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((f) => /\.wav$/i.test(f)).sort().map((f) => path.join(target, f))
  : [target];

if (files.length === 0) {
  console.error(`${target} 에 .wav 파일이 없습니다.`);
  process.exit(2);
}

// ── One file ─────────────────────────────────────────────────────────────────

interface Outcome {
  name: string;
  seconds: number;
  elapsedMs: number;
  bpm: number;
  tempoConfidence: number;
  /**
   * Whether the beat grid actually CAME from that tempo.
   *
   * Not the same question as "did the tempo detector return a number".  Below
   * the trust threshold the chord detector lays a fixed window instead, and a
   * report that prints the rejected BPM next to the results is telling the
   * reader the chart is on a grid it is not on.
   */
  gridFromTempo: boolean;
  gridBpm: number;
  chords: number;
  unsure: number;
  tuningCents: number;
  estimate: LabSpan[];
  score: ChordScore | null;
  /** Problems in the reference file, reported rather than swallowed. */
  problems: string[];
}

function run(file: string): Outcome {
  const wav = readWav(file);
  const seconds = wav.length / wav.sampleRate;

  // Mono, because the detector takes mono and summing is the caller's job.
  const mono = new Float32Array(wav.length);
  for (const channel of wav.channels) {
    for (let i = 0; i < wav.length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / wav.channels.length;
  }

  // The tempo comes from the recording, not from a session — this is a file on
  // a disk and there is nobody to ask.  A low confidence is passed through
  // rather than overridden: the detector falls back to a fixed window and says
  // so, and hiding that here would hide the reason a chart is unreadable.
  const onsets = detectTransientMarks(mono, wav.sampleRate)
    .map((m) => ({ timeSec: m.timeSec, weight: Math.max(0.01, m.strength) }));
  const tempo = detectTempo(onsets);

  const started = Date.now();
  const readout = detectChordsFromAudio(mono, wav.sampleRate, {
    tempo: tempo.bpm > 0
      ? { bpm: tempo.bpm, phaseSec: tempo.phaseSec, confidence: tempo.confidence }
      : null,
  });
  const elapsedMs = Date.now() - started;

  const estimate = segmentsToSpans(readout.segments, seconds);

  const labPath = file.replace(/\.wav$/i, '.lab');
  let score: ChordScore | null = null;
  const problems: string[] = [];
  if (fs.existsSync(labPath)) {
    const parsed = parseLab(fs.readFileSync(labPath, 'utf8'));
    problems.push(...parsed.problems);
    if (parsed.spans.length > 0) score = scoreChords(parsed.spans, estimate);
  }

  return {
    name: path.basename(file),
    seconds,
    elapsedMs,
    bpm: tempo.bpm,
    tempoConfidence: tempo.confidence,
    gridFromTempo: readout.grid.fromTempo,
    gridBpm: readout.grid.bpm,
    chords: readout.segments.length,
    unsure: readout.unsure,
    tuningCents: readout.tuningCents,
    estimate,
    score,
    problems,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
  root: '근음', triad: '3화음', sevenths: '7화음', exact: '전체',
};

/** An outcome as the grid reporter sees it. */
function gridOf(o: Outcome): GridReport {
  return {
    detectedBpm: o.bpm,
    detectedConfidence: o.tempoConfidence,
    fromTempo: o.gridFromTempo,
    gridBpm: o.gridBpm,
  };
}

const outcomes: Outcome[] = [];
for (const file of files) {
  try {
    outcomes.push(run(file));
  } catch (err) {
    console.error(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (outcomes.length === 0) process.exit(1);

const scored = outcomes.filter((o) => o.score !== null);

console.log('');
if (scored.length > 0) {
  console.log('정답과 비교 (구간 길이 가중, %)');
  const width = Math.max(20, ...scored.map((o) => o.name.length));
  console.log('  ' + '곡'.padEnd(width) + SCORE_TIERS.map((t) => TIER_LABEL[t]!.padStart(7)).join('')
    + '   경계오차   코드수  그리드');
  for (const o of scored) {
    const s = o.score!;
    console.log('  ' + o.name.padEnd(width)
      + SCORE_TIERS.map((t) => (s.scores[t] * 100).toFixed(1).padStart(7)).join('')
      + `${s.medianBoundaryErrorSec.toFixed(2).padStart(9)}s`
      + `${String(s.estimateChanges).padStart(6)}/${s.referenceChanges}`
      + `  ${describeGrid(gridOf(o))}`);
  }
  if (scored.length > 1) {
    console.log('  ' + '─'.repeat(width + 28 + 15));
    // Weighted by scored SECONDS, not by song: a two-minute interlude and a
    // six-minute epic are not one vote each.
    const total = scored.reduce((a, o) => a + o.score!.scoredSec, 0);
    const means = SCORE_TIERS.map((t) =>
      scored.reduce((a, o) => a + o.score!.scores[t] * o.score!.scoredSec, 0) / Math.max(1e-9, total));
    console.log('  ' + '전체 (길이 가중)'.padEnd(width)
      + means.map((v) => (v * 100).toFixed(1).padStart(7)).join(''));
  }
  const skipped = scored.reduce((a, o) => a + o.score!.skippedSec, 0);
  if (skipped > 1) console.log(`  ※ X 로 표시된 ${skipped.toFixed(0)}초는 점수에서 빠졌습니다.`);
  console.log('');
  console.log('※ 이 네 숫자의 정의는 chord-lab.ts 에 적혀 있습니다. MIREX 과제와 같은 취지지만');
  console.log('  같은 구현이 아니라서, 우리 자신의 변화를 재는 데는 쓸 수 있고 논문 숫자와');
  console.log('  직접 비교할 수는 없습니다.');
}

const unscored = outcomes.filter((o) => o.score === null);
if (unscored.length > 0) {
  if (scored.length > 0) console.log('');
  console.log(`정답 파일이 없는 ${unscored.length}곡 — 찾은 코드를 인쇄합니다 (점수 아님)`);
  for (const o of unscored) {
    console.log('');
    console.log(`  ${o.name}  ${o.seconds.toFixed(0)}초  ${describeGrid(gridOf(o))}`
      + (Math.abs(o.tuningCents) >= 5 ? `  튜닝 ${o.tuningCents > 0 ? '+' : ''}${o.tuningCents.toFixed(0)}센트` : ''));
    const line: string[] = [];
    for (const span of o.estimate) {
      if (!span.chord) continue;
      const at = `${Math.floor(span.startSec / 60)}:${String(Math.floor(span.startSec % 60)).padStart(2, '0')}`;
      line.push(`${at} ${formatChord(span.chord)}`);
    }
    for (let i = 0; i < line.length; i += 6) console.log('    ' + line.slice(i, i + 6).join('   '));
    if (o.unsure > 0) console.log(`    (불확실 ${o.unsure}개 — 들으면서 확인할 곳)`);
  }
  console.log('');
  console.log('※ 정답 파일을 만들려면 .wav 옆에 같은 이름의 .lab 을 두세요:');
  console.log('    0.000000  1.672902  N');
  console.log('    1.672902  5.194149  C:maj');
  console.log('    5.194149  8.712000  A:min7');
}

for (const o of outcomes) {
  for (const problem of o.problems) console.log(`  ${o.name} 정답 파일: ${problem}`);
}

if (writeLab) {
  for (const o of outcomes) {
    console.log('');
    console.log(`# ${o.name}`);
    process.stdout.write(formatLab(o.estimate));
  }
}

console.log('');
const audioSec = outcomes.reduce((a, o) => a + o.seconds, 0);
const workMs = outcomes.reduce((a, o) => a + o.elapsedMs, 0);
console.log(`${outcomes.length}곡 · 오디오 ${audioSec.toFixed(0)}초 · 분석 ${(workMs / 1000).toFixed(1)}초`
  + ` (실시간의 ${(audioSec / Math.max(0.001, workMs / 1000)).toFixed(0)}배)`);
