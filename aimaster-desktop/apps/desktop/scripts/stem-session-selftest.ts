// stem-session-selftest — the wiring between the table, the store and the
// engine, checked end to end.
//
// The three pieces already have their own tests: the classifier knows what a
// stem is, the table says what to do about it, and the renderer sums the
// results. What none of those cover is whether the table's numbers actually
// REACH the engine. That gap has a specific and quiet failure mode: a preset
// names a module the translator does not handle, or writes a field the wire
// does not carry, and the chain is built, applied and does nothing. No error,
// no effect, and a "vocal chain" that is bit-identical to no chain at all.
//
// So the decisive tests here are measured: audio goes through
// `renderStemSession` carrying a role's real config, and the result is
// checked for the thing that role's chain is supposed to do.
//
// Run:  pnpm --filter @aimaster/desktop test:stem-session

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import { renderStemSession, audibleTracks } from '../src/main/offline/stem-render.js';
import { STEM_CHAIN, STEM_ROLES, type StemRole } from '../src/renderer/audio/presets/stem-defaults.js';
import {
  stemWireFor, untranslatedModules, touchesMasterOnly,
} from '../src/renderer/audio/presets/stem-chain-config.js';

process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-stemsession-'));

function writeWav(name: string, left: Float32Array, right: Float32Array): string {
  const n = left.length;
  const bytes = n * 2 * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2 * 4, 28);
  buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(left[i]!, o); o += 4;
    buf.writeFloatLE(right[i]!, o); o += 4;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

function baseConfig(): OfflineChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: true,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: true,
    limCeilingDbtp: 0, limLookaheadMs: 1, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
  };
}

function configFor(role: StemRole): OfflineChainConfig {
  return { ...baseConfig(), suiteConfig: stemWireFor(role) } as OfflineChainConfig;
}

function sine(n: number, hz: number, amp: number): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin(2 * Math.PI * hz * i / SR);
  return { left: l, right: l.slice() };
}

/** RMS over the back three quarters, so filter settling is not measured. */
function rms(buf: Float32Array): number {
  const start = Math.floor(buf.length * 0.25);
  let sum = 0;
  for (let i = start; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / (buf.length - start));
}

function db(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

async function main(): Promise<void> {
  // ── 1. Nothing in the table is silently dropped ──────────────────────────
  console.log('\n=== THE TABLE REACHES THE WIRE ===\n');

  {
    const bad: string[] = [];
    for (const role of STEM_ROLES) {
      const missing = untranslatedModules(STEM_CHAIN[role]);
      if (missing.length > 0) bad.push(`${role}: ${missing.join(', ')}`);
    }
    check(
      'every module a preset asks for is translated',
      bad.length === 0,
      bad.length === 0
        ? '번역되지 않는 모듈은 설정된 것처럼 보이면서 아무 일도 하지 않는다'
        : bad.join(' · '),
    );
  }

  {
    const bad = STEM_ROLES.filter((r) => touchesMasterOnly(stemWireFor(r)));
    check(
      'no built wire touches the limiter, loudness or dither',
      bad.length === 0,
      bad.length === 0 ? '테이블뿐 아니라 실제로 만들어진 설정에서도 확인' : bad.join(', '),
    );
  }

  {
    const wire = stemWireFor('vocal');
    check(
      'the vocal wire carries its EQ bands, its de-esser and its compressor',
      (wire.parametricEq?.bands?.length ?? 0) === 4 &&
      wire.deess !== undefined && wire.dynamics !== undefined,
      `밴드 ${wire.parametricEq?.bands?.length ?? 0}개, 디에서 ${wire.deess ? '있음' : '없음'}, 컴프 ${wire.dynamics ? '있음' : '없음'}`,
    );
    const hp = wire.parametricEq?.bands?.[0];
    check(
      'and the high-pass keeps its shape across the translation',
      hp?.kind === 'highPass' && hp.frequencyHz === 90 && hp.enabled === true,
      `${hp?.kind} @ ${hp?.frequencyHz} Hz`,
    );
  }

  {
    const wire = stemWireFor('mid');
    check(
      'an unidentified stem builds an almost empty chain',
      wire.dynamics === undefined && wire.deess === undefined &&
      (wire.parametricEq?.bands?.length ?? 0) === 1,
      `모듈 없음 + 서브소닉 하이패스 1개`,
    );
  }

  // ── 2. The wire reaches the audio ────────────────────────────────────────
  console.log('\n=== THE WIRE REACHES THE AUDIO ===\n');

  const N = SR;   // 1 second

  // Two levels, on purpose.
  //
  // QUIET (-34 dBFS) sits below every compressor threshold in the table, so
  // a level change measured with it is the EQ and nothing else. The first
  // version of this file used a hot tone and read the vocal compressor's 5
  // dB of gain reduction as a broken high-pass — the tone was the bug, not
  // the chain.
  //
  // LOUD is kept for the one claim that needs it: that the compressor is
  // there at all.
  const QUIET = 0.02;
  const LOUD = 0.4;

  const lowQ  = writeWav('low-q.wav',  ...Object.values(sine(N, 50, QUIET)) as [Float32Array, Float32Array]);
  const midQ  = writeWav('mid-q.wav',  ...Object.values(sine(N, 1000, QUIET)) as [Float32Array, Float32Array]);
  const midL  = writeWav('mid-l.wav',  ...Object.values(sine(N, 1000, LOUD)) as [Float32Array, Float32Array]);

  function track(filePath: string, config: OfflineChainConfig | null) {
    return { filePath, gainDb: 0, pan: 0, mute: false, solo: false, config };
  }

  async function deltaDb(file: string, role: StemRole | null): Promise<number> {
    const dry = await renderStemSession([track(file, null)], { sampleRate: SR, master: null });
    const wet = await renderStemSession(
      [track(file, role ? configFor(role) : null)], { sampleRate: SR, master: null });
    return db(rms(wet.left)) - db(rms(dry.left));
  }

  {
    const delta = await deltaDb(lowQ, 'vocal');
    check(
      'the vocal chain actually removes 50 Hz',
      delta < -6,
      `${delta.toFixed(1)} dB — 90 Hz 하이패스가 엔진까지 도달했다는 증거`,
    );
  }

  {
    const delta = await deltaDb(midQ, 'vocal');
    check(
      'and leaves 1 kHz alone',
      Math.abs(delta) < 2,
      `${delta.toFixed(2)} dB — 저역만 자르고 중역은 건드리지 않는 필터`,
    );
  }

  {
    const kickDelta = await deltaDb(lowQ, 'kick');
    const vocalDelta = await deltaDb(lowQ, 'vocal');
    check(
      'the kick chain keeps the 50 Hz the vocal chain removes',
      kickDelta > vocalDelta + 6,
      `킥 ${kickDelta.toFixed(1)} dB vs 보컬 ${vocalDelta.toFixed(1)} dB — 역할마다 다른 체인이 걸린다는 증거`,
    );
  }

  {
    const delta = await deltaDb(midQ, 'mid');
    check(
      'an unidentified stem comes out essentially untouched',
      Math.abs(delta) < 0.5,
      `${delta.toFixed(2)} dB`,
    );
  }

  {
    // The compressor, on a signal hot enough to reach it. `mid` has no
    // compressor at all, so it is the control: whatever the vocal chain
    // takes off here, the empty chain does not.
    const vocalLoud = await deltaDb(midL, 'vocal');
    const midLoud = await deltaDb(midL, 'mid');
    check(
      "the vocal chain's compressor engages on a hot signal",
      vocalLoud < -3 && Math.abs(midLoud) < 0.5,
      `보컬 ${vocalLoud.toFixed(1)} dB vs 빈 체인 ${midLoud.toFixed(2)} dB — ` +
      '조용한 신호에서는 같은 체인이 중역을 건드리지 않았으므로, 이 차이는 컴프레서다',
    );
  }

  // ── 3. Mixer parity across the process boundary ──────────────────────────
  console.log('\n=== THE MIXER AGREES WITH ITSELF ===\n');

  {
    // `audibleFlags` in the store and `audibleTracks` in the renderer are
    // separate implementations in separate processes. The mixer shows one
    // and the render obeys the other, so a divergence means the UI dims a
    // row that is audible in the export, or the reverse.
    const { audibleFlags } = await import('../src/renderer/stores/stemStore.js');
    const cases: Array<Array<{ mute: boolean; solo: boolean }>> = [
      [{ mute: false, solo: false }, { mute: false, solo: false }],
      [{ mute: true, solo: false }, { mute: false, solo: false }],
      [{ mute: false, solo: true }, { mute: false, solo: false }],
      [{ mute: true, solo: true }, { mute: false, solo: false }],
      [{ mute: false, solo: true }, { mute: false, solo: true }],
      [{ mute: true, solo: false }, { mute: true, solo: false }],
    ];
    const mismatches = cases.filter((c) =>
      JSON.stringify(audibleFlags(c as never)) !== JSON.stringify(audibleTracks(c)));
    check(
      'the mixer and the renderer agree on who is audible',
      mismatches.length === 0,
      mismatches.length === 0
        ? `${cases.length}가지 조합 일치 — 화면에서 흐리게 보이는 줄과 익스포트에서 빠지는 줄이 같다`
        : `불일치 ${mismatches.length}건: ${JSON.stringify(mismatches)}`,
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
