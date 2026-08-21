// Wiring a control surface message into the session.
//
// The model (model/control-surface.ts) decides what a message means in the
// abstract; this is where "means" becomes "the send B level is now −4.2 dB".
// It exists as its own file for the same reason the automation writers do:
// three things need exactly the same answer for "what does this control read
// right now", and any disagreement between them shows up as a fader that
// fights the desk.

import {
  applyBinding, INITIAL_BINDING_STATE,
  type BindingState, type ControlAction, type ControlBinding, type ControlMessage,
  type TransportCommand, type ValueRange,
} from '../model/control-surface.js';
import { clampToRange, laneRange, setStaticValue, staticValue } from './automation-lanes.js';
import { setRecordArm } from '../model/recording.js';
import { toggleMute, toggleSolo } from '../model/mixer-math.js';
import { findTrack } from '../model/session-ops.js';
import type { CaptureEvent } from '../model/midi-capture.js';
import type { DawSession } from '../model/types.js';

/**
 * A captured MIDI event as a surface message.
 *
 * Note-offs are kept rather than dropped — a button binding needs to see the
 * release in order to ignore it deliberately, and the difference between
 * "ignored the release" and "never saw it" matters when a toggle would
 * otherwise fire twice.  Everything a desk does not send (aftertouch, program
 * change) returns null.
 */
export function toControlMessage(event: CaptureEvent): ControlMessage | null {
  switch (event.kind) {
    case 'cc':
      return {
        kind: 'cc', channel: event.channel, number: event.controller,
        raw: Math.round(event.value * 127),
        // A button wired to a CC sends 127 down and 0 up.  A fader at zero is
        // also 0, but a fader binding never reads `pressed`.
        pressed: event.value > 0,
      };
    case 'noteOn':
      return {
        kind: 'note', channel: event.channel, number: event.pitch,
        raw: Math.round(event.velocity * 127), pressed: true,
      };
    case 'noteOff':
      return {
        kind: 'note', channel: event.channel, number: event.pitch,
        raw: 0, pressed: false,
      };
    case 'pitchBend':
      return {
        kind: 'pitchBend', channel: event.channel, number: 0,
        raw: Math.round((event.value + 1) * 8191.5), pressed: true,
      };
    default:
      return null;
  }
}

const SWITCH_RANGE: ValueRange = { min: 0, max: 1, stepped: true };

/** What the bound thing reads right now — what pickup and relative need. */
export function currentValueOf(session: DawSession, action: ControlAction): number {
  if (action.kind === 'transport') return 0;
  const track = findTrack(session, action.trackId);
  if (!track) return 0;
  if (action.kind === 'param') return staticValue(track, action.target);
  switch (action.what) {
    case 'mute':      return track.mute ? 1 : 0;
    case 'solo':      return track.solo ? 1 : 0;
    case 'recordArm': return track.recordArm ? 1 : 0;
  }
}

/** The range the bound thing lives in — the same one the lane UI draws. */
export function rangeOf(session: DawSession, action: ControlAction): ValueRange {
  if (action.kind !== 'param') return SWITCH_RANGE;
  const track = findTrack(session, action.trackId);
  if (!track) return { min: 0, max: 1 };
  const range = laneRange(track, action.target);
  return { min: range.min, max: range.max, stepped: range.stepped };
}

export interface ControlOutcome {
  session: DawSession;
  state: BindingState;
  /** Set when the binding is a transport button and it was pressed. */
  command: TransportCommand | null;
  /** What the parameter was set to, for the UI to flash.  Null when nothing moved. */
  value: number | null;
  /** Why nothing happened, when nothing happened. */
  ignored: 'release' | 'still' | 'pickup' | 'missing' | null;
}

/**
 * Run one message through one binding.
 *
 * The session goes in and comes out; the caller applies it as ONE edit, so a
 * fader move is one undo step rather than one per MIDI message — a fader sends
 * a hundred of them a second.
 */
export function applyControl(
  session: DawSession,
  binding: ControlBinding,
  message: ControlMessage,
  state: BindingState = INITIAL_BINDING_STATE,
): ControlOutcome {
  const still = (
    ignored: ControlOutcome['ignored'], next: BindingState = state,
  ): ControlOutcome => ({ session, state: next, command: null, value: null, ignored });

  if (binding.action.kind !== 'transport' && !findTrack(session, binding.action.trackId)) {
    // The track the desk is wired to has been deleted.  Silently doing nothing
    // would look like a broken fader, so the caller is told which it was.
    return still('missing');
  }

  const range = rangeOf(session, binding.action);
  const current = currentValueOf(session, binding.action);
  const result = applyBinding(binding, message, state, current, range);

  if (result.kind === 'ignored') return still(result.reason, result.state);
  if (result.kind === 'trigger') {
    return {
      session, state: result.state, value: null, ignored: null,
      command: binding.action.kind === 'transport' ? binding.action.command : null,
    };
  }

  const value = result.value;
  const next = writeValue(session, binding.action, value);
  return { session: next, state: result.state, command: null, value, ignored: null };
}

function writeValue(
  session: DawSession, action: ControlAction, value: number,
): DawSession {
  if (action.kind === 'transport') return session;
  if (action.kind === 'param') {
    const track = findTrack(session, action.trackId);
    if (!track) return session;
    return setStaticValue(
      session, action.trackId, action.target,
      clampToRange(laneRange(track, action.target), value));
  }
  // A switch is a switch: only cross the middle, and use the session's own
  // togglers so solo keeps its exclusivity rules and mute keeps its groups.
  const on = value >= 0.5;
  const track = findTrack(session, action.trackId);
  if (!track) return session;
  switch (action.what) {
    case 'mute':      return track.mute === on ? session : toggleMute(session, action.trackId);
    case 'solo':      return track.solo === on ? session : toggleSolo(session, action.trackId);
    case 'recordArm': return setRecordArm(session, action.trackId, on);
  }
}
