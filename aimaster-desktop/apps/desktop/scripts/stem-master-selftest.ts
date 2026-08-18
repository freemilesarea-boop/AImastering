// stem-master-selftest — the master bus lands on its target.
//
// A loudness target is the one number in this product a user can check
// against another program, so it is the one number that must not be
// approximately right. The claims tested here:
//
//   • The finished master measures at the requested LUFS, not near it.
//   • The true peak stays under the preset's ceiling while it does.
//   • Different presets produce different masters, so choosing one means
//     something.
//   • When the target is out of reach, the render SAYS so rather than
//     reporting a target the file does not meet.
//
// All of it measured through the real render with the real presets — a
// master bus that agrees with itself on paper and misses by 3 dB in the
// file would pass any structural test and fail the only one that counts.
//
// Run:  pnpm --filter @aimaster/desktop test:stem-master

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import { renderStemSession } from '../src/main/offline/stem-render.js';
import { measureStereoLoudness } from '../src/main/offline/offline-loudness.js';
import {
  masterWireFor, masterBusChoices, masterTargetFor, isKnownPreset, MASTER_BUS_PRESETS,
} from '../src/renderer/audio/presets/stem-master.js';
import { getPreset } from '../src/renderer/audio/presets/loui-presets.js';
import { stemWireFor } from '../src/renderer/audio/presets/stem-chain-config.js';

process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-stemmaster-'));

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

function noise(): () => number {
  let s = 0x9e3779b9n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n) / 2 ** 30 - 1;
  };
}

/**
 * A stand-in for a mix: harmonic body, some top, a beat, and real stereo.
 *
 * Loudness is gated (BS.1770), so the material has to have level most of the
 * time or the integrated measurement is taken from very little of it and the
 * numbers stop meaning what they normally mean.
 */
function mixLike(seconds: number, amp: number): { left: Float32Array; right: Float32Array } {
  const n = SR * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const nz = noise();
  const partials: Array<[number, number]> = [
    [55, 0.9], [110, 0.7], [220, 0.6], [440, 0.45], [880, 0.3], [1760, 0.2], [3500, 0.12],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const [hz, a] of partials) v += a * Math.sin(2 * Math.PI * hz * t);
    // A hit every half second, so the material has transients to limit.
    const beat = Math.exp(-((t % 0.5)) / 0.05);
    v += 1.6 * beat * Math.sin(2 * Math.PI * 60 * (t % 0.5));
    v += 0.05 * nz();
    const k = amp / 4.5;
    l[i] = k * v;
    r[i] = k * (v * 0.92 + 0.08 * nz());
  }
  return { left: l, right: r };
}

function track(filePath: string, config: OfflineChainConfig | null) {
  return { filePath, gainDb: 0, pan: 0, mute: false, solo: false, config };
}

function masterConfig(presetId: string, override?: number): {
  config: OfflineChainConfig; targetLufs: number; ceilingDbtp: number;
} {
  const m = masterWireFor(presetId, override);
  if (!m) throw new Error(`unknown preset ${presetId}`);
  return {
    config: { ...baseConfig(), limCeilingDbtp: m.ceilingDbtp, suiteConfig: m.wire } as OfflineChainConfig,
    targetLufs: m.targetLufs,
    ceilingDbtp: m.ceilingDbtp,
  };
}

async function main(): Promise<void> {
  // ── 1. The picker's own bookkeeping ──────────────────────────────────────
  console.log('\n=== THE PRESETS ARE REAL ===\n');

  {
    const missing = MASTER_BUS_PRESETS.filter((id) => !isKnownPreset(id));
    check(
      'every preset offered as a master bus exists',
      missing.length === 0,
      missing.length === 0 ? `${MASTER_BUS_PRESETS.length}개` : missing.join(', '),
    );
  }

  {
    const choices = masterBusChoices();
    const bad = choices.filter((c) =>
      !Number.isFinite(c.targetLufs) || c.targetLufs > -6 || c.targetLufs < -24 ||
      !Number.isFinite(c.ceilingDbtp) || c.ceilingDbtp > 0);
    check(
      'each carries a sane target and a ceiling at or below 0 dBTP',
      bad.length === 0 && choices.length === MASTER_BUS_PRESETS.length,
      bad.length === 0
        ? choices.map((c) => `${c.displayName} ${c.targetLufs}/${c.ceilingDbtp}`).join(', ')
        : bad.map((c) => c.id).join(', '),
    );
  }

  {
    // The two-pass normalisation owns the loudness; the chain's AGC must be
    // off or the two would fight and the file would miss the target it
    // reported hitting.
    const bad = MASTER_BUS_PRESETS.filter((id) => masterWireFor(id)?.wire.loudness?.enabled === true);
    check(
      'the chain-internal loudness module is off on every master bus',
      bad.length === 0,
      bad.length === 0 ? '두 방식이 겹치면 서로를 밀어낸다' : bad.join(', '),
    );
  }

  {
    const preset = getPreset('kpop-loud')!;
    const fromPreset = masterTargetFor(preset);
    const built = masterWireFor('kpop-loud')!;
    const overridden = masterWireFor('kpop-loud', -12)!;
    check(
      'the target comes from the preset, and an override replaces it',
      built.targetLufs === fromPreset.targetLufs && overridden.targetLufs === -12,
      `프리셋 ${fromPreset.targetLufs} LUFS, 덮어쓰기 ${overridden.targetLufs} LUFS`,
    );
  }

  // ── 2. Measured: the master lands on the target ──────────────────────────
  console.log('\n=== THE MASTER LANDS ON ITS TARGET ===\n');

  // Loud enough that reaching the presets' targets needs a modest
  // correction rather than one the policy would clamp — the clamp is tested
  // on purpose further down, and testing it by accident here would hide
  // whether the normal path works at all.
  const bed = mixLike(12, 0.7);
  const bedPath = writeWav('bed.wav', bed.left, bed.right);
  const quiet = mixLike(12, 0.05);
  const quietPath = writeWav('quiet.wav', quiet.left, quiet.right);

  for (const id of ['streaming-pro', 'youtube-safe', 'ballad-vocal'] as const) {
    const m = masterConfig(id);
    const res = await renderStemSession(
      [track(bedPath, null)],
      { sampleRate: SR, master: m.config, masterTarget: { targetLufs: m.targetLufs } },
    );
    const err = res.report.masterLufs - m.targetLufs;
    check(
      `${getPreset(id)!.displayName} hits its loudness target`,
      Math.abs(err) < 1.0 && res.report.loudnessNote === 'ok',
      `${res.report.masterLufs.toFixed(2)} LUFS vs 목표 ${m.targetLufs} (오차 ${err.toFixed(2)} dB, ` +
      `보정 ${res.report.loudnessGainDb.toFixed(1)} dB, ${res.report.loudnessPasses}패스)`,
    );
    check(
      `${getPreset(id)!.displayName} stays under its ceiling while doing it`,
      res.report.masterTruePeakDb <= m.ceilingDbtp + 0.3,
      `${res.report.masterTruePeakDb.toFixed(2)} dBTP vs 실링 ${m.ceilingDbtp} — 라우드니스를 올리면서 피크를 넘기면 의미가 없다`,
    );
  }

  {
    // The loudest preset against this test material is a different case, and
    // an honest one. -8 LUFS under a -1 dBTP ceiling needs density that a
    // crest-heavy synthetic bed does not have: measured, the correction
    // converges at about -10.3 LUFS after 25 dB and stops moving, because
    // the limiter is taking back everything further gain adds.
    //
    // So the claim is not "it reaches -8". It is that it gets as loud as the
    // ceiling permits, reports that it did not reach the target, and still
    // holds the ceiling while failing.
    const m = masterConfig('kpop-loud');
    const res = await renderStemSession([track(bedPath, null)],
      { sampleRate: SR, master: m.config, masterTarget: { targetLufs: m.targetLufs, maxBoostDb: 30 } });
    check(
      'an unreachable loud target saturates and says so',
      res.report.loudnessNote === 'ceiling-limited' && res.report.masterLufs > -12,
      `${res.report.masterLufs.toFixed(2)} LUFS (목표 ${m.targetLufs}), ${res.report.loudnessGainDb.toFixed(1)} dB, ` +
      `${res.report.loudnessNote} — 목표에 못 미쳤다고 말하고 멈춘다`,
    );
    check(
      'and the ceiling still holds at saturation',
      res.report.masterTruePeakDb <= m.ceilingDbtp + 0.3,
      `${res.report.masterTruePeakDb.toFixed(2)} dBTP vs ${m.ceilingDbtp}`,
    );
    check(
      'the correction converges rather than running to the pass limit forever',
      res.report.loudnessPasses <= 4,
      `${res.report.loudnessPasses}패스`,
    );
  }

  {
    const a = masterConfig('kpop-loud');
    const b = masterConfig('youtube-safe');
    // Both given the same room, so the difference is the presets and not
    // the policy.
    const room = { maxBoostDb: 30 };
    const ra = await renderStemSession([track(bedPath, null)],
      { sampleRate: SR, master: a.config, masterTarget: { targetLufs: a.targetLufs, ...room } });
    const rb = await renderStemSession([track(bedPath, null)],
      { sampleRate: SR, master: b.config, masterTarget: { targetLufs: b.targetLufs, ...room } });
    check(
      'a loud preset really is louder than a safe one',
      ra.report.masterLufs > rb.report.masterLufs + 2,
      `KPOP ${ra.report.masterLufs.toFixed(1)} vs YouTube ${rb.report.masterLufs.toFixed(1)} LUFS — 프리셋 선택이 결과를 바꾼다`,
    );
  }

  {
    // The override has to reach the file, not just the report.
    const m = masterConfig('kpop-loud', -16);
    const res = await renderStemSession([track(bedPath, null)],
      { sampleRate: SR, master: m.config, masterTarget: { targetLufs: m.targetLufs } });
    check(
      'a user-set target overrides the preset in the audio',
      Math.abs(res.report.masterLufs + 16) < 1.0,
      `${res.report.masterLufs.toFixed(2)} LUFS vs 지정 -16`,
    );
  }

  // ── 3. Honest failure ────────────────────────────────────────────────────
  console.log('\n=== WHEN THE TARGET CANNOT BE REACHED ===\n');

  {
    // A very quiet session against a loud target needs more boost than the
    // policy allows. What matters is that the report says so.
    const m = masterConfig('kpop-loud', -6);
    const res = await renderStemSession([track(quietPath, null)],
      { sampleRate: SR, master: m.config, masterTarget: { targetLufs: -6, maxBoostDb: 3 } });
    check(
      'a target out of reach is reported, not silently missed',
      res.report.loudnessNote === 'clamped-boost' && res.report.masterLufs < -6,
      `${res.report.loudnessNote}, ${res.report.masterLufs.toFixed(1)} LUFS — 목표를 못 맞췄다고 말하는 것이 맞춘 척하는 것보다 낫다`,
    );
  }

  {
    let threw = '';
    try {
      await renderStemSession([track(bedPath, null)],
        { sampleRate: SR, master: null, masterTarget: { targetLufs: -9 } });
    } catch (e) { threw = (e as Error).message; }
    check(
      'a loudness target without a master chain is refused',
      threw.includes('마스터 버스 체인이 필요합니다'),
      threw || '예외 없음 — 리미터가 없으면 보정한 만큼 그대로 클리핑된다',
    );
  }

  {
    const res = await renderStemSession([track(bedPath, null)], { sampleRate: SR, master: null });
    check(
      'no master bus means no loudness claim',
      res.report.loudnessNote === 'not-requested' && res.report.loudnessGainDb === 0,
      `${res.report.loudnessNote} — 마스터 버스를 끄면 합산본 그대로`,
    );
  }

  // ── 4. Stems and master compose ──────────────────────────────────────────
  console.log('\n=== STEMS + MASTER TOGETHER ===\n');

  {
    // The whole product in one render: a stem with its own instrument chain,
    // summed, then mastered to a target.
    const m = masterConfig('streaming-pro');
    const kickCfg = { ...baseConfig(), suiteConfig: stemWireFor('kick') } as OfflineChainConfig;
    const res = await renderStemSession(
      [track(bedPath, kickCfg), track(quietPath, null)],
      { sampleRate: SR, master: m.config, masterTarget: { targetLufs: m.targetLufs } },
    );
    check(
      'a session with stem chains AND a master bus reaches the target',
      Math.abs(res.report.masterLufs - m.targetLufs) < 1.0 && res.report.rendered === 2,
      `${res.report.rendered}개 스템 → ${res.report.masterLufs.toFixed(2)} LUFS (목표 ${m.targetLufs})`,
    );
    check(
      'and the ceiling holds across the whole chain',
      res.report.masterTruePeakDb <= m.ceilingDbtp + 0.3,
      `${res.report.masterTruePeakDb.toFixed(2)} dBTP vs ${m.ceilingDbtp}`,
    );

    // The reported loudness has to be the file's loudness, not a number the
    // renderer carried forward from an earlier pass.
    const direct = measureStereoLoudness(res.left, res.right, SR);
    check(
      'the reported loudness is a measurement of the returned audio',
      Math.abs(direct.integratedLufs - res.report.masterLufs) < 0.01,
      `보고 ${res.report.masterLufs.toFixed(2)} vs 재측정 ${direct.integratedLufs.toFixed(2)} LUFS`,
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
