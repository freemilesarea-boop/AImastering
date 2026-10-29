// The Node Web Audio shim, with the one place it can hand back nothing.
//
// `node-web-audio-api`'s OfflineAudioContext stores the rendered buffer in a
// private field from its `complete` callback, and `startRendering()` returns
// THAT FIELD — not the value its own promise resolved with.  The library says
// why in a comment of its own:
//
//     // workaround the fact that the oncomplete event is triggered before
//     // startRendering fulfills and that we want to return the exact same
//     // instance
//
// Two napi callbacks and one assumed order between them.  When the promise
// wins, the field is still its initial `null`, and `startRendering()` resolves
// with null.  That is how a suite run died in `latency-probe-selftest`, in the
// section whose heading reads AND IT IS STABLE, WHICH IS THE WHOLE POINT:
//
//     TypeError: Cannot read properties of null (reading 'getChannelData')
//
// Nothing was wrong with the test, and nothing in that run was near the
// change that was being tested.  How rare: zero in 20,000 trivial renders and
// zero in 600 renders of the probe's own 4x-shaper graph under six busy
// loops — then once in a full suite run.  Rare enough to have survived this
// long in a tree with 76 `startRendering()` call sites, common enough to stop
// a run, and not something a re-run makes untrue.
//
// The fix takes the `complete` event as the authority it already is.  It
// carries the SAME AudioBuffer instance (measured: `direct === ev` with both
// reading 4096 frames), and it is dispatched on a `setImmediate` after the
// promise settles — so waiting for it costs one tick, and only when the field
// came back empty.
//
// Every script that renders audio imports the context from here rather than
// from the package, because the patch is on the prototype: that covers the
// call sites inside `src/` too, which construct their contexts from
// `globalThis.OfflineAudioContext`.
import { AudioBuffer, OfflineAudioContext } from 'node-web-audio-api';

/** Long enough that a real render is never cut off; short enough to fail. */
export const FALLBACK_TIMEOUT_MS = 30_000;

let fallbacks = 0;

/**
 * How many renders in this process had to wait for the `complete` event
 * because `startRendering()` resolved with nothing.  Expected to be 0; a
 * selftest reads it, and it is the only way to measure the rate in situ.
 */
export function offlineRenderFallbacks(): number {
  return fallbacks;
}

/** Test seam: reset the counter so a check can assert on its own renders. */
export function resetOfflineRenderFallbacks(): void {
  fallbacks = 0;
}

/**
 * The decision the patch makes, with both sources passed in so it can be
 * tested without a render.  `viaEvent` must already be pending when `raw`
 * runs: the event can fire first, and usually does.
 */
export async function resolveRender(
  raw: () => Promise<AudioBuffer | null>,
  viaEvent: Promise<AudioBuffer | null>,
  timeoutMs: number = FALLBACK_TIMEOUT_MS,
): Promise<AudioBuffer> {
  const direct = await raw();
  if (direct) return direct;
  fallbacks += 1;
  // Deliberately NOT unref'd.  The first draft was, and this test caught it:
  // when the fallback is the only pending work, an unref'd timer lets Node
  // exit mid-wait — the shim selftest ended at exit 0 with three checks
  // silently never run.  While we are waiting for a render we want the
  // process kept alive, and the `finally` below clears the timer either way.
  let timer: unknown;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const late = await Promise.race([viaEvent, expiry]);
    if (late) return late;
  } finally {
    clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  }
  throw new Error(
    `OfflineAudioContext.startRendering() resolved with null and no 'complete' `
    + `event arrived within ${timeoutMs} ms`,
  );
}

type Rendering = () => Promise<AudioBuffer | null>;

const proto = OfflineAudioContext.prototype as unknown as {
  startRendering: Rendering;
  addEventListener: (
    type: string,
    listener: (ev: { renderedBuffer?: AudioBuffer }) => void,
    options?: { once?: boolean },
  ) => void;
};
const unpatched: Rendering = proto.startRendering;

/** True once the prototype carries the patch — asserted by the selftest. */
export const PATCH_INSTALLED = true;

proto.startRendering = function patchedStartRendering(
  this: typeof proto,
): Promise<AudioBuffer> {
  // Registered BEFORE the render starts, because the event is the one that
  // normally arrives first.
  const viaEvent = new Promise<AudioBuffer | null>((resolve) => {
    this.addEventListener('complete', (ev) => resolve(ev.renderedBuffer ?? null), { once: true });
  });
  return resolveRender(() => unpatched.call(this), viaEvent);
};

export { AudioBuffer, OfflineAudioContext, unpatched as unpatchedStartRendering };
