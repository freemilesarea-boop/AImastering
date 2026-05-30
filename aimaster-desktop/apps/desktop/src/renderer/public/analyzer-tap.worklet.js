// analyzer-tap.worklet.js — minimal AudioWorklet that forwards input
// audio blocks to the main thread for WASM analysis.
//
// Design
// ────────────────────────────────────────────────────────────────────────
//   * Audio thread does ONLY a memcpy (input → ArrayBuffer) plus a
//     port.postMessage call (cheap).  No analysis on the audio thread.
//   * Main thread holds the WASM analyzer and processes blocks as they
//     arrive (see wasm-analyzer-session.ts).
//   * Output is a passthrough so playback continues normally — this is
//     a "tap", not a sink.
//
// Plain JavaScript by design (no TS).  Vite's `new URL(...)` import
// pattern emits this file as an opaque static asset, so it must be
// directly runnable in AudioWorkletGlobalScope without bundling.
//
// Realtime-safety contract
//   * Zero allocation per `process()` call in the steady state.  The
//     ArrayBuffer payloads are transferred ownership (zero-copy from
//     audio thread to main thread).
//   * port.postMessage with `Transferable[]` does NOT block.
//   * No `await`, no `Promise`, no exceptions.
//
// Wire protocol
//   * Worklet → main:  { left: Float32Array, right?: Float32Array }
//   * Main → worklet:  reserved for future control messages (none yet).

/* global registerProcessor, AudioWorkletProcessor, sampleRate */
/* eslint-disable */

class AnalyzerTap extends AudioWorkletProcessor {
  constructor() {
    super();
    // Sequence number for debugging / drop-detection on the main side.
    this._seq = 0;
  }

  /**
   * inputs[0] is the connected audio source.  WebAudio gives 128 samples
   * per quantum — we forward each block individually.  No buffering;
   * letting the main thread aggregate as needed.
   */
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Audio-thread passthrough: copy input → output so playback continues.
    // We do this even when no input is connected (silent output).
    if (input && input.length > 0) {
      const channels = Math.min(input.length, output.length);
      for (let c = 0; c < channels; c++) {
        const inCh = input[c];
        const outCh = output[c];
        if (inCh && outCh && inCh.length === outCh.length) {
          outCh.set(inCh);
        }
      }
    }

    // Forward planar input to main thread.  AudioWorklet reuses these
    // Float32Array buffers, so we MUST copy before transferring (transfer
    // semantics would invalidate the worklet's own input arrays).
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      const len = input[0].length;
      const left = new Float32Array(len);
      left.set(input[0]);

      let right = null;
      if (input.length > 1 && input[1] && input[1].length === len) {
        right = new Float32Array(len);
        right.set(input[1]);
      }

      const payload = right
        ? { left, right, seq: this._seq++ }
        : { left, seq: this._seq++ };

      const transferables = right
        ? [left.buffer, right.buffer]
        : [left.buffer];

      this.port.postMessage(payload, transferables);
    }

    // Returning true keeps the worklet alive across renders.
    return true;
  }
}

registerProcessor('analyzer-tap', AnalyzerTap);
