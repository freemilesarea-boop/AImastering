/**
 * stem-export-selftest — one file per part of the mix.
 *
 * The claim a stem export makes is not "one file per track".  It is that
 * PLAYING THE STEMS TOGETHER GIVES THE MIX BACK, and everything else is
 * detail.  So the centrepiece here is arithmetic on real renders: the stems
 * are summed sample by sample and compared against the mix.
 *
 * The cases that matter are the ones where a naive implementation drifts:
 * a send to a reverb aux (where does the tail go?), a muted track (is it in
 * the sum or not?), a solo (what IS the mix?), and tracks of different
 * lengths (do the files still line up?).
 *
 * Run: pnpm --filter @aimaster/desktop test:stems
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createBus, createClip, createInsert, createSend, createSession,
  createTrack, findTrack, setInsert, setSend, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer } from '../src/renderer/daw/engine/audio-cache.js';
import { defaultParams } from '../src/renderer/daw/engine/plugins.js';
import {
  describePlan, isolateStem, planStems, renderStem, renderStemReference,
} from '../src/renderer/daw/engine/stem-export.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';
import { StemPathError, stemFileName, stemFilePath } from '../src/main/utils/stemPath.js';
import { encodeAudioBuffer } from '../src/renderer/daw/engine/wav.js';

const SR = 44100;
const results: { name: string; pass: boolean }[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${String(a)}, want ${String(b)}`);
}

/** A steady tone, registered as a decoded file. */
function tone(id: string, hz: number, seconds: number, amp = 0.3): void {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  analyzeBuffer(id, buffer as unknown as AudioBuffer);
}

interface Part { name: string; hz: number; seconds: number; startSec?: number }

function sessionOf(parts: readonly Part[]): DawSession {
  resetIds();
  let session = createSession('stem test', SR);
  for (const part of parts) {
    tone(part.name, part.hz, part.seconds);
    const track = createTrack(part.name, 'audio');
    session = addTrack(session, track);
    session = addFile(session, {
      id: part.name, path: `/virtual/${part.name}.wav`, name: part.name,
      durationSec: part.seconds, sampleRate: SR, channels: 2,
    });
    session = updateClips(session, track.id, () => [createClip(part.name, part.name, {
      startSec: part.startSec ?? 0, offsetSec: 0, durationSec: part.seconds,
    })]);
  }
  return session;
}

/** Worst per-sample difference between the summed stems and the mix. */
function summingError(mix: AudioBuffer, stems: readonly AudioBuffer[]): {
  worst: number; peak: number;
} {
  let worst = 0;
  let peak = 0;
  for (let c = 0; c < mix.numberOfChannels; c++) {
    const mixData = mix.getChannelData(c);
    for (let i = 0; i < mixData.length; i++) {
      let sum = 0;
      for (const stem of stems) sum += stem.getChannelData(c)[i] ?? 0;
      const d = Math.abs(sum - (mixData[i] ?? 0));
      if (d > worst) worst = d;
      const a = Math.abs(mixData[i] ?? 0);
      if (a > peak) peak = a;
    }
  }
  return { worst, peak };
}

async function renderAll(session: DawSession): Promise<{
  mix: AudioBuffer; stems: AudioBuffer[]; plan: ReturnType<typeof planStems>;
}> {
  const plan = planStems(session);
  const mix = await renderStemReference(session, plan.range);
  const stems: AudioBuffer[] = [];
  for (const item of plan.items) stems.push(await renderStem(session, item.trackId, plan.range));
  return { mix, stems, plan };
}

/** RMS of a window, for asking where a reverb tail ended up. */
function rms(buffer: AudioBuffer, fromSec: number): number {
  const data = buffer.getChannelData(0);
  const from = Math.min(data.length, Math.floor(fromSec * SR));
  let sum = 0;
  for (let i = from; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, data.length - from));
}

async function run(): Promise<void> {
  // ── The property ────────────────────────────────────────────────────────

  await check('the stems sum to the mix', async () => {
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 3 },
      { name: 'bass', hz: 160, seconds: 3 },
      { name: 'vox', hz: 440, seconds: 3 },
    ]);
    // Faders and pans on, or the test would pass for a build that ignored both.
    const ids = session.tracks.filter((t) => t.kind === 'audio').map((t) => t.id);
    session = updateTrack(session, ids[0]!, (t) => ({ ...t, volumeDb: -3 }));
    session = updateTrack(session, ids[1]!, (t) => ({ ...t, volumeDb: -6, pan: -0.4 }));
    session = updateTrack(session, ids[2]!, (t) => ({ ...t, pan: 0.5 }));

    const { mix, stems } = await renderAll(session);
    const { worst, peak } = summingError(mix, stems);
    assert(peak > 0.1, `the mix is not silent — peak ${peak.toFixed(4)}`);
    // Float32 rounding across three summed buffers, nothing more.
    assert(worst < 1e-5, `stems sum to the mix — worst ${worst.toExponential(2)} vs peak ${peak.toFixed(4)}`);
  });

  await check('a send reaches its aux, and the tail lands on the sending stem', async () => {
    // The case an isolate-the-channel implementation gets wrong: rendering
    // each track alone loses the send, and every stem comes out dry.
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 2 },
      { name: 'vox', hz: 440, seconds: 2 },
    ]);
    const bus = createBus('FX');
    session = { ...session, buses: [...session.buses, bus] };
    const aux = createTrack('Reverb', 'aux');
    session = addTrack(session, aux);
    session = updateTrack(session, aux.id, (t) => ({
      ...t, input: bus.id, output: { kind: 'master' },
    }));
    session = setInsert(session, aux.id, {
      ...createInsert(0, 'reverb', 'Reverb'),
      params: { ...defaultParams('reverb'), mix: 1, decaySec: 2 },
    });
    const vox = session.tracks.find((t) => t.name === 'vox')!;
    session = setSend(session, vox.id, createSend(0, bus.id, { levelDb: -3 }));

    const { mix, stems, plan } = await renderAll(session);
    const { worst, peak } = summingError(mix, stems);
    assert(worst < 1e-5, `still sums — worst ${worst.toExponential(2)} vs peak ${peak.toFixed(4)}`);

    // Past the end of the clips, only a tail can be sounding.
    const kickIndex = plan.items.findIndex((i) => i.trackName === 'kick');
    const voxIndex = plan.items.findIndex((i) => i.trackName === 'vox');
    const kickTail = rms(stems[kickIndex]!, 2.3);
    const voxTail = rms(stems[voxIndex]!, 2.3);
    assert(voxTail > 1e-3, `the vocal stem carries its reverb — ${voxTail.toExponential(2)}`);
    eq(kickTail, 0, 'and the kick stem carries none of it');
  });

  await check('every stem is the same length, whatever its own audio does', async () => {
    // A track whose clip stops early must still produce a file of the full
    // length, or the stems do not line up in whatever opens them next.
    const session = sessionOf([
      { name: 'short', hz: 200, seconds: 1 },
      { name: 'long', hz: 300, seconds: 4 },
      { name: 'late', hz: 500, seconds: 1, startSec: 3 },
    ]);
    const { stems, plan } = await renderAll(session);
    eq(plan.range.startSec, 0, 'they share an origin');
    assert(Math.abs(plan.range.endSec - 4) < 1e-6, `and a length — ${plan.range.endSec}`);
    const lengths = new Set(stems.map((s) => s.length));
    eq(lengths.size, 1, `one length across ${stems.length} stems, got ${[...lengths].join(', ')}`);
  });

  // ── What is in the mix ──────────────────────────────────────────────────

  await check('a muted track is left out, by name, and the sum still holds', async () => {
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 2 },
      { name: 'noise', hz: 900, seconds: 2 },
    ]);
    const noise = session.tracks.find((t) => t.name === 'noise')!;
    session = updateTrack(session, noise.id, (t) => ({ ...t, mute: true }));

    const plan = planStems(session);
    eq(plan.items.length, 1, 'only the audible track');
    eq(plan.skipped.length, 1, 'and the other is reported');
    eq(plan.skipped[0]?.trackName, 'noise', 'by name — a count sends you hunting');

    const { mix, stems } = await renderAll(session);
    const { worst } = summingError(mix, stems);
    assert(worst < 1e-5, `a muted track is not in the mix either — ${worst.toExponential(2)}`);
  });

  await check('while something is soloed, the mix is the solo — and so are the stems', async () => {
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 2 },
      { name: 'bass', hz: 160, seconds: 2 },
      { name: 'vox', hz: 440, seconds: 2 },
    ]);
    const vox = session.tracks.find((t) => t.name === 'vox')!;
    session = updateTrack(session, vox.id, (t) => ({ ...t, solo: true }));

    const plan = planStems(session);
    eq(plan.items.length, 1, 'only what is audible');
    eq(plan.items[0]?.trackName, 'vox', 'the soloed one');
    const { mix, stems } = await renderAll(session);
    const { worst, peak } = summingError(mix, stems);
    assert(peak > 0.1, 'the soloed mix is not silent');
    assert(worst < 1e-5, `and the one stem is the whole mix — ${worst.toExponential(2)}`);
  });

  await check('a track with no clips is skipped rather than written as silence', () => {
    let session = sessionOf([{ name: 'kick', hz: 80, seconds: 2 }]);
    session = addTrack(session, createTrack('Empty', 'audio'));
    const plan = planStems(session);
    eq(plan.items.length, 1, 'one real stem');
    eq(plan.skipped[0]?.trackName, 'Empty', 'and the empty one is named');
  });

  // ── The master chain ────────────────────────────────────────────────────

  await check('the master chain is off by default, and saying otherwise is a warning', async () => {
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 2, },
      { name: 'vox', hz: 440, seconds: 2 },
    ]);
    const master = session.tracks.find((t) => t.kind === 'master')!;
    session = setInsert(session, master.id, {
      ...createInsert(0, 'limiter', 'Limiter'),
      params: { ...defaultParams('limiter'), ceilingDb: -12 },
    });

    // Default: the limiter is not on the stems, so they still sum.
    const { mix, stems } = await renderAll(session);
    const { worst } = summingError(mix, stems);
    assert(worst < 1e-5, `bare master, stems sum — ${worst.toExponential(2)}`);

    // And a session that asks for it is told what it costs.
    const warned = planStems(session, { includeMaster: true });
    assert(warned.warnings.some((w) => w.includes('리미터')),
      `the cost is stated — ${warned.warnings.join(' / ')}`);
    assert(planStems(session).warnings.length === 0, 'and not stated when it does not apply');
  });

  await check('including the master chain really does break the sum', async () => {
    // The claim in that warning, measured.  A limiter is not linear: limit
    // each stem on its own and the sum is something nobody has heard.
    let session = sessionOf([
      { name: 'a', hz: 220, seconds: 2 },
      { name: 'b', hz: 330, seconds: 2 },
    ]);
    const master = session.tracks.find((t) => t.kind === 'master')!;
    session = setInsert(session, master.id, {
      ...createInsert(0, 'limiter', 'Limiter'),
      params: { ...defaultParams('limiter'), ceilingDb: -20 },
    });

    const options = { includeMaster: true };
    const plan = planStems(session, options);
    const mix = await renderStemReference(session, plan.range, options);
    const stems: AudioBuffer[] = [];
    for (const item of plan.items) {
      stems.push(await renderStem(session, item.trackId, plan.range, options));
    }
    const { worst, peak } = summingError(mix, stems);
    assert(peak > 0.01, 'the limited mix is audible');
    assert(worst > 1e-3,
      `the warning is true, not decorative — worst ${worst.toExponential(2)}`);
  });

  // ── Isolation ───────────────────────────────────────────────────────────

  await check('isolation mutes the other sources and leaves the routing alone', () => {
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 1 },
      { name: 'vox', hz: 440, seconds: 1 },
    ]);
    const bus = createBus('FX');
    session = { ...session, buses: [...session.buses, bus] };
    const aux = createTrack('Reverb', 'aux');
    session = addTrack(session, aux);
    session = updateTrack(session, aux.id, (t) => ({ ...t, input: bus.id }));

    const kick = session.tracks.find((t) => t.name === 'kick')!;
    const isolated = isolateStem(session, kick.id);
    eq(findTrack(isolated, kick.id)?.mute, false, 'the stem plays');
    eq(isolated.tracks.find((t) => t.name === 'vox')?.mute, true, 'the other source does not');
    eq(isolated.tracks.find((t) => t.name === 'Reverb')?.mute, false,
      'the return stays up, or the send would go nowhere');
    eq(isolated.tracks.find((t) => t.kind === 'master')?.mute, false, 'and the master sums');
  });

  await check('a leftover solo elsewhere cannot silence the stem being rendered', async () => {
    // Solo is relative — "everything else off" — so carrying a solo flag into
    // an isolated render would mute the very track being exported.
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 1 },
      { name: 'vox', hz: 440, seconds: 1 },
    ]);
    const vox = session.tracks.find((t) => t.name === 'vox')!;
    session = updateTrack(session, vox.id, (t) => ({ ...t, solo: true }));

    const isolated = isolateStem(session, vox.id);
    assert(isolated.tracks.every((t) => !t.solo), 'no solo survives isolation');
    const rendered = await renderStem(session, vox.id, { startSec: 0, endSec: 1 });
    let peak = 0;
    const data = rendered.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
    assert(peak > 0.1, `the soloed track's own stem is audible — ${peak.toFixed(4)}`);
  });

  // ── Names ───────────────────────────────────────────────────────────────

  await check('file names are numbered, deduplicated and safe', () => {
    resetIds();
    let session = createSession('names', SR);
    for (const name of ['Gtr', 'Gtr', 'Vox/Lead', 'Kick']) {
      tone(name, 220, 1);
      const track = createTrack(name, 'audio');
      session = addTrack(session, track);
      session = addFile(session, {
        id: `${name}-${track.id}`, path: `/v/${track.id}.wav`, name,
        durationSec: 1, sampleRate: SR, channels: 2,
      });
      session = updateClips(session, track.id, () => [createClip(`${name}-${track.id}`, name, {
        startSec: 0, offsetSec: 0, durationSec: 1,
      })]);
    }
    const names = planStems(session).items.map((i) => i.fileName);
    eq(names[0], '01 Gtr', 'numbered so they sort in track order');
    eq(names[1], '02 Gtr', 'the number already makes the second one unique');
    assert(!names[2]!.includes('/'), `no separators — ${names[2]}`);
    eq(names[3], '04 Kick', 'and the numbering keeps counting');
    eq(new Set(names).size, names.length, 'all distinct, so none overwrites another');
  });

  await check('two tracks that would collide after sanitising still get separate files', () => {
    resetIds();
    let session = createSession('collide', SR);
    // Both sanitise to the same thing; only the counter keeps them apart.
    for (const name of ['Mix:A', 'Mix/A']) {
      tone(name, 220, 1);
      const track = createTrack(name, 'audio');
      session = addTrack(session, track);
      session = addFile(session, {
        id: `${name}`, path: `/v/${track.id}.wav`, name, durationSec: 1, sampleRate: SR, channels: 2,
      });
      session = updateClips(session, track.id, () => [createClip(name, name, {
        startSec: 0, offsetSec: 0, durationSec: 1,
      })]);
    }
    const names = planStems(session).items.map((i) => i.fileName);
    eq(new Set(names).size, 2, `distinct — ${names.join(', ')}`);
  });

  await check('the plan says what it will do before anything is rendered', () => {
    let session = sessionOf([
      { name: 'kick', hz: 80, seconds: 2 },
      { name: 'muted', hz: 300, seconds: 2 },
    ]);
    const muted = session.tracks.find((t) => t.name === 'muted')!;
    session = updateTrack(session, muted.id, (t) => ({ ...t, mute: true }));
    const text = describePlan(planStems(session));
    assert(text.includes('1개'), `the count — ${text}`);
    assert(text.includes('제외'), `and what is being left out — ${text}`);
  });

  // ── The name that arrives in main ───────────────────────────────────────

  await check('a stem file name cannot escape the folder it was given', () => {
    // The renderer names the files, and a name arriving on an IPC channel is
    // untrusted input however friendly the sender.
    const dir = '/tmp/stems';
    for (const attack of [
      '../escape', '../../etc/passwd', 'a/b', 'a\\b', '..', '.', '....',
      '/absolute', 'C:\\Windows\\system32',
    ]) {
      let landed: string | null = null;
      try { landed = stemFilePath(dir, attack); } catch (err) {
        assert(err instanceof StemPathError, `refused cleanly — ${String(err)}`);
        continue;
      }
      // Either refused, or sanitised into a direct child — never both wrong.
      assert(landed.startsWith(`${dir}/`), `${attack} → ${landed}`);
      assert(!landed.slice(dir.length + 1).includes('/'), `${attack} → ${landed}`);
    }
  });

  await check('an ordinary stem name survives sanitising intact', () => {
    eq(stemFileName('01 Lead Vox'), '01 Lead Vox', 'numbers, spaces and letters');
    eq(stemFileName('02 보컬 (더블)'), '02 보컬 (더블)', 'Hangul and brackets');
    eq(stemFilePath('/tmp/stems', '03 Kick'), '/tmp/stems/03 Kick.wav', 'and the path is the obvious one');
    eq(stemFileName('   '), 'stem', 'an empty name still becomes a file');
    eq(stemFileName('.hidden'), 'hidden', 'and nothing becomes a dotfile by accident');
  });

  await check('what gets written is a valid WAV of the full stem', async () => {
    const session = sessionOf([{ name: 'kick', hz: 80, seconds: 2 }]);
    const plan = planStems(session);
    const buffer = await renderStem(session, plan.items[0]!.trackId, plan.range);
    const bytes = encodeAudioBuffer(buffer, 24);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (at: number): string => String.fromCharCode(
      view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    eq(tag(0), 'RIFF', 'a RIFF header');
    eq(tag(8), 'WAVE', 'of type WAVE');
    eq(view.getUint16(22, true), 2, 'stereo');
    eq(view.getUint32(24, true), SR, 'at the session rate');
    eq(view.getUint16(34, true), 24, 'at the depth asked for');
    // The file is as long as the render, tail included — not the clip.
    const frames = (bytes.byteLength - 44) / (2 * 3);
    assert(Math.abs(frames - buffer.length) <= 1, `${frames} frames vs ${buffer.length}`);
  });

  await check('an empty session is a refusal, not an empty folder', () => {
    resetIds();
    const plan = planStems(createSession('empty', SR));
    eq(plan.items.length, 0, 'nothing to export');
    assert(plan.warnings.some((w) => w.includes('오디오')), 'and it says so');
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void run();
