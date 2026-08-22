// Web MIDI input — the keyboard end of the wire.
//
// Two things this module is careful about, because both are easy to get wrong
// and neither is visible until a take is played back:
//
//   TIME DOMAIN.  Web MIDI stamps every message with `performance.now()`, and
//   the transport runs on `AudioContext.currentTime`.  Those are different
//   clocks with different origins and, over a long take, slightly different
//   rates.  `MidiTimebase` holds one measured pair of (performance, context)
//   readings and converts through it, so a note played at 3:20 lands at 3:20
//   instead of wherever the two clocks have drifted to.  Falling back to "now"
//   would quantise every note to the event loop.
//
//   ALL INPUTS, NOT ONE.  A player's rig is a keyboard AND a pedal AND maybe a
//   pad controller, each a separate MIDI port.  Defaulting to every port is
//   what makes a sustain pedal on its own interface work without anyone
//   configuring it; picking one port is available for the case where a piece of
//   gear is spraying clock.

import { parseMidiMessage, type CaptureEvent } from '../model/midi-capture.js';

export interface MidiInputDevice {
  id: string;
  name: string;
  manufacturer: string;
  /** Web MIDI's own connection state — a port can exist and be unplugged. */
  connected: boolean;
}

/**
 * The part of a Web MIDI input port this module touches.
 *
 * Named and exported so a test can hand `MidiInputHandle` a fake port and
 * drive the whole parse-and-dispatch path without a keyboard.
 */
export interface MidiPortLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array; timeStamp: number }) => void) | null;
}

interface WebMidiAccess {
  inputs: Map<string, MidiPortLike> | Iterable<[string, MidiPortLike]>;
  outputs?: Map<string, MidiOutPortLike> | Iterable<[string, MidiOutPortLike]>;
  onstatechange: ((event: unknown) => void) | null;
}

/**
 * The part of a Web MIDI OUTPUT port this module touches.
 *
 * Same treatment as `MidiPortLike`: named and exported so the feedback path
 * can be driven end to end against a fake desk that records what it was sent.
 */
export interface MidiOutPortLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  send: (data: number[] | Uint8Array) => void;
}

type MidiRequester = (options?: { sysex?: boolean }) => Promise<WebMidiAccess>;

function requester(): MidiRequester | null {
  const nav = globalThis.navigator as unknown as { requestMIDIAccess?: MidiRequester } | undefined;
  return nav?.requestMIDIAccess ? nav.requestMIDIAccess.bind(nav) : null;
}

/**
 * Is the API even here?
 *
 * Chromium only exposes `requestMIDIAccess` in a SECURE context — measured, not
 * assumed: an Electron window on a `data:` URL has no such function at all,
 * while the same window on `file://` does.  The app loads from `file://`
 * (packaged) or `http://localhost` (dev), both of which qualify; the selftest
 * has no navigator, so this is false there.
 */
export function isMidiSupported(): boolean {
  return requester() !== null;
}

/**
 * One access object, kept — but only when it worked.
 *
 * Asking twice is legal but pops the permission prompt again on some
 * platforms, and every call returns a different object whose `onstatechange`
 * would have to be re-hooked.  A FAILURE is not cached: the usual reason for
 * one is that the machine had no MIDI stack when the app started, and caching
 * it would mean plugging a keyboard in never worked until a restart.
 *
 * Sysex is never requested: nothing here reads it, and asking for it turns a
 * silent grant into a scary prompt.
 */
let accessPromise: Promise<WebMidiAccess> | null = null;
/** Why the last attempt failed, for a message the user can act on. */
let lastFailure: string | null = null;

export function resetMidiAccess(): void { accessPromise = null; lastFailure = null; }

/** The reason MIDI is unavailable, or null when it has not failed. */
export function midiFailureReason(): string | null { return lastFailure; }

async function midiAccess(): Promise<WebMidiAccess | null> {
  const request = requester();
  if (!request) {
    lastFailure = '이 환경에서는 Web MIDI 를 사용할 수 없습니다';
    return null;
  }
  if (!accessPromise) accessPromise = request({ sysex: false });
  try {
    const access = await accessPromise;
    lastFailure = null;
    return access;
  } catch (err) {
    accessPromise = null;
    const error = err as { name?: string; message?: string };
    lastFailure = error?.name === 'SecurityError'
      ? 'MIDI 접근이 거부되었습니다'
      : `MIDI 장치를 열 수 없습니다 (${error?.message ?? '알 수 없는 오류'})`;
    return null;
  }
}

function portsOf(access: WebMidiAccess): MidiPortLike[] {
  const out: MidiPortLike[] = [];
  const inputs = access.inputs as Iterable<[string, MidiPortLike]>;
  if (typeof (inputs as { forEach?: unknown })?.forEach === 'function') {
    (inputs as unknown as Map<string, MidiPortLike>).forEach((port) => out.push(port));
    return out;
  }
  for (const entry of inputs) out.push(entry[1]);
  return out;
}

function outPortsOf(access: WebMidiAccess): MidiOutPortLike[] {
  const out: MidiOutPortLike[] = [];
  const outputs = access.outputs;
  if (!outputs) return out;
  if (typeof (outputs as { forEach?: unknown })?.forEach === 'function') {
    (outputs as unknown as Map<string, MidiOutPortLike>).forEach((port) => out.push(port));
    return out;
  }
  for (const entry of outputs as Iterable<[string, MidiOutPortLike]>) out.push(entry[1]);
  return out;
}

export async function listMidiOutputs(): Promise<MidiInputDevice[]> {
  const access = await midiAccess();
  if (!access) return [];
  return outPortsOf(access).map((port) => ({
    id: port.id,
    name: port.name || 'MIDI 출력',
    manufacturer: port.manufacturer || '',
    connected: (port.state ?? 'connected') !== 'disconnected',
  }));
}

/**
 * Open the desk's output.
 *
 * `deviceId` null means "the one that matches the input", which is what a
 * control surface almost always is — one box with a port in each direction,
 * named the same on both.  Falling back to every output would light up a
 * synth's panel with fader positions.
 */
export async function openMidiOutput(
  deviceId: string | null, matchName?: string | null,
): Promise<MidiOutPortLike | null> {
  const access = await midiAccess();
  if (!access) return null;
  const all = outPortsOf(access);
  if (all.length === 0) return null;
  if (deviceId) return all.find((p) => p.id === deviceId) ?? null;
  if (matchName) {
    const wanted = matchName.toLowerCase();
    const byName = all.find((p) => (p.name || '').toLowerCase() === wanted);
    if (byName) return byName;
  }
  return null;
}

export async function listMidiInputs(): Promise<MidiInputDevice[]> {
  const access = await midiAccess();
  if (!access) return [];
  return portsOf(access).map((port) => ({
    id: port.id,
    name: port.name || 'MIDI 입력',
    manufacturer: port.manufacturer || '',
    connected: (port.state ?? 'connected') !== 'disconnected',
  }));
}

// ── Timebase ──────────────────────────────────────────────────────────────────

/**
 * Convert a Web MIDI timestamp into transport seconds.
 *
 * `anchorPerfMs` and `anchorCtxSec` are one instant read on both clocks, and
 * `ctxAtTransportZero` is the context time the transport's `originSec` was at.
 * Everything else is subtraction — no per-message clock reads, so a burst of
 * chord notes keeps its internal timing instead of collapsing onto one tick.
 */
export class MidiTimebase {
  constructor(
    private readonly anchorPerfMs: number,
    private readonly anchorCtxSec: number,
    private readonly ctxAtOriginSec: number,
    private readonly originSec: number,
  ) {}

  /** Transport seconds for a message stamped at `perfMs`. */
  transportSec(perfMs: number): number {
    const ctxSec = this.anchorCtxSec + (perfMs - this.anchorPerfMs) / 1000;
    return this.originSec + (ctxSec - this.ctxAtOriginSec);
  }

  /** Transport seconds right now — the fallback for an unstamped message. */
  transportSecAtContext(ctxSec: number): number {
    return this.originSec + (ctxSec - this.ctxAtOriginSec);
  }
}

/**
 * Anchor the two clocks against each other.
 *
 * `getOutputTimestamp()` reports both at the same instant and is the accurate
 * way; where it is missing (or reports nothing useful, which happens before a
 * context has rendered a quantum) the two are read back to back instead.  The
 * error in that case is one event-loop tick, once, for the whole take — not per
 * message.
 */
export function anchorTimebase(
  ctx: BaseAudioContext, ctxAtOriginSec: number, originSec: number,
): MidiTimebase {
  const perf = globalThis.performance;
  const stamp = (ctx as AudioContext).getOutputTimestamp?.();
  if (stamp && Number.isFinite(stamp.performanceTime) && (stamp.performanceTime ?? 0) > 0
    && Number.isFinite(stamp.contextTime)) {
    return new MidiTimebase(
      stamp.performanceTime as number, stamp.contextTime as number, ctxAtOriginSec, originSec);
  }
  return new MidiTimebase(perf?.now?.() ?? 0, ctx.currentTime, ctxAtOriginSec, originSec);
}

// ── Open ports ────────────────────────────────────────────────────────────────

export type MidiMessageListener = (event: CaptureEvent, raw: Uint8Array) => void;

/**
 * Everything the app has open on the MIDI side.
 *
 * The handle owns the `onmidimessage` hooks it installed and clears exactly
 * those on close, so re-opening with a different device never leaves an old
 * port feeding the listener.
 */
export class MidiInputHandle {
  private ports: MidiPortLike[];
  private listeners = new Set<MidiMessageListener>();
  private closed = false;
  /** Converts message stamps to transport time; null while not recording. */
  timebase: MidiTimebase | null = null;
  /** Used when a message has no usable timestamp. */
  fallbackSec: (() => number) | null = null;

  constructor(ports: MidiPortLike[]) {
    this.ports = ports;
    for (const port of ports) {
      port.onmidimessage = (event) => this.receive(event);
    }
  }

  get deviceCount(): number { return this.ports.length; }
  get deviceNames(): string[] { return this.ports.map((p) => p.name || p.id); }

  onMessage(listener: MidiMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(event: { data: Uint8Array; timeStamp: number }): void {
    if (this.closed) return;
    const data = event.data;
    if (!data || data.length === 0) return;
    const timeSec = this.stampToSec(event.timeStamp);
    const parsed = parseMidiMessage(data, timeSec);
    if (!parsed) return;
    for (const listener of this.listeners) listener(parsed, data);
  }

  private stampToSec(timeStamp: number): number {
    if (this.timebase && Number.isFinite(timeStamp) && timeStamp > 0) {
      return this.timebase.transportSec(timeStamp);
    }
    return this.fallbackSec?.() ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const port of this.ports) {
      try { port.onmidimessage = null; } catch { /* port already gone */ }
    }
    this.ports = [];
    this.timebase = null;
    this.fallbackSec = null;
  }
}

/**
 * Open a keyboard.  `deviceId` null means every input, which is what a rig with
 * a separate pedal box needs.
 */
export async function openMidiInputs(deviceId: string | null): Promise<MidiInputHandle> {
  const access = await midiAccess();
  if (!access) throw new Error(midiFailureReason() ?? '이 환경에서는 MIDI 입력을 사용할 수 없습니다');
  const all = portsOf(access);
  const chosen = deviceId ? all.filter((p) => p.id === deviceId) : all;
  if (chosen.length === 0) {
    throw new Error(all.length === 0
      ? 'MIDI 입력 장치를 찾을 수 없습니다'
      : '선택한 MIDI 장치를 찾을 수 없습니다');
  }
  return new MidiInputHandle(chosen);
}

/** Fire when a keyboard is plugged in or pulled out, so the list can refresh. */
export async function onMidiDevicesChanged(listener: () => void): Promise<() => void> {
  const access = await midiAccess();
  if (!access) return () => { /* nothing was hooked */ };
  const previous = access.onstatechange;
  access.onstatechange = (event) => {
    try { (previous as ((e: unknown) => void) | null)?.(event); } catch { /* ignore */ }
    listener();
  };
  return () => { access.onstatechange = previous; };
}
