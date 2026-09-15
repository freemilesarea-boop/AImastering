// A chain on ONE CLIP, and the tail problem that comes with it.
//
// Cut a piece out of a track with the scissors, put a delay on that piece, and
// there is one question the feature lives or dies on: what happens to the
// delay's last repeats, which land AFTER the piece ends?
//
// Three answers, and only two of them are worth building:
//
//   CUT   Stop at the clip's end.  The right answer for an EQ or a gain —
//         they do not outlive their input — and the wrong answer for anything
//         that rings, where it sounds like the delay was unplugged mid-repeat.
//
//   KEEP  Render the ring as well and let the processed clip run PAST its
//         original end, overlapping whatever follows.  Clips on a track sum,
//         so the tail lands on top of the next piece exactly the way it would
//         if the chain had been on the whole track.  This is the default.
//
//   (LIVE, an aux with an automated send, is the third answer.  It belongs to
//   the mixer rather than to the clip, so it is not here.)
//
// ── Rendering from the original, always ──────────────────────────────────────
//
// `clip.regionFx.original` remembers what the clip pointed at before the first
// apply.  Every render starts from there.  Skip that and turning one knob and
// pressing apply again runs the chain over audio that has already been through
// the chain — the second apply would be a delay of a delay, which is not what
// anyone asked for and is very hard to notice until it is baked.

import { findTrack, trackClips, addFile, updateClips } from '../model/session-ops.js';
import { chainTailSec } from '../model/plugin-tail.js';
import { analyzeBuffer } from '../engine/audio-cache.js';
import { renderSession, writeTempChannels } from '../engine/offline-render.js';
import { nextId } from '../model/ids.js';
import type {
  AudioFileRef, Clip, ClipId, DawSession, Insert, RegionFx, TailMode, Track, TrackId,
} from '../model/types.js';

/** A clip's chain, or nothing if it has never been through the lab. */
export function clipRegionFx(clip: Clip): RegionFx | null {
  return clip.regionFx ?? null;
}

/** What the clip pointed at before any chain was applied. */
export function originalSource(
  clip: Clip,
): { fileId: string; offsetSec: number; durationSec: number; gainDb: number } {
  return clip.regionFx?.original
    ?? {
      fileId: clip.fileId, offsetSec: clip.offsetSec,
      durationSec: clip.durationSec, gainDb: clip.gainDb,
    };
}

/** The clip's length as the arrangement sees it, tail excluded. */
export function bodyDurationSec(clip: Clip): number {
  return clip.regionFx?.original.durationSec ?? clip.durationSec;
}

export function canApplyRegionFx(
  session: DawSession, trackId: TrackId | null, clipId: ClipId | null,
): { ok: true; clip: Clip; track: Track } | { ok: false; reason: string } {
  if (!trackId || !clipId) return { ok: false, reason: '조각을 먼저 고르세요' };
  const track = findTrack(session, trackId);
  if (!track) return { ok: false, reason: '트랙을 찾을 수 없습니다' };
  const clip = trackClips(track).find((c) => c.id === clipId);
  if (!clip) return { ok: false, reason: '조각을 찾을 수 없습니다' };
  if (clip.kind !== 'audio') return { ok: false, reason: 'MIDI 파트에는 인서트를 걸 수 없습니다 — 오디오 조각을 고르세요' };
  return { ok: true, clip, track };
}

export interface RegionRender {
  /** The clip's own length, processed. */
  body: Float32Array[];
  /** What kept ringing after it.  Empty when the chain does not ring. */
  tail: Float32Array[];
  sampleRate: number;
  /** Seconds the chain said it would ring. */
  tailSec: number;
}

/**
 * Build a session that is this clip, on this track, through these inserts, and
 * nothing else.
 *
 * The fader, the pan and the track delay are all left at unity: they act on
 * the channel AFTER the inserts and are still there when the rendered audio
 * goes back into the track, so applying them here would apply them twice.
 * Clip gain and fades are NOT reset — they belong to the clip, and the chain
 * should hear the clip the way the arrangement does.
 */
/**
 * The clip as the RENDER sees it: the untouched source, no fades, gain intact.
 *
 * The fades stay OFF the render and stay ON the clip.  Baking them would apply
 * them twice — once into the file, once again on playback — and in `keep` mode
 * the clip grows by the tail, so a baked fade-out would end up ramping the ring
 * instead of the note.  Left on the clip they are applied once, in the right
 * place, and can still be dragged afterwards.
 *
 * The GAIN is the other way round: it is rendered in, and `applyRegionFx`
 * zeroes it on the clip afterwards so it is not applied a second time.  That
 * is why `RegionFx.original` has to write the number down.
 *
 * Exported so both of those can be held to, rather than inferred from a
 * rendered buffer.
 */
export function renderSourceClip(clip: Clip): Clip {
  const source = originalSource(clip);
  return {
    ...clip,
    fileId: source.fileId,
    offsetSec: source.offsetSec,
    durationSec: source.durationSec,
    fadeIn: { durationSec: 0, shape: clip.fadeIn.shape },
    fadeOut: { durationSec: 0, shape: clip.fadeOut.shape },
  };
}

function isolate(
  session: DawSession, trackId: TrackId, clip: Clip, inserts: readonly Insert[],
): DawSession {
  const bare = renderSourceClip(clip);
  return {
    ...session,
    tracks: session.tracks.map((t): Track => {
      if (t.id === trackId) {
        return {
          ...t,
          mute: false, solo: false, output: { kind: 'master' },
          delayMs: 0, volumeDb: 0, pan: 0,
          inserts: inserts.filter((i) => !i.bypass).map((i) => ({ ...i })),
          playlists: t.playlists.map((p) => (
            p.id === t.activePlaylistId ? { ...p, clips: [bare] } : { ...p, clips: [] }
          )),
        };
      }
      if (t.kind === 'master') return { ...t, inserts: [], volumeDb: 0, pan: 0, mute: false, solo: false };
      return { ...t, mute: true, solo: false };
    }),
  };
}

function channelsOf(buffer: AudioBuffer, from: number, to: number): Float32Array[] {
  const out: Float32Array[] = [];
  const length = Math.max(0, Math.min(buffer.length, to) - Math.max(0, from));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const slice = new Float32Array(length);
    if (length > 0) slice.set(buffer.getChannelData(c).subarray(Math.max(0, from), Math.max(0, from) + length));
    out.push(slice);
  }
  return out;
}

/** Peak of a set of channels, as a linear amplitude. */
function peak(channels: readonly Float32Array[]): number {
  let max = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i] ?? 0);
    if (v > max) max = v;
  }
  return max;
}

/** Below this the "tail" is silence and there is nothing to keep. */
const SILENT_TAIL = 1e-4;   // −80 dBFS

/**
 * A chain that rings for less than this is not really ringing.
 *
 * A look-ahead limiter reports a few milliseconds of latency as tail; cutting
 * that off is inaudible and warning about it would be noise.
 */
export const RINGING_SEC = 0.02;

/**
 * The fade put on the seam when a RINGING chain is cut there, in seconds.
 *
 * Only then.  Cutting a delay mid-repeat leaves the waveform at whatever value
 * it happened to hold, and a step from that to the next clip's first sample is
 * a click — the chop is the point, the click is not.  But a chain that does
 * not ring ends where its input ended, continuous with what follows, and
 * fading THAT would punch an eight-millisecond hole into audio that was
 * seamless.  So the fade is conditional, and the condition is the ring.
 */
export const SEAM_FADE_SEC = 0.008;

/** Fade the last `seconds` of every channel down to zero, in place. */
export function fadeSeam(channels: readonly Float32Array[], sampleRate: number, seconds: number): void {
  // Never more than half the piece: a fade that eats the whole buffer is not a
  // declick, it is a different edit.  A clip shorter than the fade is left
  // alone entirely.
  const n = Math.min(
    Math.floor(seconds * sampleRate),
    Math.floor((channels[0]?.length ?? 0) / 2),
  );
  if (n <= 1) return;
  for (const ch of channels) {
    const start = ch.length - n;
    for (let i = 0; i < n; i++) {
      // Equal-power rather than linear: a linear fade this short is audible as
      // a dip on sustained material.
      ch[start + i] = (ch[start + i] ?? 0) * Math.cos((i / (n - 1)) * (Math.PI / 2));
    }
  }
}

/**
 * Run one clip through a chain offline and hand back the body and the tail
 * separately, so the caller can decide what to do with the ring.
 */
export async function renderClipChain(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  inserts: readonly Insert[],
  options: { sampleRate?: number } = {},
): Promise<RegionRender> {
  const guard = canApplyRegionFx(session, trackId, clipId);
  if (!guard.ok) throw new Error(guard.reason);
  const { clip } = guard;

  const sampleRate = options.sampleRate ?? session.sampleRate;
  const tailSec = chainTailSec(inserts, sampleRate);
  const source = originalSource(clip);
  const isolated = isolate(session, trackId, clip, inserts);

  const rendered = await renderSession(
    isolated,
    { startSec: clip.startSec, endSec: clip.startSec + source.durationSec },
    { sampleRate, tailSec },
  );

  const bodyFrames = Math.min(rendered.length, Math.round(source.durationSec * sampleRate));
  return {
    body: channelsOf(rendered, 0, bodyFrames),
    tail: channelsOf(rendered, bodyFrames, rendered.length),
    sampleRate,
    tailSec,
  };
}

export interface ApplyRegionFxOptions {
  inserts: readonly Insert[];
  /** `live` is not a render — it is `makeRegionLive` in `region-live.ts`. */
  tailMode: Exclude<TailMode, 'live'>;
  sampleRate?: number;
}

export interface ApplyRegionFxResult {
  session: DawSession;
  message: string;
  /** Seconds the clip grew by.  Zero in `cut` mode and for a silent tail. */
  grewBySec: number;
}

/**
 * Render the clip through the chain and put the result back in its place.
 *
 * In `keep` mode the replacement clip is LONGER than the one it replaced, by
 * however long the chain rang.  It therefore overlaps whatever comes next, and
 * that is the point: overlapping clips on a track sum, so the tail lands over
 * the following material instead of being deleted at the seam.
 */
export async function applyRegionFx(
  session: DawSession, trackId: TrackId, clipId: ClipId, options: ApplyRegionFxOptions,
): Promise<ApplyRegionFxResult> {
  const guard = canApplyRegionFx(session, trackId, clipId);
  if (!guard.ok) throw new Error(guard.reason);
  const { clip } = guard;
  const live = options.inserts.filter((i) => !i.bypass);
  if (live.length === 0) throw new Error('걸린 플러그인이 없습니다 — 슬롯에 하나 넣으세요');

  const render = await renderClipChain(session, trackId, clipId, live, options);
  const source = originalSource(clip);

  const keepTail = options.tailMode === 'keep'
    && render.tail.length > 0
    && (render.tail[0]?.length ?? 0) > 0
    && peak(render.tail) > SILENT_TAIL;

  const channels = keepTail
    ? render.body.map((body, c) => {
      const tail = render.tail[c] ?? new Float32Array(0);
      const joined = new Float32Array(body.length + tail.length);
      joined.set(body, 0);
      joined.set(tail, body.length);
      return joined;
    })
    : render.body;

  // Cutting a chain that rings leaves the waveform mid-repeat.  Take the click
  // off the seam without softening a chain that had nothing to cut.
  const ringing = render.tailSec >= RINGING_SEC && peak(render.tail) > SILENT_TAIL;
  const cutARing = options.tailMode === 'cut' && ringing;
  if (cutARing) fadeSeam(channels, render.sampleRate, SEAM_FADE_SEC);

  const grewBySec = keepTail ? (render.tail[0]?.length ?? 0) / render.sampleRate : 0;
  const durationSec = source.durationSec + grewBySec;

  const path = await writeTempChannels(channels, render.sampleRate, `${clip.name}-fx`);
  const file: AudioFileRef = {
    id: nextId('file'),
    path,
    name: `${clip.name} (처리)`,
    durationSec,
    sampleRate: render.sampleRate,
    channels: channels.length,
  };

  let next = addFile(session, file);
  seedCache(file.id, channels, render.sampleRate);

  const fx: RegionFx = {
    inserts: live.map((i) => ({ ...i })),
    tailMode: options.tailMode,
    tailSec: render.tailSec,
    original: source,
  };

  next = updateClips(next, trackId, (clips) => clips.map((c) => (c.id === clipId ? {
    ...c,
    fileId: file.id,
    // The rendered file IS the clip — it starts at its first sample.
    offsetSec: 0,
    durationSec,
    // The chain has already been applied at the clip's own gain, so leaving
    // the gain on would apply it a second time on playback.
    gainDb: 0,
    regionFx: fx,
  } : c)));

  const names = live.map((i) => i.label).join(' → ');
  const tailNote = keepTail
    ? ` · 꼬리 ${grewBySec.toFixed(2)}초를 뒤에 얹었습니다`
    : options.tailMode === 'keep'
      ? ' · 이 체인은 울리지 않아 꼬리가 없습니다'
      : cutARing
        // Said out loud, because it is the one combination that can be a
        // mistake: the chain had a ring and the ring is now gone.
        ? ` · 꼬리 ${render.tailSec.toFixed(2)}초를 버리고 조각 끝에서 잘랐습니다`
        : ' · 울리지 않는 체인이라 잘라낼 꼬리가 없었습니다';
  return { session: next, message: `${names} 적용${tailNote}`, grewBySec };
}

/**
 * Put the clip back the way it was.
 *
 * The original file is still in the session — nothing deletes it — so this is
 * a pointer change, not a re-render.
 */
export function revertRegionFx(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): { session: DawSession; message: string } {
  const guard = canApplyRegionFx(session, trackId, clipId);
  if (!guard.ok) throw new Error(guard.reason);
  const fx = clipRegionFx(guard.clip);
  if (!fx) return { session, message: '되돌릴 처리가 없습니다' };
  const next = updateClips(session, trackId, (clips) => clips.map((c) => {
    if (c.id !== clipId) return c;
    const { regionFx: _drop, ...rest } = c;
    return {
      ...rest,
      fileId: fx.original.fileId,
      offsetSec: fx.original.offsetSec,
      durationSec: fx.original.durationSec,
      // Applying the chain baked the gain in and zeroed it; reverting without
      // this hands the audio back at unity and quietly loses the trim.
      gainDb: fx.original.gainDb,
    };
  }));
  return { session: next, message: '원래 오디오로 되돌렸습니다' };
}

/**
 * Put the rendered samples into the decode cache.
 *
 * Without this the clip's waveform is blank until the file is decoded back off
 * disk — a decode of audio that is already in memory, right after a render the
 * user watched happen.
 */
function seedCache(fileId: string, channels: readonly Float32Array[], sampleRate: number): void {
  const ctor = (globalThis as unknown as {
    AudioBuffer?: new (o: { length: number; sampleRate: number; numberOfChannels: number }) => AudioBuffer;
  }).AudioBuffer;
  const length = channels[0]?.length ?? 0;
  if (!ctor || length === 0) return;
  const buffer = new ctor({ length, sampleRate, numberOfChannels: channels.length });
  for (let c = 0; c < channels.length; c++) {
    buffer.getChannelData(c).set(channels[c] ?? new Float32Array(0));
  }
  analyzeBuffer(fileId, buffer);
}
