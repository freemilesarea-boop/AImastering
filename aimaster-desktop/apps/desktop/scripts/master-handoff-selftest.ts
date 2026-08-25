/**
 * master-handoff-selftest.ts — the stems, summed into the one file that goes
 * to mastering.
 *
 * `daw-engine-selftest` renders a great deal, but every one of its renders is
 * a single track (or a track and its aux).  The thing the send-to-mastering
 * button actually does — take seven tracks and hand back one file with all
 * seven in it — had nothing holding it.  A mix that quietly dropped a stem
 * would still produce a file of the right length that plays, and the missing
 * guitar would be found by ear, in the master, after the fact.
 *
 * So this renders a session whose tracks are deliberately separable by
 * frequency, and asks of the result the questions a person would ask of the
 * file:
 *
 *   · is every track in it, at the level it was set to
 *   · is a muted one absent, and does solo exclude the rest
 *   · is the file long enough for the LAST track, not the first
 *   · does a track pushed late still fit inside it
 *   · does the WAV that leaves actually carry that audio
 *
 * Run via:  pnpm --filter @aimaster/desktop test:master-handoff
 */

import { OfflineAudioContext } from 'node-web-audio-api';

// `renderSession` reads OfflineAudioContext off globalThis (the browser has it).
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createClip, createSession, createTrack, sessionEndSec,
  updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession, sessionRange } from '../src/renderer/daw/engine/offline-render.js';
import { encodeAudioBuffer, encodeWav } from '../src/renderer/daw/engine/wav.js';
import { handoffProblem, handoffFileName } from '../src/renderer/daw/edit/master-handoff.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a.toFixed(4)} vs ${b.toFixed(4)}`);
}

/**
 * How much of `freq` is in the buffer, as an amplitude.
 *
 * Goertzel over the whole render: one bin, exact, and immune to whatever else
 * is in the mix — which is the point, because the whole test is "are all four
 * of these in here at once".
 */
function amplitudeAt(buffer: AudioBuffer, freq: number, channel = 0): number {
  const data = buffer.getChannelData(channel);
  const n = data.length;
  const k = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = (data[i] ?? 0) + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / n;
}

function peak(buffer: AudioBuffer, fromSec = 0, toSec = Infinity): number {
  let out = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const from = Math.max(0, Math.floor(fromSec * SR));
    const to = Math.min(data.length, Math.ceil(toSec * SR));
    for (let i = from; i < to; i++) out = Math.max(out, Math.abs(data[i] ?? 0));
  }
  return out;
}

/** A tone file registered in the cache, the way a decoded import would be. */
function tone(fileId: string, freq: number, amp: number, seconds: number): void {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  analyzeBuffer(fileId, buffer as unknown as AudioBuffer);
}

interface Stem { fileId: string; freq: number; seconds: number; startSec?: number }

/** A session of several audio tracks, the shape the stem panel leaves behind. */
function stemSession(stems: readonly Stem[]): { session: DawSession; ids: string[] } {
  resetIds();
  let session = createSession('Stem Mix', SR);
  const ids: string[] = [];
  for (const stem of stems) {
    const track = createTrack(stem.fileId, 'audio');
    ids.push(track.id);
    session = addTrack(session, track);
    session = addFile(session, {
      id: stem.fileId, path: `/virtual/${stem.fileId}.wav`, name: stem.fileId,
      durationSec: stem.seconds, sampleRate: SR, channels: 2,
    });
    session = updateClips(session, track.id, () => [
      createClip(stem.fileId, stem.fileId, {
        startSec: stem.startSec ?? 0, offsetSec: 0, durationSec: stem.seconds,
      }),
    ]);
  }
  return { session, ids };
}

const FOUR: Stem[] = [
  { fileId: 'vox', freq: 440, seconds: 1 },
  { fileId: 'bass', freq: 110, seconds: 1 },
  { fileId: 'gtr', freq: 1320, seconds: 1 },
  { fileId: 'keys', freq: 660, seconds: 1 },
];

const render = (session: DawSession, tailSec = 0): Promise<AudioBuffer> =>
  renderSession(session, sessionRange(session), { sampleRate: SR, tailSec });

async function main(): Promise<void> {
  clearAudioCache();
  for (const s of FOUR) tone(s.fileId, s.freq, 0.25, s.seconds);

  // ── Every stem is in the file ─────────────────────────────────────────────

  await check('all four stems are in the one file, each at its own level', async () => {
    const { session } = stemSession(FOUR);
    const out = await render(session);
    for (const stem of FOUR) {
      const amp = amplitudeAt(out, stem.freq);
      near(amp, 0.25, 0.03, `${stem.fileId} (${stem.freq} Hz) is missing or at the wrong level`);
    }
  });

  await check('a stem that is not in the session is not in the file', async () => {
    // The same measurement, at a frequency nobody played — so a pass above
    // cannot be the meter answering yes to everything.
    const { session } = stemSession(FOUR);
    const out = await render(session);
    for (const absent of [220, 880, 2000]) {
      assert(amplitudeAt(out, absent) < 0.01,
        `${absent} Hz should not be in the mix: ${amplitudeAt(out, absent).toFixed(4)}`);
    }
  });

  await check('dropping one stem changes only that stem', async () => {
    const { session } = stemSession(FOUR);
    const without = { ...session, tracks: session.tracks.filter((t) => t.name !== 'gtr') };
    const out = await render(without);
    assert(amplitudeAt(out, 1320) < 0.01, 'the removed guitar is still audible');
    for (const stem of FOUR.filter((s) => s.fileId !== 'gtr')) {
      near(amplitudeAt(out, stem.freq), 0.25, 0.03, `${stem.fileId} moved when the guitar left`);
    }
  });

  // ── The mix decisions come with it ────────────────────────────────────────

  await check('a fader move on one stem lands in the file', async () => {
    const { session, ids } = stemSession(FOUR);
    // -6 dB on the bass only.
    const quieter = updateTrack(session, ids[1]!, (t): Track => ({ ...t, volumeDb: -6 }));
    const out = await render(quieter);
    near(amplitudeAt(out, 110), 0.25 * Math.pow(10, -6 / 20), 0.02, 'the bass fader did not apply');
    near(amplitudeAt(out, 440), 0.25, 0.03, 'and it must not touch the vocal');
  });

  await check('a muted stem is absent and the rest are untouched', async () => {
    const { session, ids } = stemSession(FOUR);
    const muted = updateTrack(session, ids[2]!, (t): Track => ({ ...t, mute: true }));
    const out = await render(muted);
    assert(amplitudeAt(out, 1320) < 0.01, 'a muted guitar is in the mix');
    for (const stem of FOUR.filter((s) => s.fileId !== 'gtr')) {
      near(amplitudeAt(out, stem.freq), 0.25, 0.03, `${stem.fileId} changed`);
    }
  });

  await check('solo sends only the soloed stem — a send with solo up is a solo mix', async () => {
    // Worth pinning: someone auditioning one stem and then hitting send gets a
    // file with one stem in it, and that IS what the button should do, but it
    // must be the soloed one and only it.
    const { session, ids } = stemSession(FOUR);
    const soloed = updateTrack(session, ids[0]!, (t): Track => ({ ...t, solo: true }));
    const out = await render(soloed);
    near(amplitudeAt(out, 440), 0.25, 0.03, 'the soloed vocal should be there');
    for (const stem of FOUR.filter((s) => s.fileId !== 'vox')) {
      assert(amplitudeAt(out, stem.freq) < 0.01,
        `${stem.fileId} survived someone else's solo: ${amplitudeAt(out, stem.freq).toFixed(4)}`);
    }
  });

  // ── The file is long enough for all of it ─────────────────────────────────

  await check('the file runs to the LAST stem, not the first', async () => {
    const staggered: Stem[] = [
      { fileId: 'vox', freq: 440, seconds: 1, startSec: 0 },
      { fileId: 'bass', freq: 110, seconds: 1, startSec: 0 },
      { fileId: 'gtr', freq: 1320, seconds: 1, startSec: 0 },
      // The keyboard comes in late and runs past everything else.
      { fileId: 'keys', freq: 660, seconds: 1, startSec: 2 },
    ];
    const { session } = stemSession(staggered);
    near(sessionRange(session).endSec, 3, 1e-6, 'the bounce length must reach the last clip');
    const out = await render(session);
    near(out.duration, 3, 0.01, 'the rendered file is short');
    // And the late entry really is in there, at the end.
    assert(peak(out, 2.1, 3) > 0.1, 'the late keyboard did not make it into the file');
  });

  await check('a stem pushed late still fits inside the file', async () => {
    // `sessionRange` used to walk the clips itself and miss the Track Delay,
    // which is the one input to the length that is not a rectangle on screen.
    const { session, ids } = stemSession(FOUR);
    const late = updateTrack(session, ids[3]!, (t): Track => ({ ...t, delayMs: 400 }));
    near(sessionRange(late).endSec, sessionEndSec(late), 1e-9,
      'the bounce length and the session length must be the same question');
    near(sessionRange(late).endSec, 1.4, 1e-6, 'a 400 ms push makes the session 400 ms longer');
    const out = await render(late);
    assert(out.duration >= 1.4 - 1e-3, `the file is ${out.duration}s, too short for the pushed stem`);
    assert(peak(out, 1.05, 1.4) > 0.05, 'the pushed stem tail is missing from the file');
  });

  await check('an empty session has nothing to send', async () => {
    resetIds();
    const empty = createSession('Empty', SR);
    near(sessionRange(empty).endSec, 0, 1e-9, 'an empty session has no length');
    assert(handoffProblem(empty, { queued: 0 }), 'sending an empty session should be refused');
  });

  // ── What leaves the app ───────────────────────────────────────────────────

  await check('the WAV that leaves carries the mix, at the size it claims', async () => {
    const { session } = stemSession(FOUR);
    const out = await render(session);
    const bytes = encodeAudioBuffer(out, 32);
    // RIFF header, then 32-bit float stereo for every rendered frame.
    assert(bytes.length > 44, 'the encoded file is only a header');
    const text = String.fromCharCode(...bytes.slice(0, 4)) + String.fromCharCode(...bytes.slice(8, 12));
    assert(text === 'RIFFWAVE', `not a WAV: ${text}`);
    const expected = 44 + out.length * out.numberOfChannels * 4;
    assert(Math.abs(bytes.length - expected) <= 80,
      `a ${out.length}-frame stereo 32-bit render should be about ${expected} bytes, got ${bytes.length}`);
    assert(out.numberOfChannels === 2, `the master is stereo, got ${out.numberOfChannels} channels`);
  });

  await check('a mix that sums past full scale is NOT clipped on its way out', async () => {
    // Seven stems at unity routinely peak above 0 dBFS.  The handoff is
    // 32-bit float precisely so the mastering stage gets the real peaks and
    // can pull them down; clamping here would hard-clip the mix before the
    // limiter that exists to deal with it ever sees it, and nothing
    // downstream could get it back.
    const loud = new Float32Array([0, 1.8, -1.8, 0.5, -0.5]);
    const encoded = encodeWav([loud, loud], SR, 32);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const at = (frame: number, channel: number): number =>
      view.getFloat32(44 + (frame * 2 + channel) * 4, true);
    near(at(1, 0), 1.8, 1e-6, 'a +5 dBFS peak must survive the float encode');
    near(at(2, 1), -1.8, 1e-6, 'and so must its negative half');
    near(at(3, 0), 0.5, 1e-6, 'ordinary samples are untouched');
  });

  await check('a delivery bounce still clamps, because 24-bit PCM has no room', async () => {
    const loud = new Float32Array([1.8, -1.8]);
    const encoded = encodeWav([loud], SR, 24);
    const read24 = (frame: number): number => {
      const o = 44 + frame * 3;
      const raw = (encoded[o] ?? 0) | ((encoded[o + 1] ?? 0) << 8) | ((encoded[o + 2] ?? 0) << 16);
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x7fffff;
    };
    near(read24(0), 1, 1e-4, 'over full scale must clip to full scale, not wrap');
    near(read24(1), -1, 1e-4, 'and the same underneath');
  });

  await check('the whole handoff carries a hot mix without clipping it', async () => {
    // The real path, not the encoder alone: four stems pushed up so the sum
    // goes over, rendered and encoded exactly as the button does it.
    const { session, ids } = stemSession(FOUR);
    let hot = session;
    for (const id of ids) hot = updateTrack(hot, id, (t): Track => ({ ...t, volumeDb: 12 }));
    const out = await render(hot);
    const rendered = peak(out);
    assert(rendered > 1, `this test needs a mix that goes over — it peaked at ${rendered.toFixed(3)}`);
    const bytes = encodeAudioBuffer(out, 32);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let written = 0;
    for (let i = 0; i < out.length * out.numberOfChannels; i++) {
      written = Math.max(written, Math.abs(view.getFloat32(44 + i * 4, true)));
    }
    near(written, rendered, 1e-5,
      'the staged file lost the peaks the render produced — it is being clipped on the way out');
  });

  await check('the staged file is named after the session', async () => {
    const { session } = stemSession(FOUR);
    const named = { ...session, name: '내 곡 / 첫 믹스' };
    const file = handoffFileName(named.name);
    assert(file.includes('.wav'), `no extension: ${file}`);
    assert(!/[/\\]/.test(file.replace(/\.wav$/, '')), `a path separator survived into the name: ${file}`);
  });

  // ── The gate ──────────────────────────────────────────────────────────────

  await check('a full session with audible tracks is allowed through', async () => {
    const { session } = stemSession(FOUR);
    assert(handoffProblem(session, { queued: 0 }) === null,
      `a normal mix was refused: ${handoffProblem(session, { queued: 0 })}`);
  });

  await check('everything muted is refused rather than sent as silence', async () => {
    const { session } = stemSession(FOUR);
    const silent: DawSession = {
      ...session,
      tracks: session.tracks.map((t): Track => (t.kind === 'master' ? t : { ...t, mute: true })),
    };
    const problem = handoffProblem(silent, { queued: 0 });
    assert(problem, 'an all-muted mix should not be staged');
    // And the render really would be silence, which is what makes it worth refusing.
    const out = await render(silent);
    assert(peak(out) < 0.001, `an all-muted mix rendered at ${peak(out)}`);
  });

  // ────────────────────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Send to mastering ===');
  console.log(`${FOUR.length} stems summed into one file\n`);
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void main();
