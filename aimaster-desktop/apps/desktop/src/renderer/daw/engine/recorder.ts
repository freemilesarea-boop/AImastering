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
import {
  DEFAULT_PATCH, clampDeviceChannels, clampPatch, describePatch, patchChannels,
  requiredChannels, type InputPatch,
} from '../model/input-channels.js';

export const RECORDER_WORKLET_URL = './daw-recorder.worklet.js';
const PROCESSOR_NAME = 'daw-recorder';

export interface InputDevice {
  id: string;
  label: string;
  isDefault: boolean;
  /**
   * How many inputs the device offers, as the browser reports it.
   *
   * `undefined` when it will not say — which is the usual answer before
   * permission has been granted, and the reason `openCapture` asks the OPEN
   * STREAM for the real number rather than trusting this.
   */
  channels?: number;
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
    .map((d, index) => {
      const out: InputDevice = {
        id: d.deviceId,
        label: d.label || `입력 ${index + 1}`,
        isDefault: d.deviceId === 'default' || d.deviceId === '',
      };
      // Some browsers expose the width here; most do not until a stream is
      // open.  Reported when present, absent otherwise — never guessed.
      const caps = (d as MediaDeviceInfo & {
        getCapabilities?: () => { channelCount?: { max?: number } };
      }).getCapabilities?.();
      const max = caps?.channelCount?.max;
      if (Number.isFinite(max)) out.channels = clampDeviceChannels(max);
      return out;
    });
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
  /**
   * Which physical input(s) of the device to record.
   *
   * The stream is opened as wide as the patch needs and the wanted channels
   * are split out of it.  Without this the recorder asked for one or two
   * channels and got the device's FIRST one or two, so a microphone in input 5
   * of an interface was simply unreachable.
   */
  patch?: InputPatch;
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

  /** Which physical input(s) this capture is reading, after clamping. */
  readonly patch: InputPatch;
  /** How wide the device actually opened. */
  readonly deviceChannels: number;

  private stream: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private node: AudioWorkletNode;
  private sink: GainNode;
  private splitter: ChannelSplitterNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private listeners = new Set<LevelListener>();
  private recording = false;
  private closed = false;

  constructor(
    ctx: AudioContext, stream: MediaStream, node: AudioWorkletNode, channels: 1 | 2,
    patch: InputPatch = DEFAULT_PATCH, deviceChannels: number = channels,
  ) {
    this.ctx = ctx;
    this.stream = stream;
    this.channels = channels;
    this.patch = patch;
    this.deviceChannels = deviceChannels;
    this.node = node;
    this.buffer = new RecordBuffer(ctx.sampleRate, channels);

    this.source = ctx.createMediaStreamSource(stream);

    // Pull the wanted channels out of the stream.  Skipped entirely when the
    // patch is already the whole stream — a splitter and merger in the path of
    // every mono microphone would be two nodes doing nothing.
    if (patch.firstChannel === 0 && deviceChannels === channels) {
      this.source.connect(node);
      this.monitorNode = this.source;
    } else {
      const splitter = ctx.createChannelSplitter(deviceChannels);
      const merger = ctx.createChannelMerger(channels);
      this.source.connect(splitter);
      patchChannels(patch).forEach((deviceChannel, out) => {
        splitter.connect(merger, deviceChannel, out);
      });
      merger.connect(node);
      this.splitter = splitter;
      this.merger = merger;
      // Monitoring hears the SAME channels that are recorded.  Handing back
      // the raw source would let somebody listen to input 1 while recording
      // input 5 and never know which one was wrong.
      this.monitorNode = merger;
    }

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
  /** `입력 3/4` — what this capture is actually listening to. */
  get patchLabel(): string { return describePatch(this.patch); }

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
    try { this.splitter?.disconnect(); } catch { /* ignore */ }
    try { this.merger?.disconnect(); } catch { /* ignore */ }
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
  const processing = options.processing ?? false;

  // The patch decides everything.  `channels` survives as the old way of
  // saying "mono or stereo from the front of the device", which is what every
  // existing caller meant.
  const wanted: InputPatch = options.patch
    ?? { firstChannel: 0, channels: options.channels ?? DEFAULT_PATCH.channels };

  const constraints: MediaStreamConstraints = {
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      // Ask for everything up to the last channel the patch needs.  `ideal`
      // rather than `exact`: a device that cannot go that wide should still
      // open at whatever it has, and the patch is then held inside the real
      // width below — refusing to open at all would be a worse answer than
      // recording input 1.
      channelCount: { ideal: requiredChannels(wanted) },
      // Echo cancellation and AGC are built for conference calls; they would
      // gate a quiet performance and duck a loud one.
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: processing,
    },
  };

  const stream = await media.getUserMedia(constraints);
  try {
    // What the device ACTUALLY gave us, which is often not what was asked for.
    const settings = stream.getAudioTracks()[0]?.getSettings?.() as
      { channelCount?: number } | undefined;
    const streamChannels = clampDeviceChannels(settings?.channelCount);
    const patch = clampPatch(wanted, streamChannels);
    const channels = patch.channels;

    await ensureWorklet(ctx);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: { channels },
    });
    return new InputCapture(ctx, stream, node, channels, patch, streamChannels);
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
