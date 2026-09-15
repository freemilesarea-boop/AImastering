// The chord track, played.
//
// Reading the chords out of a record was the first half; this is the half
// that makes it worth having.  A chart nobody can hear is a list, and the
// point of "이 곡 코드 뭐야" was always to arrange from it.
//
// ── What this is not ────────────────────────────────────────────────────────
//
// The Riff Machine (`ai/riff.ts`) already writes notes against the chord
// track, and it is a different job: it INVENTS a line — contour, density,
// motif, variation — for a part you have already made.  This plays the chart
// as written, and it makes the part.  Those are different enough that sharing
// a generator would mean one function with two moods.
//
// The overlap that matters is voicing, and that is shared: both go through
// `model/chord-voicing.ts`.
//
// ── Why the voicing is the whole thing ──────────────────────────────────────
//
// Given the chords, the notes are decided.  The only real choice is WHERE to
// put them, and it is the choice that decides whether the part sounds like a
// part.  Root position for everything — which is what `voiceChord` does, and
// it is right for one chord in isolation — costs 20 semitones of movement on
// C–G–Am–F with the top note swinging over nine.  Voice-led it is 9 with the
// top note moving one.  Measured, not asserted: see `chord-voicing.ts`.

import { createNote, from7bit, type MidiNote } from '../model/midi.js';
import { voiceLead, type VoicingOptions } from '../model/chord-voicing.js';
import { pitchClass } from '../model/scales.js';
import { createMidiPart, createTrack } from '../model/session-ops.js';
import { addInstrumentSlot } from '../model/instrument-rack.js';
import { partClock, secToBeatsAt } from '../model/note-time.js';
import { tempoMapOf } from '../model/tempo-map.js';
import { chordRanges, sortedChords } from './chord-edit.js';
import { songEnd } from './arrange-ops.js';
import { formatChord, type ChordSymbol } from '../model/chords.js';
import type { ClipId, DawSession, TrackId } from '../model/types.js';

// ── Styles ──────────────────────────────────────────────────────────────────

export type BackingStyle = 'pad' | 'comp' | 'arp' | 'bass';

export const BACKING_STYLES: readonly BackingStyle[] = ['pad', 'comp', 'arp', 'bass'];

const STYLE_LABEL: Readonly<Record<BackingStyle, string>> = {
  pad: '패드', comp: '컴핑', arp: '아르페지오', bass: '베이스',
};
export const backingStyleLabel = (s: BackingStyle): string => STYLE_LABEL[s];

/** Which instrument each style wants when the caller does not say. */
const STYLE_INSTRUMENT: Readonly<Record<BackingStyle, string>> = {
  pad: 'polysynth', comp: 'epiano', arp: 'agtr', bass: 'polysynth',
};
export const backingInstrumentFor = (s: BackingStyle): string => STYLE_INSTRUMENT[s];

/** One chord, in the part's own beats. */
export interface BackingSpan {
  startBeat: number;
  endBeat: number;
  chord: ChordSymbol;
}

export interface BackingOptions {
  style?: BackingStyle;
  beatsPerBar?: number;
  voicing?: VoicingOptions;
  /** How much of its slot each note holds, 0…1. */
  gate?: number;
}

/**
 * Notes for a progression, in the part's beats.
 *
 * Pure — spans in, notes out — so what it plays can be checked without a
 * session, a track or an audio device.
 */
export function backingNotes(
  spans: readonly BackingSpan[], options: BackingOptions = {},
): MidiNote[] {
  const { style = 'pad', beatsPerBar = 4, gate = 0.95 } = options;
  if (spans.length === 0) return [];

  const chords = spans.map((s) => s.chord);
  const voicings = style === 'bass'
    ? chords.map((c) => [bassPitch(c)])
    : voiceLead(chords, { ...options.voicing, ...(style === 'arp' ? { anchor: 0.2 } : {}) });

  const notes: MidiNote[] = [];
  spans.forEach((span, index) => {
    const voicing = voicings[index] ?? [];
    if (voicing.length === 0) return;
    const length = Math.max(0.05, span.endBeat - span.startBeat);

    if (style === 'pad') {
      // One held chord.  The simplest thing that is genuinely useful: it is
      // what you put under a demo to hear the harmony move.
      for (const pitch of voicing) {
        notes.push(createNote({
          pitch, startBeat: span.startBeat,
          durationBeat: length * gate, velocity: from7bit(72),
        }));
      }
      return;
    }

    if (style === 'bass') {
      // The root on the downbeat of the chord, and again on each bar it
      // lasts, so a chord held over four bars does not leave the bass silent
      // for four bars.
      for (let beat = 0; beat < length; beat += beatsPerBar) {
        notes.push(createNote({
          pitch: voicing[0] ?? 48, startBeat: span.startBeat + beat,
          durationBeat: Math.min(beatsPerBar, length - beat) * gate,
          velocity: from7bit(beat === 0 ? 92 : 78),
        }));
      }
      return;
    }

    if (style === 'comp') {
      // A chord on every beat, short.  Not a genre pattern — a genre pattern
      // is a decision about the song, and this is the neutral thing you can
      // play over anything and then edit.
      for (let beat = 0; beat < length; beat += 1) {
        const strong = Math.round(span.startBeat + beat) % beatsPerBar === 0;
        for (const pitch of voicing) {
          notes.push(createNote({
            pitch, startBeat: span.startBeat + beat,
            durationBeat: Math.min(1, length - beat) * 0.55,
            velocity: from7bit(strong ? 90 : 74),
          }));
        }
      }
      return;
    }

    // arp — eighths cycling up the voicing and back down, so a long chord
    // does not just climb out of the register.
    //
    // The descent drops BOTH ends: `slice(1, -1)`.  Keeping them repeats the
    // top note at the turn and the bottom note at the wrap, which measured as
    // 64 67 72 67 64 *64* 67 72 — an audible stutter twice a bar, and the
    // kind of thing that is obvious in a note list and easy to miss by ear
    // while assuming the code is fine.
    const step = 0.5;
    const ladder = [...voicing, ...voicing.slice(1, -1).reverse()];
    let k = 0;
    for (let beat = 0; beat < length - 1e-9; beat += step) {
      const pitch = ladder[k % ladder.length] ?? voicing[0] ?? 60;
      notes.push(createNote({
        pitch, startBeat: span.startBeat + beat,
        durationBeat: Math.min(step, length - beat) * 0.9,
        velocity: from7bit(k % 2 === 0 ? 84 : 72),
      }));
      k += 1;
    }
  });
  return notes;
}

/** The root (or the chart's slash bass) in the bass register. */
function bassPitch(chord: ChordSymbol, floor = 36): number {
  return floor + pitchClass((chord.bass ?? chord.root) - pitchClass(floor));
}

// ── Into the session ────────────────────────────────────────────────────────

export interface BackingPartOptions extends BackingOptions {
  /** Override the instrument the style would pick. */
  instrumentId?: string;
  /** Only the chords inside this span.  Defaults to the whole chord track. */
  fromSec?: number;
  toSec?: number;
}

export interface BackingPartResult {
  session: DawSession;
  trackId: TrackId;
  clipId: ClipId;
  noteCount: number;
  message: string;
}

export type BackingPartOutcome =
  | ({ ok: true } & BackingPartResult)
  | { ok: false; reason: string };

/**
 * Turn the chord track into a playable part on a new track.
 *
 * A NEW track every time, rather than writing into whatever is selected.
 * Generating four bars of piano on top of the user's vocal take is not
 * recoverable by undo in the way that matters — they would have to notice
 * first — and a track they can mute is the cheap version of asking.
 */
export function generateBackingPart(
  session: DawSession, options: BackingPartOptions = {},
): BackingPartOutcome {
  const { style = 'pad', fromSec, toSec } = options;
  const events = sortedChords(session);
  if (events.length === 0) {
    return { ok: false, reason: '코드 트랙이 비어 있습니다 — 먼저 코드를 넣거나 오디오에서 읽으세요' };
  }

  // A chord lasts until the next one, and the last one until the song ends.
  //
  // Which is not enough on its own: `songEnd` measures CLIPS, so a session
  // whose only content is a chord chart returns zero and the last chord gets
  // a range of zero length and disappears.  Found in the running app — an
  // eight-bar skeleton came back as "코드 7개".  The lane does not have this
  // problem because it draws to the edge of the viewport, so the chart and
  // the part it generates disagreed about how many chords there were.
  //
  // The last chord gets a bar when nothing else defines the end.
  const beatsInBar = session.timeSignature[0] || 4;
  const oneBar = (60 / Math.max(1, session.tempoBpm)) * beatsInBar;
  const lastAt = events[events.length - 1]?.timeSec ?? 0;
  const chartEnd = Math.max(songEnd(session), lastAt + oneBar, toSec ?? 0);
  const ranges = chordRanges(events, chartEnd)
    .filter((r) => (fromSec === undefined || r.endSec > fromSec + 1e-6)
      && (toSec === undefined || r.startSec < toSec - 1e-6));
  if (ranges.length === 0) return { ok: false, reason: '그 구간에는 코드가 없습니다' };

  const startSec = Math.max(ranges[0]!.startSec, fromSec ?? 0);
  const endSec = Math.min(
    ranges[ranges.length - 1]!.endSec, toSec ?? Number.POSITIVE_INFINITY);
  if (!(endSec > startSec)) return { ok: false, reason: '코드 구간의 길이가 0입니다' };

  // Seconds to beats crosses over exactly once, here, so a session with a
  // tempo ramp in it still comes out on the right beats.
  const clock = partClock(tempoMapOf(session), startSec);
  const beatsPerBar = beatsInBar;
  const spans: BackingSpan[] = ranges.map((r) => ({
    startBeat: secToBeatsAt(clock, Math.max(r.startSec, startSec) - startSec),
    endBeat: secToBeatsAt(clock, Math.min(r.endSec, endSec) - startSec),
    chord: r.event.chord,
  })).filter((s) => s.endBeat > s.startBeat + 1e-9);

  const notes = backingNotes(spans, { ...options, beatsPerBar });
  if (notes.length === 0) return { ok: false, reason: '만들 음이 없습니다' };

  const instrumentId = options.instrumentId ?? backingInstrumentFor(style);
  const name = `${backingStyleLabel(style)} (코드)`;
  const track = createTrack(name, 'instrument', { instrumentId });
  const part = createMidiPart(name, {
    startSec, durationSec: endSec - startSec, notes,
  });

  return {
    ok: true,
    session: addInstrumentSlot(session, track, part),
    trackId: track.id,
    clipId: part.id,
    noteCount: notes.length,
    message: `${backingStyleLabel(style)} 파트를 만들었습니다 — 코드 ${spans.length}개, 음 ${notes.length}개`
      + ` (${formatChord(spans[0]!.chord)} …)`,
  };
}
