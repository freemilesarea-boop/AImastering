// Streaming API — runtime types for the realtime analyzer bridge.
//
// Consumers:
//   • apps/desktop/src/renderer    (WASM build of loui-dsp)
//   • apps/desktop/src/main         (N-API build of loui-dsp)
//   • Future: apps/web              (WASM only)
//
// Schema URIs (each module declares its own):
//   loui.streaming.meter-snapshot.v1
//   loui.streaming.fft-frame.v1
//   loui.streaming.stereo-scope-frame.v1
//
// See docs/redesign/loui-mastering-v2/m2-lite-next/04-TS-STREAMING-API.md.

export * from './meter-snapshot.js';
export * from './fft-frame.js';
export * from './stereo-scope-frame.js';
export * from './session.js';

/** Streaming API contract semver. */
export const STREAMING_API_VERSION = '1.0.0';
