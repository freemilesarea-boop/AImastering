// Offline rendering — Bounce, Freeze, Commit and Consolidate.
//
// All four are the same operation with different scopes and destinations:
// build the SAME mixer graph inside an OfflineAudioContext, schedule the
// clips and automation, render, encode.  Because the plugins are pure
// WebAudio nodes, the render is a faithful copy of the live signal path —
// no "offline sounds different" class of bug.
//
//   Bounce      — whole session → user-chosen WAV
//   Freeze      — one track through its inserts → temp file, inserts idle
//   Commit      — same render, but the inserts are removed for good
//   Consolidate — a time range of one track → one new clip

import { clipEnd, findTrack, trackClips, addFile, updateTrack } from '../model/session-ops.js';
import { applyConsolidation, type TimeSelection } from '../edit/clip-edit.js';
import type { AudioFileRef, DawSession, FileId, Track, TrackId } from '../model/types.js';
import { MixerEngine } from './mixer-engine.js';
import { ClipPlayer } from './clip-player.js';
import { analyzeBuffer, getCached, preloadAll } from './audio-cache.js';
import { applyExternalInserts, type ExternalRenderResult } from './external-render.js';
import { encodeAudioBuffer, encodeWav, type WavBitDepth } from './wav.js';
import { nextId } from '../model/ids.js';
import { DEFAULT_MIDI_CONFIG } from '../model/midi.js';

export interface RenderRange {
  startSec: number;
  endSec: number;
}

export interface RenderOptions {
  sampleRate?: number;
  /** Tail rendered past the range so reverbs and delays are not cut off. */
  tailSec?: number;
}

/** Longest clip end across the session, i.e. the natural bounce length. */
export function sessionRange(session: DawSession): RenderRange {
  let end = 0;
  for (const t of session.tracks) for (const c of trackClips(t)) end = Math.max(end, clipEnd(c));
  return { startSec: 0, endSec: end };
}

function makeOfflineContext(channels: number, frames: number, sampleRate: number): OfflineAudioContext {
  const Ctor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext를 사용할 수 없습니다');
  return new Ctor(channels, Math.max(1, frames), sampleRate);
}

/** Decode everything the render needs before the offline pass starts. */
async function preloadFiles(session: DawSession, ctx: BaseAudioContext): Promise<void> {
  await preloadAll(ctx, session.files);
}

/**
 * Render a session (or a slice of it) offline.  The graph, the automation and
 * the clip gain are exactly what the live engine builds.
 */
export async function renderSession(
  session: DawSession,
  range: RenderRange,
  options: RenderOptions = {},
): Promise<AudioBuffer> {
  const sampleRate = options.sampleRate ?? session.sampleRate;
  const tail = options.tailSec ?? 2;
  const lengthSec = Math.max(0.01, range.endSec - range.startSec + tail);
  const ctx = makeOfflineContext(2, Math.ceil(lengthSec * sampleRate), sampleRate);

  await preloadFiles(session, ctx);

  const engine = new MixerEngine(ctx, ctx.destination, { meters: false });
  engine.sync(session);
  const player = new ClipPlayer(engine);
  player.scheduleAll(session, range.startSec, range.endSec + tail);

  const rendered = await ctx.startRendering();
  engine.dispose();
  return rendered;
}

/**
 * Render one track through its own inserts, with everything else silent.
 * This is what Freeze and Commit bake into a file.
 */
export async function renderTrack(
  session: DawSession,
  trackId: TrackId,
  options: RenderOptions = {},
): Promise<AudioBuffer> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');

  // Solo the track and route it straight to a bare master so the render is
  // the channel itself — not the channel through the mix bus chain.
  const isolated: DawSession = {
    ...session,
    tracks: session.tracks.map((t): Track => {
      // `delayMs: 0` matters as much as the routing.  Freeze bakes the
      // PROCESSING of a channel, not its timing: the track keeps its Track
      // Delay and the frozen clip is shifted by it at playback, exactly as
      // the original clips were.  Rendering with the delay applied and then
      // leaving the delay on the track would move the audio twice.
      if (t.id === trackId) {
        return { ...t, mute: false, solo: false, output: { kind: 'master' }, delayMs: 0 };
      }
      if (t.kind === 'master') return { ...t, inserts: [], volumeDb: 0, pan: 0, mute: false, solo: false };
      return { ...t, mute: true, solo: false };
    }),
  };

  const end = trackClips(track).reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  return renderSession(isolated, { startSec: 0, endSec: end }, options);
}

export interface TrackWindowOptions extends RenderOptions {
  /**
   * Drop this insert and everything after it.
   *
   * What a device should be advised from is what ARRIVES at it, not what
   * leaves the channel: a compressor sitting third has already been EQ'd, and
   * measuring the finished channel would set it from audio it never sees.
   */
  beforeSlot?: number;
  startSec?: number;
  endSec?: number;
}

/**
 * A window of one track, isolated, optionally truncated at an insert.
 *
 * Bounded on purpose.  Measuring a four-minute track to set a knob costs
 * seconds of rendering for numbers that a well-chosen thirty seconds gives
 * just as well, and a button that takes ten seconds is a button nobody
 * presses twice.
 */
export async function renderTrackWindow(
  session: DawSession,
  trackId: TrackId,
  options: TrackWindowOptions = {},
): Promise<AudioBuffer> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');

  const isolated: DawSession = {
    ...session,
    tracks: session.tracks.map((t): Track => {
      if (t.id === trackId) {
        return {
          ...t,
          mute: false,
          solo: false,
          output: { kind: 'master' },
          // A device is set from the material, not from where the track sits
          // in time.  Track Delay would only move the window.
          delayMs: 0,
          // The fader is not part of what a device hears — it is after the
          // inserts — so the channel is measured at unity either way.
          volumeDb: 0,
          pan: 0,
          inserts: options.beforeSlot === undefined
            ? t.inserts
            : t.inserts.filter((i) => i.slot < options.beforeSlot!),
        };
      }
      if (t.kind === 'master') return { ...t, inserts: [], volumeDb: 0, pan: 0, mute: false, solo: false };
      return { ...t, mute: true, solo: false };
    }),
  };

  const clips = trackClips(track);
  const first = clips.reduce((min, c) => Math.min(min, c.startSec), Infinity);
  const last = clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  const startSec = options.startSec ?? (Number.isFinite(first) ? first : 0);
  const endSec = options.endSec ?? last;
  if (!(endSec > startSec)) throw new Error('이 트랙에는 분석할 오디오가 없습니다');

  const { beforeSlot: _slot, startSec: _from, endSec: _to, ...render } = options;
  return renderSession(isolated, { startSec, endSec }, { ...render, tailSec: 0 });
}

// ── Destinations ──────────────────────────────────────────────────────────────

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

function invoker(): Invoke {
  const api = window.electronAPI;
  if (!api) throw new Error('electronAPI를 사용할 수 없습니다');
  return (channel, ...args) => api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
}

/** Write raw channel data to the scratch dir (used by the vocal editor). */
export async function writeTempChannels(
  channels: readonly Float32Array[], sampleRate: number, name: string,
  bitDepth: WavBitDepth = 32,
): Promise<string> {
  const bytes = encodeWav(channels, sampleRate, bitDepth);
  return await invoker()('daw:write-temp-audio', { name, data: bytes }) as string;
}

/** Write a rendered buffer to the session scratch dir; returns its path. */
export async function writeTempRender(
  buffer: AudioBuffer, name: string, bitDepth: WavBitDepth = 32,
): Promise<string> {
  const bytes = encodeAudioBuffer(buffer, bitDepth);
  const path = await invoker()('daw:write-temp-audio', { name, data: bytes }) as string;
  return path;
}

/**
 * Render the mix and hand it to the mastering queue.
 *
 * Not a bounce.  A bounce is an export — it asks where to put the file and it
 * goes through the paid-export gate, because the audio is leaving.  This is the
 * same audio moving from one screen of this app to another, so it does neither:
 * the person has not got a master yet, and charging them for carrying their own
 * mix across the app would be charging for the app's own seam.
 *
 * 32-bit float rather than the bounce's 24-bit int.  The file's only reader is
 * the mastering chain in the next room, which works in float; rounding it to 24
 * bits here would be a loss taken purely so the intermediate looked like a
 * deliverable.
 */
export async function stageForMastering(
  session: DawSession, range = sessionRange(session), bitDepth: WavBitDepth = 32,
): Promise<string> {
  const rendered = await renderSession(session, range);
  const bytes = encodeAudioBuffer(rendered, bitDepth);
  return await invoker()('daw:stage-for-mastering',
    { name: session.name, data: bytes }) as string;
}

/** Bounce to a user-chosen file.  Returns null when the dialog is cancelled. */
export async function bounceSession(
  session: DawSession, range = sessionRange(session), bitDepth: WavBitDepth = 24,
): Promise<string | null> {
  const rendered = await renderSession(session, range);
  const bytes = encodeAudioBuffer(rendered, bitDepth);
  return await invoker()('daw:bounce-audio', { name: session.name, data: bytes }) as string | null;
}

// ── Freeze / Commit ───────────────────────────────────────────────────────────

function fileRefFor(path: string, name: string, buffer: AudioBuffer): AudioFileRef {
  return {
    id: nextId('file'),
    path,
    name,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
}

export interface FreezeResult {
  session: DawSession;
  fileId: FileId;
  path: string;
  /** What the external-plugin pass did, when the track had any. */
  external?: ExternalRenderResult;
}

/**
 * Freeze — render the track's inserts into a file, bypass them, and play the
 * rendered audio instead.  Reversible: `unfreezeTrack` restores the inserts
 * and the original clips.
 */
export async function freezeTrack(session: DawSession, trackId: TrackId): Promise<FreezeResult> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');
  if (track.frozen) return { session, fileId: track.frozen.fileId, path: '' };

  // External plugins cannot run in the realtime graph, so freezing is the
  // moment they are applied — which is exactly what freezing a heavy device is
  // for.  A host failure leaves the audio untouched and is reported; it never
  // costs the freeze.
  const raw = await renderTrack(session, trackId);
  const pass = await applyExternalInserts(raw, track);
  const rendered = pass.buffer;

  const path = await writeTempRender(rendered, `${track.name}-freeze`);
  const ref = fileRefFor(path, `${track.name} (frozen)`, rendered);
  analyzeBuffer(ref.id, rendered);

  let out = addFile(session, ref);
  out = updateTrack(out, trackId, (t) => ({
    ...t,
    inserts: t.inserts.map((i) => ({ ...i, bypass: true })),
    frozen: {
      fileId: ref.id,
      renderedInsertIds: t.inserts.map((i) => i.id),
      frozenAt: Date.now(),
    },
  }));
  return { session: out, fileId: ref.id, path, external: pass };
}

export function unfreezeTrack(session: DawSession, trackId: TrackId): DawSession {
  return updateTrack(session, trackId, (t) => {
    if (!t.frozen) return t;
    const rendered = new Set(t.frozen.renderedInsertIds);
    return {
      ...t,
      inserts: t.inserts.map((i) => (rendered.has(i.id) ? { ...i, bypass: false } : i)),
      frozen: null,
    };
  });
}

/**
 * Commit — like Freeze, but the inserts are removed and the rendered audio
 * replaces the clips.  There is no going back (that is the point: the CPU is
 * given back permanently).
 */
export async function commitTrack(session: DawSession, trackId: TrackId): Promise<DawSession> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');

  const raw = await renderTrack(session, trackId);
  const rendered = (await applyExternalInserts(raw, track)).buffer;
  const path = await writeTempRender(rendered, `${track.name}-commit`);
  const ref = fileRefFor(path, `${track.name} (committed)`, rendered);
  analyzeBuffer(ref.id, rendered);

  let out = addFile(session, ref);
  out = updateTrack(out, trackId, (t) => {
    const playlist = t.playlists.find((p) => p.id === t.activePlaylistId);
    if (!playlist) return t;
    const clip = {
      id: nextId('clip'),
      kind: 'audio' as const,
      fileId: ref.id,
      notes: [],
      controllers: [],
      pitchSegments: [],
      midiConfig: DEFAULT_MIDI_CONFIG,
      name: ref.name,
      startSec: 0,
      offsetSec: 0,
      durationSec: rendered.duration,
      gainDb: 0,
      fadeIn: { durationSec: 0, shape: 'equalPower' as const },
      fadeOut: { durationSec: 0, shape: 'equalPower' as const },
      muted: false,
    };
    return {
      ...t,
      inserts: [],
      frozen: null,
      playlists: t.playlists.map((p) => (p.id === playlist.id ? { ...p, clips: [clip] } : p)),
    };
  });
  return out;
}

/**
 * Consolidate — render a time range of one track down to a single clip.
 * The classic "make this pile of edits one file" cleanup.
 */
export async function consolidateSelection(
  session: DawSession, trackId: TrackId, sel: TimeSelection,
): Promise<DawSession> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');

  // Render the clips only — inserts stay live, exactly like the real thing.
  const dry: DawSession = {
    ...session,
    tracks: session.tracks.map((t): Track => {
      if (t.id === trackId) return { ...t, inserts: [], mute: false, solo: false, volumeDb: 0, pan: 0, output: { kind: 'master' } };
      if (t.kind === 'master') return { ...t, inserts: [], volumeDb: 0, pan: 0, mute: false, solo: false };
      return { ...t, mute: true, solo: false };
    }),
  };

  const rendered = await renderSession(dry, { startSec: sel.startSec, endSec: sel.endSec }, { tailSec: 0 });
  const path = await writeTempRender(rendered, `${track.name}-consolidated`);
  const ref = fileRefFor(path, `${track.name} (consolidated)`, rendered);
  analyzeBuffer(ref.id, rendered);

  const withFile = addFile(session, ref);
  return applyConsolidation(withFile, trackId, sel, ref.id, ref.name);
}

/** True when a file's decoded audio is already in the cache. */
export function isDecoded(fileId: FileId): boolean {
  return getCached(fileId) !== undefined;
}
