// offline-render-shim-selftest — the renderer every audio check in this suite
// measures through, and the one way it could hand back nothing.
//
// `node-web-audio-api` returns the buffer its `complete` callback stored in a
// private field, not the one its own promise resolved with, and the order of
// those two napi callbacks is assumed rather than enforced.  When the promise
// won, `startRendering()` resolved with null and whatever was reading the
// channels died.  It happened once, in `latency-probe-selftest`, in a suite
// run testing something else entirely.
//
// The patch in `lib/offline-audio-context.ts` waits for the `complete` event
// when the field comes back empty.  The null is far too rare to provoke — not
// once in 20,600 probed renders — so the fallback is checked through
// `resolveRender`, which takes both sources as arguments precisely so this
// test does not have to win a race to reach it.
//
// Run: pnpm --filter @aimaster/desktop test:offline-render-shim

export {};

import {
  FALLBACK_TIMEOUT_MS, OfflineAudioContext, PATCH_INSTALLED,
  offlineRenderFallbacks, resetOfflineRenderFallbacks, resolveRender,
  unpatchedStartRendering,
} from './lib/offline-audio-context.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** A stand-in for the rendered buffer; only identity is being tracked. */
const BUF_A = { tag: 'from the promise' } as unknown as AudioBuffer;
const BUF_B = { tag: 'from the complete event' } as unknown as AudioBuffer;

/** Null-safe on purpose: a broken patch hands back the null, and a check that
 *  dies reading the detail reports nothing at all. */
function tagOf(b: AudioBuffer | null | undefined): string {
  return (b as unknown as { tag?: string } | null)?.tag ?? String(b);
}

async function main(): Promise<void> {
  console.log('\n=== THE DECISION, WITH BOTH SOURCES HANDED IN ===\n');

  resetOfflineRenderFallbacks();

  {
    const out = await resolveRender(async () => BUF_A, Promise.resolve(BUF_B));
    check(
      'a render that resolves with a buffer returns that buffer',
      out === BUF_A,
      tagOf(out),
    );
    check(
      'and does not count as a fallback',
      offlineRenderFallbacks() === 0,
      `${offlineRenderFallbacks()} fallback(s)`,
    );
  }

  {
    const out = await resolveRender(async () => null, Promise.resolve(BUF_B));
    check(
      'a render that resolves with null takes the buffer off the event',
      out === BUF_B,
      tagOf(out),
    );
    check(
      'and is counted, because the rate is worth knowing',
      offlineRenderFallbacks() === 1,
      `${offlineRenderFallbacks()} fallback(s)`,
    );
  }

  {
    // The event normally fires BEFORE the promise settles, which is the whole
    // reason the library wrote it this way.  A pending-then-late event is the
    // other order, and it has to work too.
    let late: (b: AudioBuffer) => void = () => {};
    const viaEvent = new Promise<AudioBuffer | null>((r) => { late = r; });
    const pending = resolveRender(async () => null, viaEvent);
    setTimeout(() => late(BUF_B), 20);
    const out = await pending;
    check(
      'an event that arrives after the null is still waited for',
      out === BUF_B,
      tagOf(out),
    );
  }

  {
    // A hang is worse than a crash: a suite that stops reporting looks like a
    // suite that is still working.  So the wait has an end.
    const started = Date.now();
    let message = '';
    try {
      await resolveRender(async () => null, new Promise<null>(() => {}), 150);
      message = 'resolved, which it must not';
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - started;
    check(
      'a null with no event ever arriving throws instead of hanging',
      message.includes('resolved with null') && message.includes("'complete'") && ms < 5000,
      `${ms} ms, "${message.slice(0, 96)}"`,
    );
    check(
      'and the production timeout is long enough for a real render',
      FALLBACK_TIMEOUT_MS >= 10_000,
      `${FALLBACK_TIMEOUT_MS} ms`,
    );
  }

  console.log('\n=== AND IT IS INSTALLED ON THE CONTEXT EVERY CHECK USES ===\n');

  check(
    'the prototype no longer carries the library method',
    PATCH_INSTALLED
      && (OfflineAudioContext.prototype as unknown as { startRendering: unknown }).startRendering
        !== (unpatchedStartRendering as unknown),
    'startRendering is the patched one',
  );

  {
    resetOfflineRenderFallbacks();
    const SR = 48_000, N = 4096, ROUNDS = 60;
    let nulls = 0;
    let lengths = new Set<number>();
    for (let i = 0; i < ROUNDS; i++) {
      const ctx = new OfflineAudioContext(2, N, SR);
      const buffer = ctx.createBuffer(1, N, SR);
      const d = buffer.getChannelData(0);
      for (let k = 0; k < N; k++) d[k] = Math.sin((2 * Math.PI * 440 * k) / SR) * 0.5;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
      const out = await ctx.startRendering();
      if (!out) nulls++;
      else lengths.add(out.length);
    }
    check(
      `${ROUNDS} real renders through the patch all come back with a buffer`,
      nulls === 0 && lengths.size === 1 && lengths.has(N),
      `${nulls} null(s), lengths ${[...lengths].join('/')}`,
    );
    check(
      'and the audio is still the audio — a 440 Hz tone, not silence',
      await (async (): Promise<boolean> => {
        const ctx = new OfflineAudioContext(1, N, SR);
        const buffer = ctx.createBuffer(1, N, SR);
        const d = buffer.getChannelData(0);
        for (let k = 0; k < N; k++) d[k] = Math.sin((2 * Math.PI * 440 * k) / SR) * 0.5;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
        const out = await ctx.startRendering();
        const ch = out.getChannelData(0);
        let peak = 0;
        for (let k = 0; k < ch.length; k++) peak = Math.max(peak, Math.abs(ch[k] ?? 0));
        return peak > 0.45 && peak < 0.55;
      })(),
      'peak near 0.5',
    );
    check(
      'and none of them needed the fallback, which is the expected rate',
      offlineRenderFallbacks() === 0,
      `${offlineRenderFallbacks()} fallback(s) in ${ROUNDS + 1} renders`,
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

void main();
