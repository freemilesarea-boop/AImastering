// The process that runs other people's code.
//
// Separate from the app on purpose.  A third-party plugin is a binary written
// by someone else, and a bad one segfaults.  If that happens in this process,
// one bounce fails with a message; if it happened in main, the session goes
// with it.  Process isolation is not a nicety here — it is the difference
// between "that plugin does not work" and "I lost my session".
//
// Everything is file-based: the job names an input and an output, so a
// four-minute stereo track never crosses a process boundary as a message.
//
// ── Where a real adapter goes ──────────────────────────────────────────────
// `ADAPTERS` below maps a format to something that can process a block.  Only
// `reference` is implemented — a device this app defines, used to prove the
// pipeline end to end.  Adding VST3 or AU means adding an entry that calls
// into a native module; nothing else in this file, or above it, changes.
//
// A real format with no adapter is REFUSED rather than passed through.  A
// plugin that silently does nothing is worse than one that does not load: you
// would spend an afternoon wondering why your compressor has no effect.

import fs from 'node:fs';
import {
  isImplemented, type HostJob, type HostResult, type HostStage, type HostStageReport,
} from './host-protocol.js';

/** Processes audio in place.  Interleaved, `frames * channels` samples. */
type Adapter = (
  samples: Float32Array, frames: number, channels: number, sampleRate: number,
  stage: HostStage,
) => void;

/**
 * The reference device.
 *
 * Its job is to be unmistakably itself: a gain in decibels and an optional
 * phase invert, both trivially checkable from a rendered file.  That is what
 * makes it useful for proving the pipeline — if the output is 6 dB down and
 * upside down, then the samples really did leave the renderer, cross into
 * another process, get processed, and come back.
 */
const referenceAdapter: Adapter = (samples, frames, channels, _sampleRate, stage) => {
  const gainDb = stage.params['gainDb'] ?? 0;
  const invert = (stage.params['invert'] ?? 0) >= 0.5 ? -1 : 1;
  const gain = Math.pow(10, gainDb / 20) * invert;
  if (gain === 1) return;
  const total = frames * channels;
  for (let i = 0; i < total; i++) samples[i] = samples[i]! * gain;
};

const ADAPTERS: Partial<Record<HostStage['format'], Adapter>> = {
  reference: referenceAdapter,
  // vst3: nativeVst3Adapter,   ← one entry, once the native module exists
  // au:   nativeAudioUnitAdapter,
};

export function runJob(job: HostJob): HostResult {
  const stages: HostStageReport[] = [];

  let samples: Float32Array;
  try {
    const bytes = fs.readFileSync(job.inputPath);
    const expected = job.frames * job.channels * 4;
    if (bytes.byteLength < expected) {
      return {
        ok: false,
        error: `입력이 잘려 있습니다 (${bytes.byteLength} < ${expected})`,
        stages,
      };
    }
    // A view, not a copy: this is the whole track.
    samples = new Float32Array(
      bytes.buffer, bytes.byteOffset, job.frames * job.channels,
    );
  } catch (err) {
    return { ok: false, error: `입력을 읽지 못했습니다: ${String(err)}`, stages };
  }

  for (const stage of job.chain) {
    if (stage.bypass) {
      stages.push({ pluginId: stage.pluginId, name: stage.name, applied: false, reason: '바이패스' });
      continue;
    }
    if (!isImplemented(stage.format)) {
      stages.push({
        pluginId: stage.pluginId,
        name: stage.name,
        applied: false,
        reason: `${stage.format.toUpperCase()} 어댑터가 아직 없습니다`,
      });
      continue;
    }
    const adapter = ADAPTERS[stage.format];
    if (!adapter) {
      stages.push({
        pluginId: stage.pluginId, name: stage.name, applied: false, reason: '어댑터 없음',
      });
      continue;
    }
    try {
      adapter(samples, job.frames, job.channels, job.sampleRate, stage);
      stages.push({ pluginId: stage.pluginId, name: stage.name, applied: true });
    } catch (err) {
      // One bad plugin fails its own stage; the rest of the chain still runs.
      stages.push({
        pluginId: stage.pluginId, name: stage.name, applied: false, reason: String(err),
      });
    }
  }

  try {
    fs.writeFileSync(job.outputPath, Buffer.from(
      samples.buffer, samples.byteOffset, samples.byteLength,
    ));
  } catch (err) {
    return { ok: false, error: `결과를 쓰지 못했습니다: ${String(err)}`, stages };
  }

  return { ok: true, frames: job.frames, stages };
}

// ── Child-process entry ─────────────────────────────────────────────────────
// Only when forked.  Importing this module (as the tests do) runs nothing.

if (typeof process !== 'undefined' && typeof process.send === 'function') {
  process.on('message', (message: unknown) => {
    const job = message as HostJob;
    let result: HostResult;
    try {
      result = runJob(job);
    } catch (err) {
      result = { ok: false, error: String(err), stages: [] };
    }
    process.send?.({ id: job.id, result });
  });
}
