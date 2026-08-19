// Input capture — microphone in, samples out.
//
// The chain is: getUserMedia → MediaStreamAudioSourceNode → the recorder
// worklet (a sink) and, when monitoring is on, the armed track's channel input
// so the player hears themselves through their own inserts.
//
// The worklet is used for capture only.  It reads the signal and posts copies;
// it never sits between anything, so the "native nodes only" rule that keeps
// live and offline renders identical is untouched.

import { RecordBuffer } from './record-buffer.js';

export const RECORDER_WORKLET_URL = './daw-recorder.worklet.js';
const PROCESSOR_NAME = 'daw-recorder';

export interface InputDevice {
  id: string;
  label: string;
  isDefault: boolean;
}

/**
 * Available inputs.  Labels are empty until permission has been granted once —
 * that is a browser rule, not something to work around, so the UI shows a
 * placeholder rather than pretending to know the name.
 */
export async function listInputDevices(): Promise<InputDevice[]> {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.enumerateDevices) return [];
  const devices = await media.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, index) => ({
      id: d.deviceId,
      label: d.label || `입력 ${index + 1}`,
      isDefault: d.deviceId === 'default' || d.deviceId === '',
    }));
}

/** Ask once so the labels become readable; returns false if refused. */
export async function requestInputPermission(): Promise<boolean> {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia) return false;
  try {
    const stream = await media.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

export interface CaptureOptions {
  deviceId?: string | null;
  channels?: 1 | 2;
  /** Browser cleanup is for calls, not for records.  All off by default. */
  processing?: boolean;
}

const moduleLoaded = new WeakSet<BaseAudioContext>();

async function ensureWorklet(ctx: BaseAudioContext): Promise<void> {
  if (moduleLoaded.has(ctx)) return;
  const worklet = (ctx as AudioContext).audioWorklet;
  if (!worklet) throw new Error('이 환경에서는 AudioWorklet 을 사용할 수 없습니다');
  await worklet.addModule(RECORDER_WORKLET_URL);
  moduleLoaded.add(ctx);
}

export type LevelListener = (peak: number) => void;

/**
 * One open input.  Construct with `openCapture`, connect `monitorNode` to a
 * channel to hear it, call `start()` / `stop()` around the take.
 */
export class InputCapture {
  readonly ctx: AudioContext;
  readonly channels: 1 | 2;
  readonly buffer: RecordBuffer;
  /** Connect this to hear the input.  Never connected on your behalf. */
  readonly monitorNode: AudioNode;

  private stream: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private node: AudioWorkletNode;
  private sink: GainNode;
  private listeners = new Set<LevelListener>();
  private recording = false;
  private closed = false;

  constructor(ctx: AudioContext, stream: MediaStream, node: AudioWorkletNode, channels: 1 | 2) {
    this.ctx = ctx;
    this.stream = stream;
    this.channels = channels;
    this.node = node;
    this.buffer = new RecordBuffer(ctx.sampleRate, channels);

    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(node);
    this.monitorNode = this.source;

    // A worklet with no destination is not guaranteed to be pulled, so the
    // tap terminates in a silent gain node rather than nowhere.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    node.connect(this.sink).connect(ctx.destination);

    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; peak?: number; channels?: Float32Array[] };
      if (data.type === 'level') {
        for (const listener of this.listeners) listener(data.peak ?? 0);
      } else if (data.type === 'chunk' && data.channels) {
        if (this.recording) this.buffer.push(data.channels);
      }
    };
  }

  get isRecording(): boolean { return this.recording; }
  get sampleRate(): number { return this.ctx.sampleRate; }

  onLevel(listener: LevelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.closed) return;
    this.buffer.clear();
    this.recording = true;
    this.node.port.postMessage({ type: 'start' });
  }

  /** Stop capturing and return what was caught. */
  stop(): RecordBuffer {
    this.recording = false;
    this.node.port.postMessage({ type: 'stop' });
    return this.buffer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.recording = false;
    this.listeners.clear();
    try { this.node.port.postMessage({ type: 'reset' }); } catch { /* already gone */ }
    try { this.source.disconnect(); } catch { /* ignore */ }
    try { this.node.disconnect(); } catch { /* ignore */ }
    try { this.sink.disconnect(); } catch { /* ignore */ }
    for (const track of this.stream.getTracks()) track.stop();
  }
}

export async function openCapture(
  ctx: AudioContext, options: CaptureOptions = {},
): Promise<InputCapture> {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia) throw new Error('이 환경에서는 오디오 입력을 사용할 수 없습니다');
  const channels = options.channels ?? 1;
  const processing = options.processing ?? false;

  const constraints: MediaStreamConstraints = {
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      channelCount: channels,
      // Echo cancellation and AGC are built for conference calls; they would
      // gate a quiet performance and duck a loud one.
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: processing,
    },
  };

  const stream = await media.getUserMedia(constraints);
  try {
    await ensureWorklet(ctx);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: { channels },
    });
    return new InputCapture(ctx, stream, node, channels);
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    throw err;
  }
}

// ── Count-in click ────────────────────────────────────────────────────────────

export interface ClickOptions {
  tempoBpm: number;
  beatsPerBar: number;
  bars: number;
  /** Context time to start the first click. */
  when: number;
  accentHz?: number;
  beatHz?: number;
  gain?: number;
}

/**
 * Schedule count-in clicks with plain oscillators — no samples to load, and
 * sample-accurate because the whole pattern is scheduled up front.
 * Returns the total length in seconds.
 */
export function scheduleCountIn(
  ctx: BaseAudioContext, destination: AudioNode, options: ClickOptions,
): number {
  const { tempoBpm, beatsPerBar, bars, when } = options;
  const accentHz = options.accentHz ?? 1600;
  const beatHz = options.beatHz ?? 1000;
  const level = options.gain ?? 0.25;
  const beat = 60 / Math.max(1, tempoBpm);
  const total = Math.max(0, bars) * Math.max(1, beatsPerBar);

  for (let i = 0; i < total; i++) {
    const at = when + i * beat;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = i % beatsPerBar === 0 ? accentHz : beatHz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    osc.connect(gain).connect(destination);
    osc.start(at);
    osc.stop(at + 0.08);
  }
  return total * beat;
}

export { RecordBuffer };
