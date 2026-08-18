// stem-preview-selftest — the preview must agree with the export.
//
// The realtime mixer and the offline render are two separate pieces of code
// computing the same thing: N stems, each with a fader and a balance, some
// muted, some soloed, summed. If they disagree, the user hears one mix and
// ships another — the worst class of bug a mastering tool can have, because
// it is invisible until after the record is out.
//
// So the central test here builds the ACTUAL Web Audio graph the preview
// engine builds — same splitter, same two gains, same merger — renders it
// through `node-web-audio-api`'s OfflineAudioContext, and compares the
// result against `renderStemSession` sample by sample.
//
// The rest covers the things that make realtime multitrack possible at all:
// mono folding (which is what keeps a session in memory), the cache key
// (which is what keeps a fader move free), and the memory limit (which is
// what turns a crash into a sentence).
//
// Run:  pnpm --filter @aimaster/desktop test:stem-preview

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OfflineAudioContext, AudioBuffer } from 'node-web-audio-api';
import { renderStemSession } from '../src/main/offline/stem-render.js';
import {
  renderStemPreview, previewKey, sideEnergyDb, clearPreviewCache,
} from '../src/main/offline/stem-preview.js';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import {
  createStrip, stripGains, balanceGains, audibleFlags,
  previewMemoryBytes, previewFitsInMemory, PREVIEW_MEMORY_LIMIT_BYTES,
  type MixerContext, type StripSettings,
} from '../src/renderer/audio/stem-mixer-graph.js';
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-stempreview-'));

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

/** A stem with distinct left and right content, so balance errors show. */
function stereoTone(n: number, hz: number, amp: number, spread: number) {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    l[i] = amp * Math.sin(2 * Math.PI * hz * t);
    r[i] = amp * spread * Math.sin(2 * Math.PI * hz * 1.5 * t);
  }
  return { left: l, right: r };
}

function monoTone(n: number, hz: number, amp: number) {
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin(2 * Math.PI * hz * i / SR);
  return { left: l, right: l.slice() };
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}

function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]!); if (a > p) p = a; }
  return p;
}

function track(filePath: string, over: Partial<StripSettings> = {}) {
  return {
    filePath, gainDb: 0, pan: 0, mute: false, solo: false,
    config: null as OfflineChainConfig | null,
    ...over,
  };
}

/**
 * Run the preview's own graph over pre-rendered stems.
 *
 * This is the engine's `rebuildStrips` + `applyGains` + `play`, with the
 * decode replaced by buffers handed in directly — the decode is the
 * browser's and is not what this file is testing.
 */
async function renderPreviewGraph(
  stems: Array<{ pcm: { left: Float32Array; right: Float32Array }; channels: 1 | 2 } & StripSettings>,
  samples: number,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const ctx = new OfflineAudioContext(2, samples, SR);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  const gains = stripGains(stems);

  stems.forEach((stem, i) => {
    const strip = createStrip(ctx as unknown as MixerContext, master, stem.channels);
    const buffer = new AudioBuffer({
      length: stem.pcm.left.length,
      numberOfChannels: stem.channels,
      sampleRate: SR,
    });
    if (stem.channels === 1) {
      const mono = Float32Array.from(stem.pcm.left, (v, j) => (v + stem.pcm.right[j]!) * 0.5);
      buffer.copyToChannel(mono, 0);
    } else {
      buffer.copyToChannel(stem.pcm.left, 0);
      buffer.copyToChannel(stem.pcm.right, 1);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(strip.input);
    // No ramp: the comparison is against a render with constant gains, and
    // a 25 ms ramp at the top would be a real difference for 25 ms.
    const g = gains[i]!;
    strip.setGains(g.l, g.r, 0, 0);
    src.start(0);
  });

  const out = await ctx.startRendering();
  return { left: out.getChannelData(0).slice(), right: out.getChannelData(1).slice() };
}

async function main(): Promise<void> {
  // ── 1. Mixer arithmetic ──────────────────────────────────────────────────
  console.log('\n=== THE MIXER MATHS ===\n');

  {
    const strips: StripSettings[] = [
      { gainDb: 0, pan: 0, mute: false, solo: false },
      { gainDb: -6, pan: -1, mute: false, solo: false },
      { gainDb: 0, pan: 0, mute: true, solo: false },
    ];
    const g = stripGains(strips);
    check(
      'gain, balance and mute land in the leg gains',
      Math.abs(g[0]!.l - 1) < 1e-9 && Math.abs(g[0]!.r - 1) < 1e-9 &&
      Math.abs(g[1]!.l - 0.5012) < 1e-3 && g[1]!.r === 0 &&
      g[2]!.l === 0 && g[2]!.r === 0,
      `[${g.map((x) => `${x.l.toFixed(3)}/${x.r.toFixed(3)}`).join('  ')}]`,
    );
  }

  {
    const strips: StripSettings[] = [
      { gainDb: 0, pan: 0, mute: false, solo: false },
      { gainDb: 0, pan: 0, mute: false, solo: true },
    ];
    const g = stripGains(strips);
    check(
      'a solo silences everything else in the preview too',
      g[0]!.l === 0 && g[1]!.l === 1,
      `${g[0]!.l} / ${g[1]!.l} — 화면·미리듣기·익스포트가 같은 답을 내야 한다`,
    );
    check(
      'and the audible flags agree with the gains',
      JSON.stringify(audibleFlags(strips)) === JSON.stringify([false, true]),
      JSON.stringify(audibleFlags(strips)),
    );
  }

  {
    check(
      'balance is a balance, not an equal-power pan',
      balanceGains(0).l === 1 && balanceGains(0).r === 1,
      '가운데에서 -3 dB가 빠지지 않는다 — StereoPannerNode 를 썼다면 0.707이 됐을 값',
    );
  }

  // ── 2. THE test: preview == export ───────────────────────────────────────
  console.log('\n=== THE PREVIEW AGREES WITH THE EXPORT ===\n');

  const N = SR;
  const aPcm = stereoTone(N, 220, 0.35, 0.6);
  const bPcm = monoTone(N, 700, 0.25);
  const cPcm = stereoTone(N, 1300, 0.2, 1.0);
  const aPath = writeWav('a.wav', aPcm.left, aPcm.right);
  const bPath = writeWav('b.wav', bPcm.left, bPcm.right);
  const cPath = writeWav('c.wav', cPcm.left, cPcm.right);

  const CASES: Array<{ name: string; settings: StripSettings[] }> = [
    {
      name: 'unity',
      settings: [
        { gainDb: 0, pan: 0, mute: false, solo: false },
        { gainDb: 0, pan: 0, mute: false, solo: false },
        { gainDb: 0, pan: 0, mute: false, solo: false },
      ],
    },
    {
      name: 'faders and balance',
      settings: [
        { gainDb: -4.5, pan: -0.6, mute: false, solo: false },
        { gainDb: 2, pan: 0.35, mute: false, solo: false },
        { gainDb: -12, pan: 1, mute: false, solo: false },
      ],
    },
    {
      name: 'a mute',
      settings: [
        { gainDb: 0, pan: 0, mute: false, solo: false },
        { gainDb: 0, pan: 0, mute: true, solo: false },
        { gainDb: -3, pan: -0.2, mute: false, solo: false },
      ],
    },
    {
      name: 'a solo',
      settings: [
        { gainDb: 0, pan: 0, mute: false, solo: false },
        { gainDb: -6, pan: 0.5, mute: false, solo: true },
        { gainDb: 0, pan: 0, mute: false, solo: false },
      ],
    },
  ];

  for (const c of CASES) {
    const offline = await renderStemSession(
      [
        track(aPath, c.settings[0]),
        track(bPath, c.settings[1]),
        track(cPath, c.settings[2]),
      ],
      { sampleRate: SR, master: null },
    );

    const preview = await renderPreviewGraph([
      { pcm: aPcm, channels: 2, ...c.settings[0]! },
      // The mono stem is folded by the preview render, exactly as it would
      // be in the app — so this also checks that a folded stem still plays
      // centred rather than hard left.
      { pcm: bPcm, channels: 1, ...c.settings[1]! },
      { pcm: cPcm, channels: 2, ...c.settings[2]! },
    ], N);

    const dl = maxAbsDiff(offline.left, preview.left);
    const dr = maxAbsDiff(offline.right, preview.right);
    const level = Math.max(peak(offline.left), peak(offline.right), 1e-9);
    const errDb = 20 * Math.log10(Math.max(dl, dr) / level);

    check(
      `preview matches export — ${c.name}`,
      Math.max(dl, dr) < 1e-4,
      `최대 오차 ${Math.max(dl, dr).toExponential(2)} (${errDb.toFixed(0)} dB 아래), 피크 ${level.toFixed(3)}`,
    );
  }

  {
    // The control that gives the comparisons their teeth: a deliberately
    // wrong balance must FAIL the same comparison. Without this, an
    // agreement test could be passing because both sides are silent.
    const settings: StripSettings[] = [{ gainDb: 0, pan: -0.7, mute: false, solo: false }];
    const offline = await renderStemSession([track(aPath, settings[0])], { sampleRate: SR, master: null });
    const wrong = await renderPreviewGraph(
      [{ pcm: aPcm, channels: 2, ...settings[0]!, pan: 0.7 }], N);
    check(
      'control — a wrong balance is caught by the same comparison',
      maxAbsDiff(offline.right, wrong.right) > 0.05,
      `오차 ${maxAbsDiff(offline.right, wrong.right).toFixed(4)} — 비교가 무딘 게 아니라 실제로 잡는다`,
    );
  }

  {
    // A mono-folded stem has to arrive in the centre. Feeding a 1-channel
    // buffer through a splitter without thinking sends output 1 nowhere and
    // the stem plays hard left.
    const preview = await renderPreviewGraph(
      [{ pcm: bPcm, channels: 1, gainDb: 0, pan: 0, mute: false, solo: false }], N);
    check(
      'a mono-folded stem plays centred, not hard left',
      Math.abs(peak(preview.left) - peak(preview.right)) < 1e-6 && peak(preview.right) > 0.1,
      `L ${peak(preview.left).toFixed(4)}  R ${peak(preview.right).toFixed(4)}`,
    );
  }

  // ── 3. Baking ────────────────────────────────────────────────────────────
  console.log('\n=== BAKING THE CHAINS ===\n');

  clearPreviewCache();

  {
    const first = await renderStemPreview(bPath, null, SR);
    const second = await renderStemPreview(bPath, null, SR);
    check(
      'a bake is cached, so a fader move costs nothing',
      !first.cached && second.cached && second.previewPath === first.previewPath,
      `1회차 ${first.renderMs} ms → 2회차 ${second.renderMs} ms (캐시)`,
    );
    check(
      'a centred stem is folded to mono',
      first.channels === 1 && first.memoryBytes === first.samples * 4,
      `${first.channels}채널, ${(first.memoryBytes / 1e6).toFixed(1)} MB — 중앙에 있는 스템은 절반만 든다`,
    );
  }

  {
    const wide = await renderStemPreview(cPath, null, SR);
    check(
      'a wide stem is kept in stereo',
      wide.channels === 2,
      `${wide.channels}채널, side ${sideEnergyDb(cPcm.left, cPcm.right).toFixed(1)} dB`,
    );
  }

  {
    const plain = previewKey(bPath, null, SR);
    const withChain = previewKey(
      bPath,
      { suiteConfig: stemWireFor('vocal') } as unknown as OfflineChainConfig,
      SR,
    );
    const otherRate = previewKey(bPath, null, 44_100);
    check(
      'the cache key changes with the chain and the sample rate',
      plain !== withChain && plain !== otherRate,
      '체인을 바꾸고도 옛 렌더가 재생되면 사용자가 편집한 결과를 못 듣는다',
    );
  }

  {
    const before = previewKey(bPath, null, SR);
    // Re-export the same stem from the DAW: same path, different contents.
    const changed = monoTone(N, 700, 0.4);
    writeWav('b.wav', changed.left, changed.right);
    const after = previewKey(bPath, null, SR);
    check(
      'and with the file itself',
      before !== after,
      '같은 경로로 다시 내보낸 스템이 옛 소리로 재생되면 안 된다',
    );
  }

  {
    const withChain = await renderStemPreview(
      aPath,
      { suiteConfig: stemWireFor('vocal') } as unknown as OfflineChainConfig,
      SR,
    );
    const dry = await renderStemPreview(aPath, null, SR);
    check(
      'the bake carries the stem’s chain',
      withChain.previewPath !== dry.previewPath && withChain.samples === dry.samples,
      '체인이 있는 렌더와 없는 렌더는 다른 파일이어야 한다',
    );
  }

  // ── 4. Memory ────────────────────────────────────────────────────────────
  console.log('\n=== MEMORY ===\n');

  {
    const min4 = 4 * 60 * SR;
    const stereo = previewMemoryBytes([{ samples: min4, channels: 2 }]);
    const mono = previewMemoryBytes([{ samples: min4, channels: 1 }]);
    check(
      'the cost of holding a session is stated in real bytes',
      Math.abs(stereo - 92_160_000) < 1e6 && mono * 2 === stereo,
      `4분 스테레오 ${(stereo / 1e6).toFixed(0)} MB, 모노 ${(mono / 1e6).toFixed(0)} MB`,
    );
  }

  {
    // An ordinary session has to be allowed. Twelve stems on a four-minute
    // song is not a stress case, it is a Tuesday, and a limit that refused
    // it would make the preview useless on real work.
    const ordinary = Array.from({ length: 12 }, () => ({ samples: 4 * 60 * SR, channels: 2 as const }));
    const fit = previewFitsInMemory(ordinary);
    check(
      'an ordinary twelve-stem session fits',
      fit.fits,
      `${(fit.bytes / 1e9).toFixed(2)} GB ≤ 한도 ${(fit.limit / 1e9).toFixed(2)} GB — 평범한 세션을 거부하면 미리듣기가 무의미하다`,
    );
  }

  {
    // A genuinely large one does not, and that is where the sentence beats
    // the crash.
    const big = Array.from({ length: 20 }, () => ({ samples: 5 * 60 * SR, channels: 2 as const }));
    const fit = previewFitsInMemory(big);
    check(
      'a session too large to hold is refused rather than crashed into',
      !fit.fits && fit.limit === PREVIEW_MEMORY_LIMIT_BYTES,
      `20개 스테레오 5분 = ${(fit.bytes / 1e9).toFixed(2)} GB > 한도 ${(fit.limit / 1e9).toFixed(2)} GB`,
    );
  }

  {
    // Mono folding is a large saving and not a cure. Saying so here rather
    // than asserting something flattering keeps the limit honest: a big
    // band session genuinely does not fit, and the app's answer is to say
    // so and offer solo rather than to pretend.
    const stereo = Array.from({ length: 20 }, () => ({ samples: 5 * 60 * SR, channels: 2 as const }));
    const folded = Array.from({ length: 20 }, (_, i) => ({
      samples: 5 * 60 * SR, channels: (i < 12 ? 1 : 2) as 1 | 2,
    }));
    const saved = 1 - previewMemoryBytes(folded) / previewMemoryBytes(stereo);
    check(
      'mono folding takes a real bite out of a big session, without curing it',
      saved > 0.25 && !previewFitsInMemory(folded).fits,
      `${(previewMemoryBytes(stereo) / 1e9).toFixed(2)} → ${(previewMemoryBytes(folded) / 1e9).toFixed(2)} GB ` +
      `(${(saved * 100).toFixed(0)}% 절약) — 그래도 20개 5분은 안 들어가고, 그렇다고 말하는 것이 맞다`,
    );
  }

  {
    // Where folding does decide the outcome: a session sitting just over
    // the line goes under it.
    const stereo = Array.from({ length: 14 }, () => ({ samples: 4 * 60 * SR, channels: 2 as const }));
    const folded = Array.from({ length: 14 }, (_, i) => ({
      samples: 4 * 60 * SR, channels: (i < 8 ? 1 : 2) as 1 | 2,
    }));
    check(
      'and it is what lets a fourteen-stem session in at all',
      !previewFitsInMemory(stereo).fits && previewFitsInMemory(folded).fits,
      `${(previewMemoryBytes(stereo) / 1e9).toFixed(2)} GB (거부) → ${(previewMemoryBytes(folded) / 1e9).toFixed(2)} GB (허용)`,
    );
  }

  clearPreviewCache();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
