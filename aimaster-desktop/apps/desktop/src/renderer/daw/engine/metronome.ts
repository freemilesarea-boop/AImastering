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
import type { PassWindow } from './clip-player.js';
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

// ── Sounding it ───────────────────────────────────────────────────────────────

/** A click in the graph: the nodes, and the moment it is over. */
interface ClickVoice {
  osc: OscillatorNode;
  gain: GainNode;
  /** Context time it starts at. */
  at: number;
  /** Context time its own `stop` was set to. */
  endsAt: number;
}

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
  /**
   * The latest CONTEXT time already clicked.  −1 means "nothing yet".
   *
   * Context time, not timeline time, and that is the whole point.  The horizon
   * used to be kept in timeline seconds, which works until the timeline
   * repeats: inside a loop the horizon ran past the loop end, the position
   * wrapped back to the start, and `to > from` was false from then on — the
   * click simply stopped.  Measured in the app with a 2 s loop, 7 clicks were
   * heard where 26 were due, the last eight seconds silent.  Context time only
   * ever moves forward, so the same beat in the next pass is a later moment
   * and is clicked again, while two overlapping windows in the same pass still
   * cannot click one beat twice.
   */
  private scheduledCtxTo = -1;
  /**
   * The clicks already handed to the graph, and when each one is over.
   *
   * Nothing used to hold them, and the consequence was two measured bugs:
   * pressing STOP left up to a look-ahead of clicks committed to the audio
   * thread — 600 ms of clicking after the transport had stopped, measured in
   * the app — and switching the click off and straight back on re-scheduled
   * beats that were already in the graph, stacking two oscillators on one
   * beat (two moments out of ten, measured).  A click cannot be unscheduled
   * without a reference to it.
   */
  private voices: ClickVoice[] = [];
  private on = false;

  attach(ctx: AudioContextLike | null, output: AudioNode | null = null): void {
    this.silence();
    this.ctx = ctx;
    this.output = output;
    this.scheduledCtxTo = -1;
  }

  /** What the next click will connect to — the monitor path, or the speakers. */
  get destinationNode(): AudioNode | null {
    return this.output ?? this.ctx?.destination ?? null;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    // OFF means off NOW, not at the end of the look-ahead: the clicks already
    // in the graph are taken back out, or the button is a request rather than
    // a switch.
    this.silence();
    // Forget the horizon so re-enabling mid-song starts from where the
    // playhead actually is, not from where it was when it was switched off.
    // Safe because `silence` took the committed clicks with it — resetting the
    // horizon while they were still in the graph is what doubled them.
    this.scheduledCtxTo = -1;
  }

  get enabled(): boolean { return this.on; }

  setOptions(patch: Partial<MetronomeOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  /**
   * A locate or a stop happened; whatever was scheduled ahead is no longer
   * true — including the part of it the audio thread already has.
   */
  reset(): void {
    this.silence();
    this.scheduledCtxTo = -1;
  }

  /**
   * Take every click back out of the graph.
   *
   * A click that has not started yet is simply stopped before its moment and
   * is never heard.  One that is SOUNDING is faded over 5 ms instead of being
   * cut: the envelope is mid-ramp at a non-zero level, and ending a tone on a
   * step is a click of its own — silencing the metronome with a pop would be
   * a poor trade.
   */
  private silence(): void {
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    for (const v of this.voices) {
      try {
        if (v.at > now) {
          v.osc.stop(now);
        } else if (v.endsAt > now) {
          v.gain.gain.cancelScheduledValues(now);
          v.gain.gain.setValueAtTime(v.gain.gain.value, now);
          v.gain.gain.linearRampToValueAtTime(0, now + 0.005);
          v.osc.stop(now + 0.01);
        }
      } catch { /* already stopped, or a stub context in a test */ }
    }
    this.voices = [];
  }

  /** Forget the clicks that are over, so the list cannot grow all session. */
  private reapVoices(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.endsAt >= now);
  }

  /** How many clicks are in the graph right now — for the self-tests. */
  get pendingClicks(): number { return this.voices.length; }

  /**
   * Schedule the clicks of one look-ahead window.
   *
   * `originSec` is the context time that corresponds to timeline zero FOR
   * THIS WINDOW — inside a loop each pass has its own, which is why the window
   * comes in rather than being worked out here.  It is the same anchor the
   * clip player placed that window's material at, so a click and a kick on
   * the same beat are scheduled to the same context time.
   *
   * Bar positions come from the tempo map as they stand: a loop that starts on
   * beat 2 of a bar clicks a weak beat there, because the click has to agree
   * with the ruler and the bar numbers the rest of the app shows.
   */
  tick(map: TempoMap, fromSec: number, toSec: number, originSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.on) return;
    this.reapVoices();
    if (!(toSec > fromSec)) return;

    for (const click of clicksBetween(map, fromSec, toSec, this.options)) {
      const at = originSec + click.timeSec;
      // A click whose moment has already gone is dropped rather than fired
      // late: a late click is worse than a missing one.
      if (at < ctx.currentTime) continue;
      // Already scheduled — the transport ticks far more often than a beat
      // goes by, and a metronome that stacked three clicks on every beat
      // would be its own instrument.
      if (at <= this.scheduledCtxTo + 1e-9) continue;
      this.sound(ctx, at, click);
      this.scheduledCtxTo = at;
    }
  }

  /**
   * Count a take in: `beats` clicks before the transport rolls, accented every
   * `beatsPerBar`, starting at `startAtCtx`.  Returns how long it lasts.
   *
   * It is HERE, and not a second click generator next to the recorder, for
   * three reasons that were each measured first.
   *
   *   · The room.  The count-in used to be wired straight to
   *     `ctx.destination`, while the playback click goes through the control
   *     room — so MUTE, DIM, the speaker trim and the monitor level reached
   *     one click and not the other.  Rendered with MUTE engaged: the
   *     count-in came out at 0.248 peak down the destination and 0.0015
   *     through the room.  Press MUTE to take a phone call and the count-in
   *     carried on into the speakers.  Scheduling it through the same object
   *     that holds `output` makes that impossible rather than unlikely.
   *
   *   · The cancel.  Nothing held those oscillators — `scheduleCountIn`
   *     returned a duration — so no stop could reach them: rendered after
   *     every stop the app can make, the peak was unchanged.  Up to four bars
   *     of clicking, against the 600 ms the playback click used to leak.
   *     Here they are voices like any other and `reset` takes them out.
   *
   *   · The tempo.  The caller passes the beat length; `planRecording` reads
   *     it off the tempo map at the record point, which is the tempo the
   *     player is about to play.  The transport used to divide the plan's own
   *     duration by the session's opening tempo and count at that instead.
   *
   * Deliberately not gated on `enabled`: a count-in is asked for by arming
   * one, not by the click being on.  Switching the click OFF during one does
   * silence it, because OFF means off.
   */
  countIn(startAtCtx: number, beats: number, beatSec: number, beatsPerBar: number): number {
    const ctx = this.ctx;
    const n = Math.max(0, Math.floor(beats));
    const step = Math.max(1e-3, beatSec);
    if (!ctx || n === 0) return 0;
    const bar = Math.max(1, Math.floor(beatsPerBar));
    for (let i = 0; i < n; i += 1) {
      this.sound(ctx, startAtCtx + i * step, {
        timeSec: i * step, accent: i % bar === 0, weak: false,
      });
    }
    return n * step;
  }

  /** Every window of one transport tick — see `PassWindow`. */
  tickWindows(map: TempoMap, windows: readonly PassWindow[]): void {
    for (const w of windows) this.tick(map, w.fromSec, w.toSec, w.originSec);
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
    this.voices.push({ osc, gain, at, endsAt: at + 0.08 });
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
