// stem-role-selftest — the classifier is checked against real audio.
//
// Two halves, because the classifier has two halves:
//
//   • The NAME rules are pure string work and are checked as a table,
//     including the orderings that carry real cases ("Bass Drum" is a kick,
//     "Bass Guitar" is a bass, "Back Vox" is not a lead vocal).
//   • The SPECTRAL rules are checked by synthesising a stem with a known
//     character, writing it to a WAV, and putting it through the SAME
//     `profileSong` the app runs. A classifier tested against hand-written
//     profile objects only proves the rules are self-consistent; it says
//     nothing about whether a real kick measures like the rules expect.
//
// Run:  pnpm --filter @aimaster/desktop test:stem-role

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profileSong, type SongProfile } from '../src/main/offline/song-profile.js';
import {
  classifyStem, roleFromName, roleFromSpectrum, stemFeatures,
  type StemRole,
} from '../src/main/offline/stem-role.js';

process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-stem-'));

function writeWav(name: string, left: Float32Array, right: Float32Array): string {
  const n = left.length;
  const bytes = n * 2 * 3;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 3, 28);
  buf.writeUInt16LE(6, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  let o = 44;
  const put = (v: number): void => {
    const s = Math.max(-1, Math.min(1, v));
    buf.writeIntLE(Math.round(s * 8_388_607), o, 3);
    o += 3;
  };
  for (let i = 0; i < n; i++) { put(left[i]!); put(right[i]!); }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

function makeNoise(): () => number {
  let s = 0x9e3779b9n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n) / 2 ** 30 - 1;
  };
}

const SECONDS = 10;
const N = SR * SECONDS;

/** A percussive low stem: 60 Hz hits every 0.5 s, fast decay. */
function kick(): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const phase = t % 0.5;
    // 45 ms decay — a hit, then near-silence. This is what makes the crest
    // factor high and separates a kick from a sustained sub.
    const env = Math.exp(-phase / 0.045);
    // Pitch envelope, as a real kick has: starts near 110 Hz, settles at 50.
    const hz = 50 + 60 * Math.exp(-phase / 0.02);
    l[i] = 0.7 * env * Math.sin(2 * Math.PI * hz * phase);
  }
  return { left: l, right: l.slice() };
}

/** A sustained low stem: continuous 55 Hz, no transients. */
function subBass(): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    l[i] = 0.5 * (Math.sin(2 * Math.PI * 55 * t) + 0.35 * Math.sin(2 * Math.PI * 110 * t));
  }
  return { left: l, right: l.slice() };
}

/** Hats: short bursts of high noise every 0.25 s. */
function hats(): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  const nz = makeNoise();
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = Math.exp(-(t % 0.25) / 0.012);
    l[i] = 0.5 * env * nz();
    r[i] = l[i]!;
  }
  // Two passes of a first-difference high-pass. Crude, but it is steep
  // enough to put the bulk of the energy well above 5 kHz, which is the
  // only property this stem needs to have.
  for (let pass = 0; pass < 2; pass++) {
    let prevL = 0, prevR = 0;
    for (let i = 0; i < N; i++) {
      const xl = l[i]!, xr = r[i]!;
      l[i] = xl - prevL; prevL = xl;
      r[i] = xr - prevR; prevR = xr;
    }
  }
  return { left: l, right: r };
}

/** A mid harmonic stem: voice-like partials, narrow, sustained with vibrato. */
function vocalish(): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(N);
  const partials: Array<[number, number]> = [
    [220, 1], [440, 0.7], [880, 0.5], [1760, 0.3], [3200, 0.15],
  ];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Phrasing: sings for 1.5 s, breathes for 0.4 s.
    const cycle = t % 1.9;
    const env = cycle < 1.5 ? Math.min(1, cycle / 0.08) * Math.min(1, (1.5 - cycle) / 0.1) : 0;
    let v = 0;
    for (const [hz, a] of partials) v += a * Math.sin(2 * Math.PI * hz * t);
    l[i] = 0.25 * env * v;
  }
  return { left: l, right: l.slice() };
}

/** A wide sustained pad — mid centroid, low crest, real side energy. */
function pad(): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  const partials: Array<[number, number]> = [
    [300, 1], [450, 0.8], [600, 0.6], [900, 0.5], [1350, 0.35], [2400, 0.2],
  ];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let a = 0, b = 0;
    for (const [hz, amp] of partials) {
      a += amp * Math.sin(2 * Math.PI * hz * t);
      // Detuned copy on the other side — this is what makes it wide.
      b += amp * Math.sin(2 * Math.PI * hz * 1.004 * t + 1.1);
    }
    l[i] = 0.18 * a;
    r[i] = 0.18 * b;
  }
  return { left: l, right: r };
}

function silence(): { left: Float32Array; right: Float32Array } {
  return { left: new Float32Array(N), right: new Float32Array(N) };
}

// ── 1. Name rules ───────────────────────────────────────────────────────────

console.log('\n=== NAMES ===\n');

const NAME_CASES: Array<[string, StemRole | null]> = [
  ['Kick.wav', 'kick'],
  ['01_Kick In.wav', 'kick'],
  ['BD_01.aif', 'kick'],
  ['Snare Top.wav', 'snare'],
  ['OH_Drums.wav', 'drums'],
  ['Hi-Hat.wav', 'drums'],
  ['Perc Loop.wav', 'drums'],
  ['Bass DI.wav', 'bass'],
  ['808.wav', 'bass'],
  ['Sub.wav', 'bass'],
  ['Lead Vox v3.wav', 'vocal'],
  ['Vocal.wav', 'vocal'],
  ['BGV Stack.wav', 'vocal-back'],
  ['Back Vocal 2.wav', 'vocal-back'],
  ['Adlib.wav', 'vocal-back'],
  ['Gtr L.wav', 'guitar'],
  ['Acoustic Guitar.wav', 'guitar'],
  ['Piano.wav', 'keys'],
  ['Synth Pad.wav', 'keys'],
  ['Strings.wav', 'keys'],
  ['FX Riser.wav', 'fx'],
  ['Ambience.wav', 'fx'],
  // Korean
  ['보컬.wav', 'vocal'],
  ['백보컬 1.wav', 'vocal-back'],
  ['킥.wav', 'kick'],
  ['베이스.wav', 'bass'],
  ['드럼버스.wav', 'drums'],
  ['피아노.wav', 'keys'],
  ['기타 L.wav', 'guitar'],
  // Nothing usable
  ['Audio 04.wav', null],
  ['bounce_final.wav', null],
  ['.wav', null],
];

for (const [name, want] of NAME_CASES) {
  const got = roleFromName(name);
  check(`"${name}"`, got === want, `${got ?? 'null'} (기대: ${want ?? 'null'})`);
}

console.log('\n=== NAME PRIORITY (the orderings that carry real cases) ===\n');

const PRIORITY: Array<[string, StemRole, string]> = [
  ['Bass Drum.wav',   'kick',       '"bass"가 들어가도 베이스가 아니라 킥'],
  ['Bass Guitar.wav', 'bass',       '"guitar"가 들어가도 기타가 아니라 베이스'],
  ['Back Vox.wav',    'vocal-back', '"vox"가 들어가도 리드가 아니라 백보컬'],
  ['Drum Bus.wav',    'drums',      '"bus"가 "bass"로 잘못 잡히지 않음'],
  ['Vocal Chops.wav', 'vocal',      '보컬이 먼저'],
];

for (const [name, want, why] of PRIORITY) {
  const got = roleFromName(name);
  check(`"${name}" → ${want}`, got === want, `${got ?? 'null'} — ${why}`);
}

async function main(): Promise<void> {
  // ── 2. Spectral rules, on real measured audio ───────────────────────────────

  console.log('\n=== SPECTRUM (measured through profileSong) ===\n');

  interface Measured { profile: SongProfile; label: string }
  const measured: Record<string, Measured> = {};

  async function measure(label: string, file: string, buf: { left: Float32Array; right: Float32Array }): Promise<void> {
    const p = writeWav(file, buf.left, buf.right);
    measured[label] = { profile: await profileSong(p), label };
  }

  await measure('kick',    'k.wav', kick());
  await measure('sub',     's.wav', subBass());
  await measure('hats',    'h.wav', hats());
  await measure('vocal',   'v.wav', vocalish());
  await measure('pad',     'p.wav', pad());
  await measure('silence', 'z.wav', silence());

  // Print what was actually measured — a threshold argued from numbers that
  // are not shown is a threshold nobody can check.
  for (const k of Object.keys(measured)) {
    const f = stemFeatures(measured[k]!.profile);
    console.log(
      `      ${k.padEnd(8)} centroid ${Math.round(f.centroidHz).toString().padStart(6)} Hz  ` +
      `low ${(f.lowFrac * 100).toFixed(0).padStart(3)}%  high ${(f.highFrac * 100).toFixed(0).padStart(3)}%  ` +
      `crest ${f.crestDb.toFixed(1).padStart(5)} dB  width ${f.widthPct.toFixed(0).padStart(3)}%`,
    );
  }
  console.log('');

  {
    const f = stemFeatures(measured['kick']!.profile);
    const g = stemFeatures(measured['sub']!.profile);
    check(
      'a percussive low stem and a sustained low stem both read as low',
      f.lowFrac >= 0.6 && g.lowFrac >= 0.6,
      `킥 ${(f.lowFrac * 100).toFixed(0)}%, 서브 ${(g.lowFrac * 100).toFixed(0)}% — 둘 다 150 Hz 아래`,
    );
    check(
      'and the crest factor is what separates them',
      f.crestDb > g.crestDb + 6,
      `킥 ${f.crestDb.toFixed(1)} dB vs 서브 ${g.crestDb.toFixed(1)} dB — 이 차이가 없으면 둘을 구별할 근거가 없음`,
    );
    check(
      'so the spectrum alone calls one a kick and the other a bass',
      roleFromSpectrum(f).role === 'kick' && roleFromSpectrum(g).role === 'bass',
      `${roleFromSpectrum(f).role} / ${roleFromSpectrum(g).role}`,
    );
  }

  {
    const f = stemFeatures(measured['hats']!.profile);
    check(
      'a hat stem reads as high-frequency and percussive',
      roleFromSpectrum(f).role === 'drums',
      `high ${(f.highFrac * 100).toFixed(0)}%, crest ${f.crestDb.toFixed(1)} dB → ${roleFromSpectrum(f).role}`,
    );
  }

  {
    const v = stemFeatures(measured['vocal']!.profile);
    const p = stemFeatures(measured['pad']!.profile);
    check(
      'mid harmonic stems land in the midrange',
      v.centroidHz >= 200 && v.centroidHz <= 4_000 && p.centroidHz >= 200 && p.centroidHz <= 4_000,
      `보컬 ${Math.round(v.centroidHz)} Hz, 패드 ${Math.round(p.centroidHz)} Hz`,
    );
    check(
      'and the spectrum refuses to name them',
      roleFromSpectrum(v).role === 'mid' && roleFromSpectrum(p).role === 'mid',
      '보컬/기타/건반은 스펙트럼만으로 구별되지 않음 — mid 로 남기고 이름에 맡기는 것이 정직한 결과',
    );
    check(
      'a wide stem measures wider than a mono one',
      p.widthPct > v.widthPct + 10,
      `패드 ${p.widthPct.toFixed(0)}% vs 보컬 ${v.widthPct.toFixed(0)}%`,
    );
  }

  // ── 3. Name + spectrum together ─────────────────────────────────────────────

  console.log('\n=== NAME + SPECTRUM ===\n');

  {
    const c = classifyStem('Kick In.wav', measured['kick']!.profile);
    check(
      'agreement raises confidence and records both sources',
      c.role === 'kick' && c.basis === 'name+spectrum' && c.confidence > 0.9 && !c.warning,
      `${c.role}, ${c.basis}, confidence ${c.confidence}`,
    );
  }

  {
    // The name says vocal, the audio is a kick. This is the case the whole
    // cross-check exists for.
    const c = classifyStem('Lead Vox.wav', measured['kick']!.profile);
    check(
      'a name that contradicts the measurement keeps the name but warns',
      c.role === 'vocal' && c.basis === 'name' && c.warning !== undefined && c.confidence <= 0.5,
      `${c.role}, confidence ${c.confidence}, 경고: ${c.warning ? '있음' : '없음'}`,
    );
  }

  {
    const c = classifyStem('Audio 04.wav', measured['sub']!.profile);
    check(
      'no usable name falls back to the spectrum and says so',
      c.role === 'bass' && c.basis === 'spectrum',
      `${c.role}, ${c.basis} — ${c.why}`,
    );
  }

  {
    const c = classifyStem('Audio 07.wav', measured['vocal']!.profile);
    check(
      'an unnamed mid stem is left as `mid`, not guessed at',
      c.role === 'mid' && c.confidence < 0.5,
      `${c.role}, confidence ${c.confidence} — 낮은 확신도가 "사용자에게 물어보라"는 신호`,
    );
  }

  {
    const c = classifyStem('Piano.wav', measured['vocal']!.profile);
    check(
      'a named mid stem is not warned about — `mid` agrees with any mid role',
      c.role === 'keys' && c.warning === undefined,
      `${c.role}, 경고 없음 — 스펙트럼이 구별 못 하는 걸 불일치라고 부르면 안 됨`,
    );
  }

  // ── 4. Degenerate input ─────────────────────────────────────────────────────

  console.log('\n=== SAFETY ===\n');

  {
    const c = classifyStem('Audio 01.wav', measured['silence']!.profile);
    const f = c.features;
    const finite = [f.centroidHz, f.lowFrac, f.highFrac, f.crestDb, f.widthPct].every(Number.isFinite);
    check(
      'a silent stem is not filed as a bass',
      finite && c.role === 'other',
      `${c.role}, centroid ${Math.round(f.centroidHz)} Hz, ${f.integratedLufs.toFixed(1)} LUFS — ` +
      '무음의 노이즈 플로어는 저역으로 기울어 있어 서브 베이스와 같은 지문을 남긴다',
    );
  }

  {
    const c = classifyStem('Kick.wav', measured['silence']!.profile);
    check(
      'a named but empty stem keeps its name and is flagged',
      c.role === 'kick' && c.warning !== undefined,
      `${c.role} — ${c.warning ?? '경고 없음'}`,
    );
  }

  {
    const c = classifyStem('/Users/me/Session/Stems/킥 01.wav', measured['kick']!.profile);
    check(
      'a full path is read by its basename',
      c.role === 'kick',
      `${c.role} — 경로에 다른 단어가 있어도 파일명만 본다`,
    );
  }

  {
    const empty: SongProfile = { ...measured['silence']!.profile, curveDb: [] };
    const f = stemFeatures(empty);
    check(
      'an empty curve does not divide by zero',
      Number.isFinite(f.centroidHz) && f.centroidHz === 0,
      `centroid ${f.centroidHz}`,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);

}

main().catch((e) => { console.error(e); process.exit(1); });
