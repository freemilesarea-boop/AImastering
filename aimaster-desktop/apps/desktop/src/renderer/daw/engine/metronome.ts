// The click.
//
// The sound generator has been here since recording landed — `scheduleCountIn`
// makes four bars of oscillator clicks before a take.  What was missing was
// everything around it: a click that keeps going while you play, and one that
// follows the TEMPO MAP rather than a single number.
//
// That second part is the whole job.  `scheduleCountIn` takes a `tempoBpm` and
// multiplies, which is correct for a count-in (four bars at one tempo) and
// wrong for a song: a click that ignores a ritardando drifts away from the
// music it is supposed to be counting.  So beats are enumerated in BEAT SPACE
// and converted through the map, exactly like the grid lines in the ruler —
// one source of truth for where a beat is.
//
// ── Scheduled ahead, like everything else ────────────────────────────────────
//
// Clicks are scheduled into the audio context's future on the transport's own
// tick, one lookahead window at a time.  A `setInterval` that made a sound
// when it fired would be jittery by however late the timer was; scheduled
// oscillators are sample-accurate no matter when the scheduling ran.
//
// The window is remembered so a beat is never scheduled twice — the transport
// ticks far more often than a beat goes by, and a metronome that stacked three
// clicks on every beat would be its own instrument.
//
// ── It is not in the bounce, but it IS in the room ───────────────────────────
//
// The click never enters the master chain: it is a thing you listen to, not a
// thing in the mix, and the offline render never creates one at all.
//
// It does, however, go through the CONTROL ROOM, which sits after the mixer
// and before the speakers.  That is the difference between a monitor section
// and a volume knob: press MUTE to take a phone call and the click has to stop
// too, or the button did not do what it says.  DIM, the speaker-set trim and
// the monitor level reach it for the same reason.
//
// The output is a constructor-free argument to `attach` with the destination
// as its default, so a caller with no control room (a test, a headless
// context) still gets a click.

import { barBeatAt, beatToSec, meterAtBeat, secToBeat } from '../model/tempo-map.js';
import type { TempoMap } from '../model/types.js';

export interface MetronomeOptions {
  /** Downbeat pitch. */
  accentHz: number;
  /** Every other beat. */
  beatHz: number;
  /** 0…1. */
  gain: number;
  /** Also click the divisions between beats. */
  subdivision: 1 | 2 | 4;
}

export const DEFAULT_METRONOME: MetronomeOptions = {
  accentHz: 1600,
  beatHz: 1000,
  gain: 0.25,
  subdivision: 1,
};

export interface ClickEvent {
  /** Timeline seconds. */
  timeSec: number;
  /** The downbeat of a bar. */
  accent: boolean;
  /** A subdivision between beats — quieter, never accented. */
  weak: boolean;
}

/**
 * Every click in `[fromSec, toSec)` — HALF-OPEN, and that matters.
 *
 * The scheduler tiles these windows end to end, so an inclusive upper bound
 * would emit the beat on the seam twice: once as the end of one window and
 * again as the start of the next.  A metronome that stacks two clicks on the
 * beat is its own instrument.  Half-open windows compose without overlap,
 * which is the whole reason the convention exists.
 *
 * Pure over the tempo map, which is what makes it testable: hand it a map with
 * a tempo change in the middle and the clicks come out unevenly spaced in
 * SECONDS and evenly spaced in BEATS, which is the property that matters and
 * the one a bpm multiplication cannot have.
 */
export function clicksBetween(
  map: TempoMap, fromSec: number, toSec: number,
  options: MetronomeOptions = DEFAULT_METRONOME,
): ClickEvent[] {
  if (!(toSec > fromSec)) return [];
  const step = 1 / Math.max(1, options.subdivision);
  const startBeat = secToBeat(map, Math.max(0, fromSec));
  const endBeat = secToBeat(map, toSec);

  // Round UP to the next click position, so a window starting mid-beat does
  // not emit the beat it already passed.
  let beat = Math.ceil(startBeat / step - 1e-9) * step;
  const out: ClickEvent[] = [];

  // A runaway map (a zero-length beat) must not spin here.
  const MAX_CLICKS = 4096;
  while (beat <= endBeat + 1e-9 && out.length < MAX_CLICKS) {
    const timeSec = beatToSec(map, beat);
    if (timeSec >= fromSec - 1e-9 && timeSec < toSec - 1e-9) {
      const onBeat = Math.abs(beat - Math.round(beat)) < 1e-6;
      out.push({
        timeSec,
        accent: onBeat && isDownbeat(map, Math.round(beat)),
        weak: !onBeat,
      });
    }
    beat += step;
  }
  return out;
}

/** The first beat of a bar — where the accent goes. */
function isDownbeat(map: TempoMap, beat: number): boolean {
  const position = barBeatAt(map, beat);
  return Math.abs(position.beat - 1) < 1e-6;
}

/** How many beats are in the bar containing this beat — for the UI read-out. */
export function beatsInBarAt(map: TempoMap, beat: number): number {
  const meter = meterAtBeat(map, beat);
  return meter.numerator;
}

// ── Sounding it ───────────────────────────────────────────────────────────────

interface AudioContextLike {
  currentTime: number;
  destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

/**
 * Schedules clicks into the audio context's future, once per transport tick.
 *
 * Owns exactly one piece of state — how far ahead it has already scheduled —
 * because that is what stops a beat being clicked three times when the
 * transport ticks three times inside it.
 */
export class Metronome {
  private ctx: AudioContextLike | null = null;
  /** Where the click is heard.  Null means the context destination. */
  private output: AudioNode | null = null;
  private options: MetronomeOptions = DEFAULT_METRONOME;
  /** Timeline seconds already covered.  −1 means "nothing yet". */
  private scheduledTo = -1;
  private on = false;

  attach(ctx: AudioContextLike | null, output: AudioNode | null = null): void {
    this.ctx = ctx;
    this.output = output;
    this.scheduledTo = -1;
  }

  /** What the next click will connect to — the monitor path, or the speakers. */
  get destinationNode(): AudioNode | null {
    return this.output ?? this.ctx?.destination ?? null;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    // Forget the horizon so re-enabling mid-song starts from where the
    // playhead actually is, not from where it was when it was switched off.
    this.scheduledTo = -1;
  }

  get enabled(): boolean { return this.on; }

  setOptions(patch: Partial<MetronomeOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  /** A locate happened; whatever was scheduled ahead is no longer true. */
  reset(): void { this.scheduledTo = -1; }

  /**
   * Schedule the clicks in `[positionSec, positionSec + lookaheadSec)`.
   *
   * `originSec` is the context time that corresponds to timeline zero — the
   * same anchor the clip player uses, so a click and a kick that fall on the
   * same beat are scheduled to the same context time.
   */
  tick(map: TempoMap, positionSec: number, lookaheadSec: number, originSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.on) return;

    const from = this.scheduledTo < 0 ? positionSec : Math.max(this.scheduledTo, positionSec);
    const to = positionSec + lookaheadSec;
    if (!(to > from)) return;

    for (const click of clicksBetween(map, from, to, this.options)) {
      const at = originSec + click.timeSec;
      // A click whose moment has already gone is dropped rather than fired
      // late: a late click is worse than a missing one.
      if (at < ctx.currentTime) continue;
      this.sound(ctx, at, click);
    }
    this.scheduledTo = to;
  }

  private sound(ctx: AudioContextLike, at: number, click: ClickEvent): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = click.accent ? this.options.accentHz : this.options.beatHz;
    // Subdivisions sit under the beats rather than beside them, so the pulse
    // is still readable when they are on.
    const level = this.options.gain * (click.weak ? 0.45 : 1);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    // The monitor path, not the master chain: the click is listened to, not
    // mixed.  This is why a bounce never contains one — and why MUTE, DIM and
    // the monitor level reach it, since they are about the room.
    osc.connect(gain).connect(this.output ?? ctx.destination);
    osc.start(at);
    osc.stop(at + 0.08);
  }
}

/** `1|1 · 4/4 · 켜짐` — the transport read-out. */
export function describeMetronome(
  map: TempoMap, positionSec: number, enabled: boolean,
): string {
  const beat = secToBeat(map, Math.max(0, positionSec));
  const position = barBeatAt(map, beat);
  const meter = meterAtBeat(map, beat);
  return `${position.bar}|${Math.floor(position.beat)} · ${meter.numerator}/${meter.denominator}`
    + ` · ${enabled ? '켜짐' : '꺼짐'}`;
}
