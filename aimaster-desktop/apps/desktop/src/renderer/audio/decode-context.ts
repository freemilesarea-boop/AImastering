// One decode context for the whole app.
//
// `decodeAudioData` needs A context, not a RUNNING one: Chromium decodes off
// the main thread and hands back a detached AudioBuffer, so a suspended
// AudioContext is enough and no user gesture is required.  That is what the
// mastering screen has always done.
//
// It must be a LIVE AudioContext.  A one-frame `OfflineAudioContext(1, 1, sr)`
// also exposes `decodeAudioData`, and that is what the DAW used to decode
// with — the only place in the app that did.  Decoding a real song through it
// takes the renderer process down with SIGSEGV (`reason=crashed exit=11`),
// which is not an exception anything can catch: the window is left showing its
// own background colour, black and silent, because the process that would have
// reported the error no longer exists.
//
// Sharing one context across the DAW and the mastering screen also keeps the
// app well inside Chromium's per-page AudioContext limit.
//
// In Node (the self-tests) there is no AudioContext at all — only
// node-web-audio-api's OfflineAudioContext on globalThis — so that is the
// fallback, and it is exercised on buffers small enough to be safe.

/** Decode contexts are fixed at 48 kHz; sources are resampled to match. */
export const DECODE_SAMPLE_RATE = 48_000;

type ContextCtor = new (options?: { sampleRate?: number }) => BaseAudioContext;
type OfflineCtor = new (channels: number, length: number, sampleRate: number) => BaseAudioContext;

let shared: BaseAudioContext | null = null;
let attempted = false;

/** The app's single decode context, or null where audio is unavailable. */
export function decodeContext(): BaseAudioContext | null {
  if (shared) return shared;
  if (attempted) return null;
  attempted = true;

  const g = globalThis as unknown as {
    AudioContext?: ContextCtor;
    webkitAudioContext?: ContextCtor;
    OfflineAudioContext?: OfflineCtor;
  };

  const Live = g.AudioContext ?? g.webkitAudioContext;
  if (Live) {
    try {
      shared = new Live({ sampleRate: DECODE_SAMPLE_RATE });
      return shared;
    } catch { shared = null; }
  }

  if (g.OfflineAudioContext) {
    try { shared = new g.OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE); }
    catch { shared = null; }
  }
  return shared;
}

/** Tests only — forget the context so the next call builds a fresh one. */
export function resetDecodeContext(): void {
  shared = null;
  attempted = false;
}
