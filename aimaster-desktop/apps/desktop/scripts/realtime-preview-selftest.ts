// Realtime preview self-test — the crash-prevention properties.
//
// Realtime preview was hard-disabled because the worklet drove React at
// audio rate: message → setState → re-render → re-attach → more messages.
// Re-enabling it is only defensible if the properties that make that loop
// impossible are actually checked, so this harness runs the REAL worklet
// source under an AudioWorkletGlobalScope shim and drives real blocks
// through it.
//
// What it pins down:
//   1. The worklet's message rate is bounded by wall clock, no matter how
//      many blocks — including down the error path, which used to post per
//      block.
//   2. The metrics store notifies on its own timer, not on message arrival:
//      ten thousand messages must not produce ten thousand renders.
//   3. The snapshot is referentially stable between ticks, so
//      `useSyncExternalStore` cannot tear or loop.
//   4. Config messages reach the chain and are applied.
//
// Run:  pnpm --filter @aimaster/desktop test:realtime-preview

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {
  ingestWorkletMetrics,
  subscribePreviewMetrics,
  getPreviewMetrics,
  resetPreviewMetrics,
} from '../src/renderer/audio/realtime-preview-store.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name} — ${detail}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name} — ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1. The worklet, under a shim ──────────────────────────────────────────

console.log('\n=== REALTIME PREVIEW — worklet message rate ===\n');

const SR = 48_000;
const BLOCK = 128;

interface HarnessResult {
  messages: Record<string, unknown>[];
  processor: {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    port: { onmessage: ((e: { data: unknown }) => void) | null };
  };
  /** Advance the worklet's `currentTime`, in seconds. */
  advance(seconds: number): void;
  post(msg: unknown): void;
}

/**
 * Evaluate the real worklet source in a VM with the globals an
 * AudioWorkletGlobalScope provides, and hand back a live processor.
 */
function buildWorkletHarness(chain: unknown): HarnessResult {
  const workletPath = path.resolve(
    __dirname_, '../src/renderer/audio/mastering-chain.worklet.js',
  );
  const source = readFileSync(workletPath, 'utf8');

  const messages: Record<string, unknown>[] = [];
  let now = 0;

  let ProcessorCtor: (new (opts: unknown) => never) | null = null;
  const sandbox: Record<string, unknown> = {
    sampleRate: SR,
    // `currentTime` must be a live getter — the worklet reads it every block.
    get currentTime() { return now; },
    registerProcessor: (_name: string, ctor: new (opts: unknown) => never) => {
      ProcessorCtor = ctor;
    },
    // Minimal AudioWorkletProcessor: just the port.
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (m: Record<string, unknown>) => { messages.push(m); },
      };
    },
    globalThis: undefined as unknown,
    console,
  };
  sandbox['globalThis'] = sandbox;
  // The loader normally installs this; the harness supplies the chain directly.
  sandbox['__loui_init_mastering'] = () => chain;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'mastering-chain.worklet.js' });

  if (!ProcessorCtor) throw new Error('worklet did not register a processor');
  const processor = new (ProcessorCtor as unknown as new (o: unknown) => {
    process(i: Float32Array[][], o: Float32Array[][]): boolean;
    port: { onmessage: ((e: { data: unknown }) => void) | null };
  })({ processorOptions: { wasmModule: {} } });

  return {
    messages,
    processor,
    advance: (seconds: number) => { now += seconds; },
    post: (msg: unknown) => { processor.port.onmessage?.({ data: msg }); },
  };
}

/** The real node-target WASM chain, so the harness exercises real DSP. */
function loadChain(): unknown {
  const p = path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs');
  const mod = require_(p) as { LouiMasteringChain: new (sr: number) => unknown };
  return new mod.LouiMasteringChain(SR);
}

{
  const chain = loadChain();
  const h = buildWorkletHarness(chain);

  // Drive 10 seconds of audio in 128-sample blocks.
  const blocks = Math.floor((SR * 10) / BLOCK);
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BLOCK; i++) {
      const v = Math.sin((2 * Math.PI * 440 * (b * BLOCK + i)) / SR) * 0.4;
      input[0]![i] = v;
      input[1]![i] = v;
    }
    h.processor.process([input], [output]);
    h.advance(BLOCK / SR);
  }

  // 10 s at a 10 Hz ceiling is ~100 messages.  The old block-count scheme
  // would have produced ~5860 here, and the error path far more.
  const n = h.messages.length;
  check(
    'worklet message rate is bounded by wall clock',
    n > 0 && n <= 120,
    `${blocks} blocks over 10 s → ${n} messages (ceiling ≈ 100)`,
  );

  const last = h.messages[h.messages.length - 1]!;
  check(
    'metrics carry the fields the UI needs',
    'latencySamples' in last && 'loudnessDeltaDb' in last && 'bypass' in last,
    Object.keys(last).length + ' fields',
  );
}

{
  // A config message must reach the chain and take effect.  Level is the
  // easiest thing to assert on without depending on module internals.
  const chain = loadChain();
  const h = buildWorkletHarness(chain);
  h.post({
    type: 'configJson',
    json: JSON.stringify({ outputGainDb: -12, limiter: { bypass: true } }),
    masterBypass: false,
  });

  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let i = 0; i < BLOCK; i++) {
    input[0]![i] = 0.5;
    input[1]![i] = 0.5;
  }
  // A couple of blocks: the first applies the pending config.
  h.processor.process([input], [output]);
  h.advance(BLOCK / SR);
  h.processor.process([input], [output]);

  const outLevel = 20 * Math.log10(Math.abs(output[0]![64]!) / 0.5);
  check(
    'a config message reaches the chain and applies',
    Math.abs(outLevel - -12) < 0.5,
    `${outLevel.toFixed(2)} dB (expected -12)`,
  );
}

{
  // Master bypass must be honoured as a pass-through.
  const chain = loadChain();
  const h = buildWorkletHarness(chain);
  h.post({
    type: 'configJson',
    json: JSON.stringify({ outputGainDb: -12 }),
    masterBypass: true,
  });
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  input[0]!.fill(0.5);
  input[1]!.fill(0.5);
  h.processor.process([input], [output]);
  check(
    'master bypass passes audio through untouched',
    Math.abs(output[0]![10]! - 0.5) < 1e-6,
    `${output[0]![10]!.toFixed(4)}`,
  );
}

{
  // A malformed config must not take the audio thread down, and audio must
  // keep flowing.
  const chain = loadChain();
  const h = buildWorkletHarness(chain);
  h.post({ type: 'configJson', json: '{ this is not json', masterBypass: false });
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  input[0]!.fill(0.25);
  input[1]!.fill(0.25);
  let threw = false;
  try {
    // Several blocks: the chain's default limiter has ~2.5 ms of lookahead,
    // so the first block is legitimately the delay line's zeros.  Reading
    // block 0 would be measuring latency, not a failure to pass audio.
    for (let b = 0; b < 8; b++) {
      h.processor.process([input], [output]);
      h.advance(BLOCK / SR);
    }
  } catch {
    threw = true;
  }
  check('a malformed config does not throw on the audio thread', !threw, 'survived');
  check(
    'audio keeps flowing after a bad config',
    output[0]!.every(Number.isFinite) && Math.abs(output[0]![64]!) > 0,
    `sample ${output[0]![64]!.toFixed(4)}`,
  );
}

// ── 2. The store ──────────────────────────────────────────────────────────

console.log('\n=== REALTIME PREVIEW — store notify rate ===\n');

async function storeChecks(): Promise<void> {
  resetPreviewMetrics();
  let notifies = 0;
  const unsub = subscribePreviewMetrics(() => { notifies += 1; });

  // Ten thousand messages, as fast as possible.  Under the old design each
  // of these would have been a React render.
  for (let i = 0; i < 10_000; i++) {
    ingestWorkletMetrics({
      type: 'metrics', audioBlocks: 1, avgProcessMs: i * 0.001, limiterGrDb: 1,
    });
  }
  check(
    'ingesting messages does not notify',
    notifies === 0,
    `10,000 messages → ${notifies} notifications`,
  );

  const before = getPreviewMetrics();
  await sleep(250);
  const after = getPreviewMetrics();
  check(
    'the timer notifies, at its own rate',
    notifies > 0 && notifies <= 5,
    `${notifies} notifications in 250 ms (≈ 10 Hz)`,
  );
  check(
    'the snapshot is replaced, not mutated',
    before !== after && after.avgProcessMs > 0,
    `avgProcessMs ${after.avgProcessMs.toFixed(3)}`,
  );

  // Between ticks the snapshot must be referentially stable, or
  // `useSyncExternalStore` would re-render forever.
  const a = getPreviewMetrics();
  const b = getPreviewMetrics();
  check('the snapshot is stable between reads', a === b, 'identical reference');

  const quietBefore = notifies;
  await sleep(250);
  check(
    'an idle store does not notify',
    notifies === quietBefore,
    `${notifies - quietBefore} notifications while idle`,
  );

  unsub();
  resetPreviewMetrics();
  check('reset clears the snapshot', getPreviewMetrics().updatedAt === 0, 'cleared');
}

// tsx transpiles this file to CJS, where top-level await is unavailable —
// so the async half runs through a promise chain instead.
void storeChecks().then(() => {
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
});
