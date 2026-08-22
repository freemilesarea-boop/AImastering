// Standard MIDI File reader / writer.
//
// Reads format 0/1 files: notes, controllers, pitch bend, channel and poly
// pressure, program changes, tempo map, time signature and track names.
//
// The interesting part is MPE.  In an MPE file each note gets its own
// channel, and that channel's pitch bend / pressure / CC74 belong to THAT
// note — not to the part.  A flat "channel controller" import throws that
// away, so the reader detects per-note channel usage and lifts those
// controllers into per-note expression curves, which is exactly the shape
// this app's model wants.

import {
  bendFrom14bit, createNote, from7bit, noteEndBeat, sortNotes,
  type ControllerLane, type ExpressionPoint, type ExpressionTarget, type MidiNote,
} from '../model/midi.js';
import { nextId } from '../model/ids.js';
import { MIN_NOTE_BEATS } from '../edit/midi-edit.js';

/**
 * Length given to a note whose note-off never arrived — a sixteenth, long
 * enough to be audible and short enough not to smear the part.
 */
const UNCLOSED_NOTE_BEATS = 0.25;

// ── Low-level reading ─────────────────────────────────────────────────────────

class Reader {
  private view: DataView;
  private pos = 0;

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number { return this.pos; }
  get remaining(): number { return this.bytes.length - this.pos; }
  seek(to: number): void { this.pos = to; }

  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error('MIDI 파일이 예상보다 일찍 끝났습니다');
    return this.bytes[this.pos++] ?? 0;
  }
  u16(): number { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }

  ascii(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.u8());
    return out;
  }

  slice(length: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** Variable-length quantity — the encoding SMF uses for every delta time. */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    return value;
  }
}

// ── Parsed representation ─────────────────────────────────────────────────────

export interface TempoEvent { tick: number; microsecondsPerQuarter: number }

export interface RawEvent {
  tick: number;
  channel: number;
  kind: 'noteOn' | 'noteOff' | 'cc' | 'pitchBend' | 'channelPressure' | 'polyPressure' | 'program';
  /** note number, controller number, or program number. */
  a: number;
  /** velocity or value. */
  b: number;
}

export interface RawTrack {
  name: string;
  events: RawEvent[];
}

export interface MidiFile {
  format: number;
  ticksPerQuarter: number;
  tracks: RawTrack[];
  tempoMap: TempoEvent[];
  timeSignature: [number, number];
}

const HEADER = 'MThd';
const TRACK = 'MTrk';

export function parseMidiFile(bytes: Uint8Array): MidiFile {
  const reader = new Reader(bytes);
  if (reader.ascii(4) !== HEADER) throw new Error('MIDI 파일이 아닙니다 (MThd 없음)');
  const headerLength = reader.u32();
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  // Skip any header bytes beyond the 6 we know.
  if (headerLength > 6) reader.seek(8 + headerLength);

  if ((division & 0x8000) !== 0) {
    throw new Error('SMPTE 타임코드 기반 MIDI 파일은 아직 지원하지 않습니다');
  }
  const ticksPerQuarter = division === 0 ? 480 : division;

  const tracks: RawTrack[] = [];
  const tempoMap: TempoEvent[] = [];
  let timeSignature: [number, number] = [4, 4];

  for (let t = 0; t < trackCount && reader.remaining > 8; t++) {
    if (reader.ascii(4) !== TRACK) break;
    const length = reader.u32();
    const end = reader.offset + length;

    let tick = 0;
    let runningStatus = 0;
    let name = `Track ${t + 1}`;
    const events: RawEvent[] = [];

    while (reader.offset < end) {
      tick += reader.vlq();
      let status = reader.u8();
      if ((status & 0x80) === 0) {
        // Running status: reuse the previous status byte, this one is data.
        reader.seek(reader.offset - 1);
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }

      if (status === 0xff) {
        const type = reader.u8();
        const metaLength = reader.vlq();
        const data = reader.slice(metaLength);
        if (type === 0x03 && metaLength > 0) {
          name = new TextDecoder().decode(data);
        } else if (type === 0x51 && metaLength === 3) {
          tempoMap.push({
            tick,
            microsecondsPerQuarter: ((data[0] ?? 0) << 16) | ((data[1] ?? 0) << 8) | (data[2] ?? 0),
          });
        } else if (type === 0x58 && metaLength >= 2) {
          timeSignature = [data[0] ?? 4, Math.pow(2, data[1] ?? 2)];
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {          // SysEx — skipped
        const length2 = reader.vlq();
        reader.slice(length2);
        continue;
      }

      const type = status & 0xf0;
      const channel = status & 0x0f;
      switch (type) {
        case 0x80: {
          const a = reader.u8(); const b = reader.u8();
          events.push({ tick, channel, kind: 'noteOff', a, b });
          break;
        }
        case 0x90: {
          const a = reader.u8(); const b = reader.u8();
          // A note-on with velocity 0 is a note-off; every sequencer does this.
          events.push({ tick, channel, kind: b === 0 ? 'noteOff' : 'noteOn', a, b });
          break;
        }
        case 0xa0: {
          const a = reader.u8(); const b = reader.u8();
          events.push({ tick, channel, kind: 'polyPressure', a, b });
          break;
        }
        case 0xb0: {
          const a = reader.u8(); const b = reader.u8();
          events.push({ tick, channel, kind: 'cc', a, b });
          break;
        }
        case 0xc0: {
          const a = reader.u8();
          events.push({ tick, channel, kind: 'program', a, b: 0 });
          break;
        }
        case 0xd0: {
          const a = reader.u8();
          events.push({ tick, channel, kind: 'channelPressure', a, b: 0 });
          break;
        }
        case 0xe0: {
          const lsb = reader.u8(); const msb = reader.u8();
          events.push({ tick, channel, kind: 'pitchBend', a: (msb << 7) | lsb, b: 0 });
          break;
        }
        default:
          break;
      }
    }

    reader.seek(end);
    tracks.push({ name, events });
  }

  if (tempoMap.length === 0) tempoMap.push({ tick: 0, microsecondsPerQuarter: 500_000 });
  return { format, ticksPerQuarter, tracks, tempoMap, timeSignature };
}

// ── Tick → seconds ────────────────────────────────────────────────────────────

/**
 * Tempo-map-aware conversion.  A file with a ritardando has several tempo
 * events; integrating across them is the difference between a correct import
 * and everything drifting after bar 8.
 */
export function makeTickToSeconds(file: MidiFile): (tick: number) => number {
  const sorted = [...file.tempoMap].sort((a, b) => a.tick - b.tick);
  const segments: Array<{ tick: number; seconds: number; secondsPerTick: number }> = [];
  let seconds = 0;
  let prevTick = 0;
  let prevSpt = 500_000 / 1e6 / file.ticksPerQuarter;

  for (const tempo of sorted) {
    if (tempo.tick > prevTick) seconds += (tempo.tick - prevTick) * prevSpt;
    const spt = tempo.microsecondsPerQuarter / 1e6 / file.ticksPerQuarter;
    segments.push({ tick: tempo.tick, seconds, secondsPerTick: spt });
    prevTick = tempo.tick;
    prevSpt = spt;
  }
  if (segments.length === 0) {
    segments.push({ tick: 0, seconds: 0, secondsPerTick: prevSpt });
  }

  return (tick: number): number => {
    let segment = segments[0]!;
    for (const s of segments) if (s.tick <= tick) segment = s; else break;
    return segment.seconds + (tick - segment.tick) * segment.secondsPerTick;
  };
}

/**
 * Tick → BEATS.
 *
 * A tick is a fraction of a quarter note and a beat IS a quarter note, so
 * this is a division and nothing else — no tempo integration, and therefore
 * no drift after bar 8 whatever the file's tempo map does.  The file's
 * tempo events become the session tempo map instead of being baked into
 * the note positions.
 */
export function tickToBeat(file: MidiFile, tick: number): number {
  return tick / Math.max(1, file.ticksPerQuarter);
}

export function fileTempoBpm(file: MidiFile): number {
  const first = [...file.tempoMap].sort((a, b) => a.tick - b.tick)[0];
  return first ? 60_000_000 / first.microsecondsPerQuarter : 120;
}

// ── Events → notes ────────────────────────────────────────────────────────────

export interface ImportedPart {
  name: string;
  notes: MidiNote[];
  controllers: ControllerLane[];
  /** True when the source used one channel per note (MPE). */
  mpe: boolean;
  bendRangeSemitones: number;
  /** Length of the part in beats — the end of its last note. */
  durationBeat: number;
}

export interface MidiImportOptions {
  /** Force MPE interpretation on/off; omitted = auto-detect. */
  mpe?: boolean;
  /** Bend range to assume for MPE files (the MPE default is ±48). */
  bendRangeSemitones?: number;
}

/**
 * Heuristic: MPE files spread simultaneous notes across many channels and
 * bend those channels individually.  A conventional file keeps everything on
 * one channel (or on one channel per instrument, without per-note bend).
 */
export function looksLikeMpe(events: readonly RawEvent[]): boolean {
  const noteChannels = new Set<number>();
  const bendChannels = new Set<number>();
  for (const e of events) {
    if (e.kind === 'noteOn') noteChannels.add(e.channel);
    if (e.kind === 'pitchBend') bendChannels.add(e.channel);
  }
  if (noteChannels.size < 3 || bendChannels.size < 3) return false;
  // Channel 1 (index 0) is the MPE master channel; members are 1…15.
  let shared = 0;
  for (const c of bendChannels) if (noteChannels.has(c)) shared += 1;
  return shared >= 3;
}

/** Convert one SMF track into a part with notes and controller lanes. */
export function trackToPart(
  track: RawTrack, file: MidiFile, options: MidiImportOptions = {},
): ImportedPart {
  const toBeat = (tick: number): number => tickToBeat(file, tick);
  const mpe = options.mpe ?? looksLikeMpe(track.events);
  const bendRange = options.bendRangeSemitones ?? (mpe ? 48 : 2);

  const events = [...track.events].sort((a, b) => a.tick - b.tick);

  // 1. Pair note-ons with note-offs.
  interface Pending { note: MidiNote; startTick: number }
  const open = new Map<string, Pending>();
  const notes: MidiNote[] = [];
  const noteSpans: Array<{ note: MidiNote; channel: number; startBeat: number; endBeat: number }> = [];

  for (const e of events) {
    const key = `${e.channel}:${e.a}`;
    if (e.kind === 'noteOn') {
      const note = createNote({
        pitch: e.a,
        startBeat: toBeat(e.tick),
        durationBeat: UNCLOSED_NOTE_BEATS,
        velocity: from7bit(e.b),
        channel: e.channel,
      });
      open.set(key, { note, startTick: e.tick });
    } else if (e.kind === 'noteOff') {
      const pending = open.get(key);
      if (!pending) continue;
      open.delete(key);
      const startBeat = toBeat(pending.startTick);
      const endBeat = toBeat(e.tick);
      const note: MidiNote = {
        ...pending.note,
        durationBeat: Math.max(MIN_NOTE_BEATS, endBeat - startBeat),
        releaseVelocity: from7bit(e.b || 64),
      };
      notes.push(note);
      noteSpans.push({ note, channel: e.channel, startBeat, endBeat });
    }
  }
  // Anything still held at the end of the track gets a nominal length.
  for (const [, pending] of open) {
    notes.push(pending.note);
    const startBeat = toBeat(pending.startTick);
    noteSpans.push({
      note: pending.note, channel: pending.note.channel,
      startBeat, endBeat: startBeat + UNCLOSED_NOTE_BEATS,
    });
  }

  // 2. Controller curves.
  const laneMap = new Map<string, ExpressionPoint[]>();
  const targetOf = (e: RawEvent): ExpressionTarget | null => {
    if (e.kind === 'cc') {
      if (e.a === 74) return { kind: 'timbre' };
      return { kind: 'cc', controller: e.a };
    }
    if (e.kind === 'pitchBend') return { kind: 'pitchBend' };
    if (e.kind === 'channelPressure' || e.kind === 'polyPressure') return { kind: 'pressure' };
    return null;
  };
  const valueOf = (e: RawEvent): number => {
    if (e.kind === 'pitchBend') return bendFrom14bit(e.a);
    if (e.kind === 'channelPressure') return from7bit(e.a);
    if (e.kind === 'polyPressure') return from7bit(e.b);
    return from7bit(e.b);
  };

  for (const e of events) {
    const target = targetOf(e);
    if (!target) continue;
    const point: ExpressionPoint = { timeBeat: toBeat(e.tick), value: valueOf(e) };

    if (mpe) {
      // Assign the controller to the note sounding on that channel.
      const span = noteSpans.find((s) =>
        s.channel === e.channel && point.timeBeat >= s.startBeat - 1e-6 && point.timeBeat <= s.endBeat + 1e-6);
      if (span) {
        const relative: ExpressionPoint = { timeBeat: point.timeBeat - span.startBeat, value: point.value };
        const key = `${span.note.id}|${target.kind}:${target.kind === 'cc' ? target.controller : ''}`;
        const list = laneMap.get(key) ?? [];
        list.push(relative);
        laneMap.set(key, list);
        continue;
      }
    }
    const key = `part|${target.kind}:${target.kind === 'cc' ? target.controller : ''}`;
    const list = laneMap.get(key) ?? [];
    list.push(point);
    laneMap.set(key, list);
  }

  // 3. Attach per-note curves, collect part lanes.
  const notesById = new Map(notes.map((n) => [n.id, n] as const));
  const controllers: ControllerLane[] = [];

  for (const [key, points] of laneMap) {
    const [owner, targetSpec = ''] = key.split('|');
    const [kind, ccText] = targetSpec.split(':');
    const target: ExpressionTarget =
      kind === 'cc' ? { kind: 'cc', controller: Number(ccText) || 1 }
      : kind === 'pitchBend' ? { kind: 'pitchBend' }
      : kind === 'pressure' ? { kind: 'pressure' }
      : { kind: 'timbre' };
    const sorted = points.sort((a, b) => a.timeBeat - b.timeBeat);

    if (owner === 'part') {
      controllers.push({ id: nextId('lane'), target, points: sorted, visible: false });
    } else if (owner) {
      const note = notesById.get(owner);
      if (note) note.expression = [...note.expression, { target, points: sorted }];
    }
  }

  const sorted = sortNotes(notes);
  const duration = sorted.reduce((max, n) => Math.max(max, noteEndBeat(n)), 0);
  return {
    name: track.name,
    notes: sorted,
    controllers,
    mpe,
    bendRangeSemitones: bendRange,
    durationBeat: duration,
  };
}

/** Every track in the file that actually contains notes. */
export function importMidiFile(
  bytes: Uint8Array, options: MidiImportOptions = {},
): { parts: ImportedPart[]; tempoBpm: number; timeSignature: [number, number] } {
  const file = parseMidiFile(bytes);
  const parts = file.tracks
    .map((t) => trackToPart(t, file, options))
    .filter((p) => p.notes.length > 0);
  return { parts, tempoBpm: fileTempoBpm(file), timeSignature: file.timeSignature };
}

// ── Writing ───────────────────────────────────────────────────────────────────

function writeVlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) { bytes.unshift((v & 0x7f) | 0x80); v >>= 7; }
  return bytes;
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0) & 0x7f);
}

/**
 * Write notes back out as a format-0 SMF at a fixed tempo.
 * Per-note expression is flattened to channel messages — which is what a
 * MIDI 1.0 file can carry; MPE export writes one channel per voice.
 */
export function exportMidiFile(
  notes: readonly MidiNote[], tempoBpm = 120, ticksPerQuarter = 480,
): Uint8Array {
  // Beats out to ticks is a multiplication: a beat is a quarter note, and
  // `ticksPerQuarter` is how many ticks that is.  The tempo only reaches the
  // file through the tempo meta event below.
  const toTicks = (beat: number): number => Math.max(0, Math.round(beat * ticksPerQuarter));

  interface Raw { tick: number; bytes: number[] }
  const raw: Raw[] = [];
  for (const n of sortNotes(notes)) {
    if (n.muted) continue;
    const channel = n.channel & 0x0f;
    const velocity = Math.max(1, Math.round(n.velocity * 127));
    raw.push({ tick: toTicks(n.startBeat), bytes: [0x90 | channel, n.pitch & 0x7f, velocity] });
    raw.push({
      tick: toTicks(noteEndBeat(n)),
      bytes: [0x80 | channel, n.pitch & 0x7f, Math.round(n.releaseVelocity * 127) & 0x7f],
    });
  }
  // Note-offs must precede note-ons at the same tick, or a repeated pitch
  // silences itself.
  raw.sort((a, b) => a.tick - b.tick || ((a.bytes[0] ?? 0) & 0xf0) - ((b.bytes[0] ?? 0) & 0xf0));

  const trackBytes: number[] = [];
  // Tempo meta
  const usPerQuarter = Math.round(60_000_000 / tempoBpm);
  trackBytes.push(...writeVlq(0), 0xff, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);

  let lastTick = 0;
  for (const event of raw) {
    trackBytes.push(...writeVlq(event.tick - lastTick), ...event.bytes);
    lastTick = event.tick;
  }
  trackBytes.push(...writeVlq(0), 0xff, 0x2f, 0x00);      // end of track

  const header = [
    ...ascii(HEADER), 0, 0, 0, 6,
    0, 0,                       // format 0
    0, 1,                       // one track
    (ticksPerQuarter >> 8) & 0xff, ticksPerQuarter & 0xff,
  ];
  const trackHeader = [
    ...ascii(TRACK),
    (trackBytes.length >> 24) & 0xff, (trackBytes.length >> 16) & 0xff,
    (trackBytes.length >> 8) & 0xff, trackBytes.length & 0xff,
  ];
  return new Uint8Array([...header, ...trackHeader, ...trackBytes]);
}
