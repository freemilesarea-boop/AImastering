// stem-studio-selftest — per-stem editing, and the rule it must not break.
//
// Opening a stem in the Studio hands the user the WHOLE rack, limiter and
// dither included, because that is the rack the Studio has. On a master that
// is correct. On a stem it is not: a limiter per stem flattens the mix
// balance the session exists to let you set, and dither belongs once, at the
// final word-length reduction.
//
// So the load-bearing claim here is a negative one — the stages a stem must
// not carry are removed on the way to the engine — and a negative claim
// about a config object is worth very little on its own. Anyone can delete a
// key and assert it is gone. The test that means something puts a stem with
// a hard limiter set in its Studio state through the real render and checks
// the audio was NOT limited.
//
// Run:  pnpm --filter @aimaster/desktop test:stem-studio

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import { renderStemSession } from '../src/main/offline/stem-render.js';
import {
  ensureStemChain, resetStemChain, hasStemChain,
  resolveStemWire, stripMasterOnly, MASTER_ONLY_WIRE_KEYS,
} from '../src/renderer/audio/presets/stem-studio.js';
import { loadSongSettings, saveSongSettings } from '../src/renderer/audio/session/song-settings.js';
import { STEM_CHAIN } from '../src/renderer/audio/presets/stem-defaults.js';

process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

// The Studio's storage is localStorage, and every call in song-settings is
// guarded — without a stand-in the persistence tests would pass by doing
// nothing at all. Installed before any test runs; the module only touches
// storage when called, so import order does not matter.
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}
installStorage();


let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-stemstudio-'));

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

function sine(n: number, hz: number, amp: number): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin(2 * Math.PI * hz * i / SR);
  return { left: l, right: l.slice() };
}

function peakDb(buf: Float32Array): number {
  let p = 0;
  for (let i = Math.floor(buf.length * 0.25); i < buf.length; i++) {
    const a = Math.abs(buf[i]!); if (a > p) p = a;
  }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

function rmsDb(buf: Float32Array): number {
  const start = Math.floor(buf.length * 0.25);
  let sum = 0;
  for (let i = start; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  const r = Math.sqrt(sum / (buf.length - start));
  return r > 0 ? 20 * Math.log10(r) : -Infinity;
}

function track(filePath: string, config: OfflineChainConfig | null) {
  return { filePath, gainDb: 0, pan: 0, mute: false, solo: false, config };
}

async function main(): Promise<void> {
  // ── 1. Seeding ────────────────────────────────────────────────────────────
  console.log('\n=== OPENING A STEM SEEDS ITS INSTRUMENT ===\n');

  const kickPath = '/tmp/session/Kick In.wav';
  const vocalPath = '/tmp/session/Lead Vox.wav';

  {
    check(
      'a stem starts with no chain of its own',
      !hasStemChain(kickPath),
      '편집 전에는 악기 기본값을 따른다',
    );
  }

  {
    const seeded = ensureStemChain(kickPath, 'kick');
    const preset = STEM_CHAIN.kick;
    const comp = preset.modules.dynamics!.parameters;
    check(
      'opening it writes the instrument chain, not a blank rack',
      hasStemChain(kickPath) &&
      seeded.state.dynamics.parameters.attackMs === comp.attackMs &&
      seeded.freeBands.length === preset.eqBands.length,
      `어택 ${String(seeded.state.dynamics.parameters.attackMs)} ms, EQ ${seeded.freeBands.length}밴드 — ` +
      '빈 랙으로 열면 분류기가 고른 킥 체인이 사라진다',
    );
    check(
      'and the EQ bands keep their shape',
      seeded.freeBands[0]!.kind === preset.eqBands[0]!.type &&
      seeded.freeBands[0]!.frequencyHz === preset.eqBands[0]!.frequencyHz,
      `${seeded.freeBands[0]!.kind} @ ${seeded.freeBands[0]!.frequencyHz} Hz`,
    );
  }

  {
    // The user edits: a distinctive output trim nothing else would produce.
    const saved = loadSongSettings(kickPath)!;
    saveSongSettings({
      ...saved,
      state: {
        ...saved.state,
        eq: { ...saved.state.eq, parameters: { ...saved.state.eq.parameters, outputGainDb: -9 } },
      },
    });

    const again = ensureStemChain(kickPath, 'kick');
    check(
      'opening it a second time does not overwrite the edit',
      again.state.eq.parameters.outputGainDb === -9,
      `outputGainDb ${String(again.state.eq.parameters.outputGainDb)} dB — 두 번째 방문이 첫 번째를 지우면 안 된다`,
    );

    // Changing the instrument is not a reason to discard an hour of work.
    const afterRoleChange = resolveStemWire(kickPath, 'vocal');
    check(
      'changing the instrument keeps a hand-edited chain',
      afterRoleChange.outputGainDb === -9,
      `outputGainDb ${String(afterRoleChange.outputGainDb)} dB — 역할이 바뀌어도 편집한 체인이 남는다`,
    );

    const reset = resetStemChain(kickPath, 'vocal');
    check(
      'and an explicit reset goes back to the instrument default',
      reset.state.eq.parameters.outputGainDb !== -9 &&
      reset.freeBands[0]!.frequencyHz === STEM_CHAIN.vocal.eqBands[0]!.frequencyHz,
      `하이패스 ${reset.freeBands[0]!.frequencyHz} Hz — 보컬 기본값`,
    );
  }

  // ── 2. Resolution ─────────────────────────────────────────────────────────
  console.log('\n=== WHICH CHAIN A STEM GETS ===\n');

  {
    const wire = resolveStemWire(vocalPath, 'vocal');
    check(
      'an untouched stem follows its instrument',
      wire.parametricEq?.bands?.[0]?.frequencyHz === 90 && !hasStemChain(vocalPath),
      `하이패스 ${String(wire.parametricEq?.bands?.[0]?.frequencyHz)} Hz, 저장된 설정 없음`,
    );
  }

  {
    const wire = resolveStemWire(kickPath, 'vocal');
    check(
      'an edited stem follows its own chain',
      hasStemChain(kickPath) && wire.parametricEq !== undefined,
      '저장된 랙에서 만들어진 설정',
    );
  }

  // ── 3. The master-only rule ───────────────────────────────────────────────
  console.log('\n=== A STEM IS STILL NOT A MASTER ===\n');

  const limiterPath = '/tmp/session/Loud Stem.wav';

  {
    // The Studio can put a limiter on anything. Set a brutal one.
    const seeded = ensureStemChain(limiterPath, 'mid');
    saveSongSettings({
      ...seeded,
      state: {
        ...seeded.state,
        limiter: {
          ...seeded.state.limiter,
          bypass: false,
          parameters: {
            ...seeded.state.limiter.parameters,
            ceilingDbtp: -12, lookaheadMs: 2, isp: false, autoGain: false, driveDb: 0,
          },
        },
        export: {
          ...seeded.state.export,
          parameters: { ...seeded.state.export.parameters, bitDepth: 16, dither: 'tpdf' },
        },
      },
    });

    const wire = resolveStemWire(limiterPath, 'mid');
    const leaked = MASTER_ONLY_WIRE_KEYS.filter((k) => wire[k] !== undefined);
    check(
      'a limiter set in a stem’s Studio never reaches its config',
      leaked.length === 0,
      leaked.length === 0 ? '리미터 · 라우드니스 · 디더 모두 제거됨' : `남아 있음: ${leaked.join(', ')}`,
    );
  }

  {
    const before = { limiter: { ceilingDbtp: -6 }, dynamics: { ratio: 3 } };
    const after = stripMasterOnly(before as never);
    check(
      'stripping returns a copy — the master bus keeps its own limiter',
      (before as { limiter?: unknown }).limiter !== undefined && after.limiter === undefined,
      '입력을 변형하면 마스터 버스의 리미터까지 같이 사라진다',
    );
  }

  // ── 4. Measured: the strip reaches the engine ─────────────────────────────
  console.log('\n=== MEASURED ===\n');

  const N = SR;
  // -1 dBFS against a -12 dBTP ceiling. The margin has to be real: the first
  // version of this test used a -6 dBFS tone against a -3 dBTP ceiling, which
  // is already under the ceiling — so nothing would have been limited either
  // way and the control passed while proving nothing.
  const loud = writeWav('loud.wav', ...Object.values(sine(N, 1000, 0.89)) as [Float32Array, Float32Array]);

  {
    const dry = await renderStemSession([track(loud, null)], { sampleRate: SR, master: null });
    const wet = await renderStemSession(
      [track(loud, { ...baseConfig(), suiteConfig: resolveStemWire(limiterPath, 'mid') } as OfflineChainConfig)],
      { sampleRate: SR, master: null },
    );
    check(
      'a stem with a hard limiter in its Studio state is NOT limited',
      Math.abs(peakDb(wet.left) - peakDb(dry.left)) < 0.5,
      `${peakDb(wet.left).toFixed(2)} dBFS vs 원본 ${peakDb(dry.left).toFixed(2)} — ` +
      '스튜디오 상태의 -12 dBTP 리미터가 실제로 걸렸다면 11 dB 넘게 깎였을 것',
    );
  }

  {
    // The control that gives the test above its meaning: the SAME limiter
    // settings, applied where they belong, do limit. Without this, "not
    // limited" could just mean the engine ignored the limiter entirely.
    const master: OfflineChainConfig = { ...baseConfig(), limBypass: false, limCeilingDbtp: -12 };
    const res = await renderStemSession([track(loud, null)], { sampleRate: SR, master });
    check(
      'control — the same ceiling on the MASTER bus does limit',
      res.report.outputPeakDb < -10,
      `${res.report.outputPeakDb.toFixed(2)} dBFS — 리미터 자체는 동작한다, 스템에서만 빠진다`,
    );
  }

  {
    // Opening the Studio is not an edit. A stem the user looked at and left
    // alone has to come out of the render identical to one they never
    // opened — the app's default rack is a master's opening move, and
    // inheriting it here put a 3.2 dB compressor on an untouched stem.
    const untouched = '/tmp/session/Untouched.wav';
    const beforeOpen = await renderStemSession(
      [track(loud, { ...baseConfig(), suiteConfig: resolveStemWire(untouched, 'mid') } as OfflineChainConfig)],
      { sampleRate: SR, master: null },
    );
    ensureStemChain(untouched, 'mid');
    const afterOpen = await renderStemSession(
      [track(loud, { ...baseConfig(), suiteConfig: resolveStemWire(untouched, 'mid') } as OfflineChainConfig)],
      { sampleRate: SR, master: null },
    );
    const drift = rmsDb(afterOpen.left) - rmsDb(beforeOpen.left);
    check(
      'opening a stem in the Studio and changing nothing changes nothing',
      Math.abs(drift) < 0.1,
      `${drift.toFixed(3)} dB — 열어보기만 해도 소리가 바뀌면 스튜디오를 못 연다`,
    );
  }

  {
    // And an ordinary edit does reach the audio: the whole point of opening
    // the Studio is that what you do there changes the file.
    const editPath = '/tmp/session/Edited.wav';
    const seeded = ensureStemChain(editPath, 'mid');
    const dry = await renderStemSession(
      [track(loud, { ...baseConfig(), suiteConfig: resolveStemWire(editPath, 'mid') } as OfflineChainConfig)],
      { sampleRate: SR, master: null },
    );
    saveSongSettings({
      ...seeded,
      state: {
        ...seeded.state,
        eq: { ...seeded.state.eq, parameters: { ...seeded.state.eq.parameters, outputGainDb: -12 } },
      },
    });
    const wet = await renderStemSession(
      [track(loud, { ...baseConfig(), suiteConfig: resolveStemWire(editPath, 'mid') } as OfflineChainConfig)],
      { sampleRate: SR, master: null },
    );
    const delta = rmsDb(wet.left) - rmsDb(dry.left);
    check(
      'an edit made in the Studio changes the rendered stem',
      Math.abs(delta + 12) < 0.5,
      `${delta.toFixed(2)} dB (설정: -12 dB) — 스튜디오에서 한 일이 파일에 도달한다`,
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
