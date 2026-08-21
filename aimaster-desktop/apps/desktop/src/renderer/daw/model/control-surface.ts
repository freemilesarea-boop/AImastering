// Control surfaces — a physical knob wired to something in the session.
//
// Everything here is pure.  Opening the hardware is Web MIDI's job
// (engine/midi-input.ts); this module decides what an incoming message MEANS,
// and that is where all the awkwardness of real controllers lives:
//
//   A FADER HAS A POSITION AND SO DOES THE SESSION.  They are never the same
//   when you sit down.  Grabbing a fader that reads 0 while the track sits at
//   −6 dB and having the track JUMP to unity is how a mix gets wrecked, so
//   pickup mode exists: the control does nothing until it crosses the value it
//   is about to take over, and then it has it.
//
//   AN ENCODER DOES NOT SEND A POSITION AT ALL.  It sends "one click left",
//   twice a frame, in one of two encodings that look identical on the wire.
//   Both are supported and named, because guessing produces a knob that turns
//   the wrong way and nobody can tell why.
//
//   A BUTTON SENDS TWO MESSAGES.  Press and release.  A toggle that acts on
//   both fires twice and lands back where it started.
//
//   TWO BINDINGS ON ONE KNOB IS A MISTAKE, NOT A FEATURE.  It is reported by
//   name rather than resolved silently — whichever one won would look like the
//   other one being broken.

import type { AutomationTarget, TrackId } from './types.js';
import { targetKey } from './automation.js';

// ── What the hardware sent ────────────────────────────────────────────────────

/**
 * The part of a MIDI message a control surface uses.
 *
 * Deliberately narrower than `CaptureEvent`: a surface speaks in controllers,
 * buttons and encoders, and nothing here needs a note-off's release velocity.
 */
export interface ControlMessage {
  kind: 'cc' | 'note' | 'pitchBend';
  channel: number;
  /** Controller number, or note number.  Ignored for pitch bend. */
  number: number;
  /** 0…127 for CC and note velocity; 0…16383 for bend. */
  raw: number;
  /** False for a note-off, or a CC that reads as "let go". */
  pressed: boolean;
}

// ── What it is wired to ───────────────────────────────────────────────────────

/** Where a control's messages go. */
export type ControlSource =
  /** `channel: null` means any channel — most surfaces only use one. */
  | { kind: 'cc'; channel: number | null; controller: number }
  | { kind: 'note'; channel: number | null; pitch: number }
  | { kind: 'pitchBend'; channel: number | null };

/**
 * The transport commands a button can fire.
 *
 * Only what the app actually has: there is no metronome toggle here because
 * there is no metronome, and a button that does nothing is worse than a button
 * that is missing.
 */
export type TransportCommand =
  | 'play' | 'stop' | 'record' | 'rewind' | 'toggleLoop';

export type TrackSwitch = 'mute' | 'solo' | 'recordArm';

/** What the control does when it moves. */
export type ControlAction =
  /** A continuous parameter — the same targets an automation lane can hold. */
  | { kind: 'param'; trackId: TrackId; target: AutomationTarget }
  /** A press that runs a transport command. */
  | { kind: 'transport'; command: TransportCommand }
  /** A press that flips one of a track's switches. */
  | { kind: 'trackSwitch'; trackId: TrackId; what: TrackSwitch };

/**
 * How a control's messages become values.
 *
 *   absolute  a fader or a pot: the message IS the position
 *   relative  an endless encoder: the message is a number of clicks
 *   toggle    a button that flips a switch on press
 *   trigger   a button that fires a command on press
 */
export type ControlMode = 'absolute' | 'relative' | 'toggle' | 'trigger';

/**
 * The two ways an endless encoder says "three clicks left".
 *
 *   signedBit        0x01…0x3F up, 0x41…0x7F down (bit 6 is the sign)
 *   twosComplement   1…63 up, 127…65 down
 *
 * They are indistinguishable from one message, which is why this is a setting
 * rather than something to detect.  Getting it wrong makes a knob turn the
 * wrong way at speed — the classic "my encoder is possessed" bug.
 */
export type RelativeEncoding = 'signedBit' | 'twosComplement';

/**
 * What happens the first time a physical control is moved.
 *
 *   jump    the parameter goes wherever the control is, immediately
 *   pickup  nothing happens until the control passes the parameter's current
 *           value, and only then does it take over
 */
export type Takeover = 'jump' | 'pickup';

export interface ControlBinding {
  id: string;
  source: ControlSource;
  action: ControlAction;
  mode: ControlMode;
  /** Reversed travel, for a fader mounted upside down or a knob you prefer. */
  invert: boolean;
  takeover: Takeover;
  relative: RelativeEncoding;
  /** Clicks-to-range for a relative encoder: how far one click moves it. */
  relativeStep: number;
  /** Free-text name for the physical control, so a list reads like your desk. */
  label: string;
}

export const DEFAULT_RELATIVE_STEP = 0.01;

// ── Identity ──────────────────────────────────────────────────────────────────

/** A stable string for one physical control.  `*` is the omni channel. */
export function sourceKey(source: ControlSource): string {
  const channel = source.channel === null ? '*' : String(source.channel);
  switch (source.kind) {
    case 'cc':   return `cc:${channel}:${source.controller}`;
    case 'note': return `note:${channel}:${source.pitch}`;
    default:     return `bend:${channel}`;
  }
}

/** `CC 7 · 채널 1` — what to print next to a binding. */
export function describeSource(source: ControlSource): string {
  const channel = source.channel === null ? '모든 채널' : `채널 ${source.channel + 1}`;
  switch (source.kind) {
    case 'cc':   return `CC ${source.controller} · ${channel}`;
    case 'note': return `노트 ${source.pitch} · ${channel}`;
    default:     return `피치 벤드 · ${channel}`;
  }
}

export function matchesSource(source: ControlSource, message: ControlMessage): boolean {
  if (source.channel !== null && source.channel !== message.channel) return false;
  switch (source.kind) {
    case 'cc':   return message.kind === 'cc' && message.number === source.controller;
    case 'note': return message.kind === 'note' && message.number === source.pitch;
    default:     return message.kind === 'pitchBend';
  }
}

/**
 * The binding a message belongs to.
 *
 * A binding pinned to a channel beats an omni one on the same control: someone
 * who went to the trouble of saying "channel 3" meant it, and the omni binding
 * is the fallback they set up first.
 */
export function bindingFor(
  bindings: readonly ControlBinding[], message: ControlMessage,
): ControlBinding | undefined {
  let omni: ControlBinding | undefined;
  for (const binding of bindings) {
    if (!matchesSource(binding.source, message)) continue;
    if (binding.source.channel !== null) return binding;
    omni ??= binding;
  }
  return omni;
}

/** Bindings that fight over the same physical control, grouped by that control. */
export function conflictsIn(
  bindings: readonly ControlBinding[],
): Array<{ key: string; bindings: ControlBinding[] }> {
  const byKey = new Map<string, ControlBinding[]>();
  for (const binding of bindings) {
    const key = sourceKey(binding.source);
    byKey.set(key, [...(byKey.get(key) ?? []), binding]);
  }
  return [...byKey.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, bindings: list }));
}

// ── Reading a message ─────────────────────────────────────────────────────────

/** The message's position as 0…1, before invert and before the range. */
export function normalised(message: ControlMessage): number {
  const span = message.kind === 'pitchBend' ? 16383 : 127;
  return Math.min(1, Math.max(0, message.raw / span));
}

/**
 * How far an encoder was turned, in clicks.
 *
 * Zero for a message that is not a turn — which for both encodings is the
 * value 0, the one thing neither of them can express.
 */
export function relativeClicks(raw: number, encoding: RelativeEncoding): number {
  const value = Math.round(raw) & 0x7f;
  if (value === 0) return 0;
  if (encoding === 'signedBit') {
    // Bit 6 is the sign; the low six bits are the count.
    return (value & 0x40) !== 0 ? -(value & 0x3f) : value & 0x3f;
  }
  return value <= 63 ? value : value - 128;
}

// ── Applying it ───────────────────────────────────────────────────────────────

/**
 * What a binding remembers between messages.
 *
 * Pickup needs to know whether the physical control has caught up yet, and
 * which side of the parameter it was on last time — one message on its own
 * cannot tell you that it just crossed something.
 */
export interface BindingState {
  /** True once the control has crossed the value and taken over. */
  engaged: boolean;
  /** The last normalised position seen, or null before the first message. */
  lastRaw: number | null;
}

export const INITIAL_BINDING_STATE: BindingState = { engaged: false, lastRaw: null };

/**
 * How close "already there" is, as a fraction of the control's travel.
 *
 * One step of a 7-bit controller.  Any tighter and a fader sitting exactly
 * where the parameter is would never take over, because it cannot report a
 * position between two of its own steps.
 */
export const PICKUP_TOLERANCE = 1 / 127;

export interface ValueRange {
  min: number;
  max: number;
  /** A stepped range is rounded — a choice list, or a switch. */
  stepped?: boolean;
}

export type ControlResult =
  /** Set the bound parameter to this value. */
  | { kind: 'value'; value: number; state: BindingState }
  /** Run the bound command. */
  | { kind: 'trigger'; state: BindingState }
  /** Nothing happens — a release, a still encoder, or pickup not caught up. */
  | { kind: 'ignored'; state: BindingState; reason: 'release' | 'still' | 'pickup' };

/**
 * Turn one message into one action.
 *
 * `current` is what the bound parameter reads right now, which relative mode
 * adds to and pickup mode compares against.  Pure: the caller owns the state
 * and hands back whatever comes out.
 */
export function applyBinding(
  binding: ControlBinding,
  message: ControlMessage,
  state: BindingState,
  current: number,
  range: ValueRange,
): ControlResult {
  const clamp = (v: number): number => {
    const held = Math.min(range.max, Math.max(range.min, v));
    return range.stepped ? Math.round(held) : held;
  };

  if (binding.mode === 'trigger' || binding.mode === 'toggle') {
    // A button sends press AND release; acting on both would fire twice and
    // land a toggle back where it started.
    if (!message.pressed) return { kind: 'ignored', state, reason: 'release' };
    if (binding.mode === 'trigger') return { kind: 'trigger', state };
    const on = current >= (range.min + range.max) / 2;
    return { kind: 'value', value: clamp(on ? range.min : range.max), state };
  }

  if (binding.mode === 'relative') {
    const clicks = relativeClicks(message.raw, binding.relative);
    if (clicks === 0) return { kind: 'ignored', state, reason: 'still' };
    const span = range.max - range.min;
    const step = binding.relativeStep * span * (binding.invert ? -1 : 1);
    // An encoder always has the parameter — there is no position to catch up
    // to, because it never claimed to have one.
    return {
      kind: 'value',
      value: clamp(current + clicks * step),
      state: { engaged: true, lastRaw: normalised(message) },
    };
  }

  // Absolute.
  const raw = binding.invert ? 1 - normalised(message) : normalised(message);
  const wanted = clamp(range.min + raw * (range.max - range.min));
  const next: BindingState = { engaged: state.engaged, lastRaw: raw };

  if (binding.takeover === 'jump' || state.engaged) {
    return { kind: 'value', value: wanted, state: { ...next, engaged: true } };
  }

  // Pickup: engage once the control reaches or crosses where the parameter is.
  //
  // The FIRST message has no previous position to have crossed from, so it can
  // only engage by already being there — within one step of the hardware's own
  // resolution, because a 7-bit fader physically cannot land closer than that
  // and demanding exactness would make a perfectly-placed fader dead.
  const span = range.max - range.min;
  const currentRaw = span === 0 ? 0 : (clamp(current) - range.min) / span;
  const previous = state.lastRaw;
  const crossed = previous === null
    ? Math.abs(raw - currentRaw) <= PICKUP_TOLERANCE
    : (previous - currentRaw) * (raw - currentRaw) <= 0;
  if (!crossed) return { kind: 'ignored', state: next, reason: 'pickup' };
  return { kind: 'value', value: wanted, state: { ...next, engaged: true } };
}

// ── Learning ──────────────────────────────────────────────────────────────────

/** The source a message implies, for MIDI learn. */
export function sourceOf(message: ControlMessage, omni: boolean): ControlSource {
  const channel = omni ? null : message.channel;
  if (message.kind === 'cc') return { kind: 'cc', channel, controller: message.number };
  if (message.kind === 'note') return { kind: 'note', channel, pitch: message.number };
  return { kind: 'pitchBend', channel };
}

/**
 * The mode a message implies.
 *
 * The ACTION decides first — a transport command is a press, a switch is a
 * toggle, and no amount of fader travel changes that.  For a continuous
 * parameter a note is still a button, so it toggles between the ends of the
 * range; a CC or a bend is a fader.  A CC is genuinely ambiguous (encoders
 * send CC too), and guessing "fader" is the safe half of that: an encoder read
 * as a fader jumps around, which is obvious, while a fader read as an encoder
 * creeps, which is not.
 */
export function modeFor(message: ControlMessage, action: ControlAction): ControlMode {
  if (action.kind === 'transport') return 'trigger';
  if (action.kind === 'trackSwitch') return 'toggle';
  return message.kind === 'note' ? 'toggle' : 'absolute';
}

export function createBinding(
  id: string, source: ControlSource, action: ControlAction,
  over: Partial<ControlBinding> = {},
): ControlBinding {
  return {
    id,
    source,
    action,
    mode: 'absolute',
    invert: false,
    // Pickup by default: a surface that moves the mix the instant you brush it
    // is a surface people unplug.
    takeover: 'pickup',
    relative: 'signedBit',
    relativeStep: DEFAULT_RELATIVE_STEP,
    label: '',
    ...over,
  };
}

// ── Describing ────────────────────────────────────────────────────────────────

export const TRANSPORT_LABELS: Record<TransportCommand, string> = {
  play: '재생/정지',
  stop: '정지',
  record: '녹음',
  rewind: '처음으로',
  toggleLoop: '루프 켜기/끄기',
};

export const SWITCH_LABELS: Record<TrackSwitch, string> = {
  mute: '뮤트',
  solo: '솔로',
  recordArm: '녹음 무장',
};

/** A stable key for an action, so two bindings on one thing can be spotted. */
export function actionKey(action: ControlAction): string {
  switch (action.kind) {
    case 'param':       return `param:${action.trackId}:${targetKey(action.target)}`;
    case 'transport':   return `transport:${action.command}`;
    case 'trackSwitch': return `switch:${action.trackId}:${action.what}`;
  }
}

export const MODE_LABELS: Record<ControlMode, string> = {
  absolute: '절대값 (페이더/노브)',
  relative: '상대값 (엔코더)',
  toggle: '토글 (버튼)',
  trigger: '실행 (버튼)',
};
