// Sending the session BACK to the desk.
//
// A control surface with no feedback is a set of knobs that lie.  The fader
// sits where you left it while the track sits somewhere else; the mute button
// is dark on a muted track; switch banks and every control on the desk is
// describing the previous eight tracks.  So the session has to be pushed out
// as well as read in.
//
// The whole difficulty is the LOOP.  Send a fader position out, the desk moves
// its motor, the motor sends the position back in, and that sets the
// parameter — which sends it out again.  Left alone that is either a hum of
// traffic or, worse, a slow drift as 7-bit rounding walks the value down.
//
// The rule that stops it, and the reason everything here is built around a
// snapshot: NOTHING IS SENT THAT THE DESK IS ALREADY SHOWING.  Feedback is a
// diff against what was last transmitted, compared in the 7-bit domain the
// wire actually carries — so a value that comes back and lands on the same
// MIDI byte produces no second send, and the loop closes after one message.
//
// The second rule: FEEDBACK NEVER CHANGES THE SESSION.  It is output only.
// A parameter set to −4.23 dB by the mouse is not re-quantised to whatever a
// 7-bit fader can express just because the fader was told about it.

import type { DawSession } from './types.js';
import type {
  ControlAction, ControlBinding, ControlSource, ValueRange,
} from './control-surface.js';

/** Transport lamps — the state a play or record button should be showing. */
export interface TransportLights {
  playing: boolean;
  recording: boolean;
  loop: boolean;
}

export const DARK_TRANSPORT: TransportLights = {
  playing: false, recording: false, loop: false,
};

/**
 * What a bound control should be showing, as 0…1.
 *
 * Null means "this control cannot show anything", which is a real answer:
 * an endless encoder has no position to move to, and a rewind button has no
 * state to light.  Saying so is what keeps the driver from inventing one.
 */
export function feedbackLevel(
  binding: ControlBinding,
  action: ControlAction,
  current: number,
  range: ValueRange,
  lights: TransportLights,
): number | null {
  if (binding.mode === 'relative') {
    // An encoder never claimed to have a position, so there is nothing to
    // send it back.  A surface with LED rings addresses those separately.
    return null;
  }

  if (action.kind === 'transport') {
    switch (action.command) {
      case 'play':       return lights.playing ? 1 : 0;
      case 'record':     return lights.recording ? 1 : 0;
      case 'toggleLoop': return lights.loop ? 1 : 0;
      // Stop and rewind are momentary: they are not a state the desk can be
      // wrong about, so lighting them would be decoration that then has to
      // be turned off again.
      case 'stop':
      case 'rewind':     return null;
    }
  }

  const span = range.max - range.min;
  if (span <= 0) return null;
  const held = Math.min(range.max, Math.max(range.min, current));
  const level = (held - range.min) / span;
  return binding.invert ? 1 - level : level;
}

/** 0…1 as the wire carries it: 7 bits, or 14 for pitch bend. */
export function quantise(source: ControlSource, level: number): number {
  const held = Math.min(1, Math.max(0, level));
  return source.kind === 'pitchBend'
    ? Math.round(held * 16383)
    : Math.round(held * 127);
}

/**
 * The MIDI bytes for one control, or null when it cannot be addressed.
 *
 * A binding whose source is on "any channel" has no channel to send on —
 * omni is a receive-side idea, and picking one silently would light the wrong
 * button on a two-channel desk.  Channel 1 is used, because that is what
 * every surface that only listens on one uses, and the alternative is
 * refusing to give feedback to the most common setup there is.
 */
export function encodeFeedback(
  source: ControlSource, raw: number,
): number[] | null {
  const channel = (source.channel ?? 0) & 0x0f;
  switch (source.kind) {
    case 'cc':
      return [0xb0 | channel, source.controller & 0x7f, raw & 0x7f];
    case 'note':
      // Note-on with velocity zero rather than note-off: every surface
      // understands it as "lamp off", and some only understand it that way.
      return [0x90 | channel, source.pitch & 0x7f, raw & 0x7f];
    case 'pitchBend':
      return [0xe0 | channel, raw & 0x7f, (raw >> 7) & 0x7f];
    default:
      return null;
  }
}

export interface FeedbackMessage {
  bindingId: string;
  /** Identifies the physical control, so two bindings on one knob collapse. */
  sourceKey: string;
  bytes: number[];
  /** The quantised value, kept so the next diff can skip an unchanged send. */
  raw: number;
}

/** What the desk is currently showing, keyed by control. */
export type SurfaceSnapshot = Map<string, number>;

export interface FeedbackInput {
  bindings: readonly ControlBinding[];
  session: DawSession;
  lights: TransportLights;
  /** What the bound thing reads — the same answer the input path uses. */
  valueOf: (session: DawSession, action: ControlAction) => number;
  rangeOf: (session: DawSession, action: ControlAction) => ValueRange;
  /** Key for a source, shared with the binding table so the two agree. */
  keyOf: (source: ControlSource) => string;
}

/**
 * Everything the desk should be told, given what it is already showing.
 *
 * `shown` is updated in place by the caller from the returned messages — not
 * here, because a send can fail and a snapshot that recorded a message the
 * port never took would leave that control stale until its value happened to
 * change again.
 */
export function feedbackDiff(input: FeedbackInput, shown: SurfaceSnapshot): FeedbackMessage[] {
  const out: FeedbackMessage[] = [];
  const seen = new Set<string>();

  for (const binding of input.bindings) {
    const key = input.keyOf(binding.source);
    // Two bindings on one control is a mistake the binding table reports; here
    // it must not become two messages fighting over one lamp, so the first
    // wins and the rest are dropped.
    if (seen.has(key)) continue;

    const range = input.rangeOf(input.session, binding.action);
    const current = input.valueOf(input.session, binding.action);
    const level = feedbackLevel(binding, binding.action, current, range, input.lights);
    if (level === null) continue;

    const raw = quantise(binding.source, level);
    seen.add(key);
    // The comparison that closes the loop: in the 7-bit domain the wire
    // carries, not in the parameter's own units.
    if (shown.get(key) === raw) continue;

    const bytes = encodeFeedback(binding.source, raw);
    if (!bytes) continue;
    out.push({ bindingId: binding.id, sourceKey: key, bytes, raw });
  }

  return out;
}

/**
 * Forget what the desk was showing.
 *
 * Called when the surface is re-opened or a bank is switched: the hardware
 * may have been unplugged, powered off, or is now describing eight different
 * tracks, so every control is re-sent rather than assumed correct.
 */
export function resetSnapshot(shown: SurfaceSnapshot): void { shown.clear(); }

/** Record what actually went out. */
export function noteSent(shown: SurfaceSnapshot, messages: readonly FeedbackMessage[]): void {
  for (const message of messages) shown.set(message.sourceKey, message.raw);
}

/**
 * Turn every lamp off and every motor to zero.
 *
 * Sent when feedback is switched off or the app closes: a desk left lit for a
 * session that is no longer open is worse than a dark one, because it looks
 * live.
 */
export function blackout(
  bindings: readonly ControlBinding[], keyOf: (source: ControlSource) => string,
): FeedbackMessage[] {
  const out: FeedbackMessage[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (binding.mode === 'relative') continue;
    const key = keyOf(binding.source);
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = encodeFeedback(binding.source, 0);
    if (!bytes) continue;
    out.push({ bindingId: binding.id, sourceKey: key, bytes, raw: 0 });
  }
  return out;
}
