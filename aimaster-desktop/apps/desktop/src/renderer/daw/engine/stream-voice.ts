// One playing clip, streamed off disk.
//
// The pieces are: a ring in shared memory, a reader Worker filling it from the
// PCM store, and an AudioWorkletNode on the audio thread emptying it.  What
// comes back looks like any other source node - it connects into the same gain
// stage, with the same clip gain and the same fade curves - so nothing
// downstream knows or cares where the samples came from.
//
// Falls back to null whenever any piece is missing (no SharedArrayBuffer, no
// worklet module, no store entry).  The caller then schedules the clip from a
// resident buffer exactly as before: streaming is an optimisation, never a
// requirement for the audio to play.

import {
  canShareMemory, createRing, endFrame, setEndFrame, underruns, type Ring,
} from './ring-buffer.js';
import type { PcmSource } from './pcm-store.js';

/** Ring size, in frames. Two seconds at 48 kHz - the reader needs ~6 ms. */
const RING_SECONDS = 2;
/** Frames of audio the ring must hold before a voice is worth starting. */
const PREROLL_FRAMES = 8192;

export interface StreamVoice {
  node: AudioWorkletNode;
  ring: Ring;
  /** Frames the audio thread wanted and did not have, for diagnostics. */
  underruns(): number;
  stop(): void;
}

export const STREAM_WORKLET_URL = './daw-stream.worklet.js';
export const READER_WORKER_URL = './daw-reader.worker.js';

let modulePromise: Promise<boolean> | null = null;
let reader: Worker | null = null;
let nextVoiceId = 1;

/**
 * Start the reader thread.
 *
 * Through a blob rather than the URL directly: Chromium refuses `new Worker()`
 * on a `file://` document, which is exactly what a packaged build is.  Fetching
 * the source and constructing from a blob works under the dev server and the
 * packaged app alike, and the worker keeps its own file on disk so it is still
 * readable and debuggable.
 */
async function spawnReader(): Promise<Worker> {
  const resp = await fetch(READER_WORKER_URL);
  if (!resp.ok) throw new Error(`reader worker 를 읽지 못했습니다 (${resp.status})`);
  const blob = new Blob([await resp.text()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** True once the worklet module and the reader thread are both available. */
export async function ensureStreamRuntime(ctx: BaseAudioContext): Promise<boolean> {
  if (!canShareMemory()) return false;
  if (typeof AudioWorkletNode === 'undefined' || !('audioWorklet' in ctx)) return false;

  modulePromise ??= (async () => {
    try {
      // Relative, like the recorder worklet: the renderer is served from a dev
      // server in development and from file:// in a packaged build, and only a
      // relative URL resolves under both.
      await (ctx as AudioContext).audioWorklet.addModule(STREAM_WORKLET_URL);
      reader = await spawnReader();
      reader.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
        if (e.data?.type === 'error') {
          // eslint-disable-next-line no-console
          console.warn('[stream] reader:', e.data.message);
        }
      };
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn('[stream] 스트리밍을 사용할 수 없어 버퍼 재생으로 돌아갑니다 —', reason);
      return false;
    }
  })();

  return modulePromise;
}

/** True when a voice can be created right now, with no awaiting. */
export function streamRuntimeReady(): boolean {
  return reader !== null;
}

export interface StreamVoiceOptions {
  /** Context time the clip should be heard at. */
  startAtSec: number;
  /** First source frame to play. */
  offsetFrames: number;
  /** How many source frames to play. */
  durationFrames: number;
}

/**
 * Build a streaming voice, or null when the runtime is not ready.
 *
 * Nothing here waits: the ring is handed to the reader and to the worklet in
 * the same turn, and the worklet outputs silence until its start frame, so a
 * voice scheduled a second ahead has that whole second to fill.
 */
export function createStreamVoice(
  ctx: BaseAudioContext, source: PcmSource, options: StreamVoiceOptions,
): StreamVoice | null {
  if (!reader) return null;

  const { startAtSec, offsetFrames, durationFrames } = options;
  if (durationFrames <= 0) return null;

  const capacityFrames = Math.max(
    PREROLL_FRAMES * 2, Math.ceil(RING_SECONDS * source.sampleRate),
  );
  const ring = createRing(capacityFrames, source.channels);
  const last = Math.min(source.frames, offsetFrames + durationFrames);
  setEndFrame(ring, last);

  const id = nextVoiceId++;
  reader.postMessage({
    type: 'open',
    id,
    url: source.url,
    control: ring.control.buffer,
    data: ring.data.buffer,
    capacityFrames,
    channels: source.channels,
    startFrame: Math.max(0, offsetFrames),
    endFrame: last,
  });

  const node = new AudioWorkletNode(ctx as AudioContext, 'daw-stream-clip', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    // Always stereo out: a mono source is fanned to both, which is what an
    // AudioBufferSourceNode feeding a stereo channel strip already does.
    outputChannelCount: [2],
    processorOptions: {
      control: ring.control.buffer,
      data: ring.data.buffer,
      capacityFrames,
      channels: source.channels,
      startFrame: Math.round(startAtSec * ctx.sampleRate),
      durationFrames: last - Math.max(0, offsetFrames),
    },
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    reader?.postMessage({ type: 'close', id });
    try { node.port.postMessage({ type: 'stop' }); } catch { /* already gone */ }
    try { node.disconnect(); } catch { /* already disconnected */ }
  };

  // The processor retires itself at the end of the clip; release the reader
  // slot then rather than waiting for the transport to stop.
  node.port.onmessage = (e: MessageEvent<{ type?: string }>) => {
    if (e.data?.type === 'ended') close();
  };

  return {
    node,
    ring,
    underruns: () => underruns(ring),
    stop: close,
  };
}

/** Frames still to be read before the source runs out - for tests. */
export function remainingFrames(voice: StreamVoice): number {
  return endFrame(voice.ring);
}

/** Shut the reader thread down (session close, tests). */
export function closeStreamRuntime(): void {
  reader?.terminate();
  reader = null;
  modulePromise = null;
}
