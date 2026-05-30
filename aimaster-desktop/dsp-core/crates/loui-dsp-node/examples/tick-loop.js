/* loui-dsp Node N-API binding — tick-loop example.
 *
 * Pre-requisite (one time):
 *   npm install -g @napi-rs/cli
 *
 * Build the .node binary for this platform:
 *   cd aimaster-desktop/dsp-core/crates/loui-dsp-node
 *   napi build --release --platform
 *
 * Run:
 *   node examples/tick-loop.js
 *
 * Feeds 60 s of a stereo -23 dBFS-per-channel sine into the analyzer at
 * 256-sample blocks and prints a snapshot every second.
 *
 * Goal: demonstrate the JS surface + measure native-call latency.
 */
'use strict';

const path = require('node:path');

// Path resolution: napi build emits to crates/loui-dsp-node/loui-dsp-node.<platform>.node
// after compilation.  Try a couple of common platform suffixes for portability.
function loadBinding() {
  const candidates = [
    `./loui-dsp-node.${process.platform}-${process.arch}-gnu.node`,
    `./loui-dsp-node.${process.platform}-${process.arch}.node`,
    `./loui-dsp-node.${process.platform}-${process.arch}-musl.node`,
    `./index.node`,
  ];
  for (const rel of candidates) {
    try {
      return require(path.resolve(__dirname, '..', rel));
    } catch (e) {
      // try next
    }
  }
  throw new Error(
    'loui-dsp-node binding not found.  Build with `napi build --release --platform` ' +
    'from crates/loui-dsp-node/.',
  );
}

const dsp = loadBinding();

console.log(`loui-dsp-node v${dsp.crateVersion()}`);

const SAMPLE_RATE = 48_000;
const BLOCK = 256;
const DURATION_SEC = 60;
const TOTAL_FRAMES = SAMPLE_RATE * DURATION_SEC;

// Synthesise a stereo -23 dBFS sine.
const amp = Math.pow(10, -23 / 20) * Math.sqrt(2); // per-channel RMS sine
const left  = new Float32Array(BLOCK);
const right = new Float32Array(BLOCK);

const analyzer = new dsp.LouiAnalyzer(SAMPLE_RATE, 2);
console.log(`analyzer constructed: ${analyzer.sampleRate} Hz, ${analyzer.channels} ch`);

// Latency measurement — average over the first 10k blocks.
const nBlocks = Math.floor(TOTAL_FRAMES / BLOCK);
let acc = 0n;
let phase = 0;
const PHASE_STEP = (2 * Math.PI * 440) / SAMPLE_RATE;

const t0 = process.hrtime.bigint();
for (let b = 0; b < nBlocks; b++) {
  for (let i = 0; i < BLOCK; i++) {
    const s = amp * Math.sin(phase);
    left[i]  = s;
    right[i] = s;
    phase += PHASE_STEP;
  }
  const t_call = process.hrtime.bigint();
  analyzer.processStereo(left, right);
  acc += process.hrtime.bigint() - t_call;

  // Snapshot every ~1 second.
  if (b % Math.floor(SAMPLE_RATE / BLOCK) === 0) {
    const s = analyzer.tickSnapshot();
    process.stdout.write(
      `t=${(b * BLOCK / SAMPLE_RATE).toFixed(1)}s ` +
      `M=${s.momentaryLufs.toFixed(2)} ` +
      `S=${s.shortTermLufs.toFixed(2)} ` +
      `TP=${s.truePeakDbtp.toFixed(2)} ` +
      `peak=${s.samplePeakDb.toFixed(2)} ` +
      `rms=${s.rmsDb.toFixed(2)} ` +
      `corr=${s.correlation.toFixed(3)}\n`
    );
  }
}
analyzer.flush();
const total = process.hrtime.bigint() - t0;

const final = analyzer.snapshot();
console.log('\nFinal snapshot:');
console.log(JSON.stringify(final, null, 2));

const totalMs = Number(total) / 1e6;
const callAvgUs = Number(acc) / nBlocks / 1e3;
const realtimeRatio = (DURATION_SEC * 1000) / totalMs;
console.log(
  `\nProcessed ${nBlocks} blocks (${DURATION_SEC} s of audio) in ${totalMs.toFixed(1)} ms`
);
console.log(`  → ${realtimeRatio.toFixed(1)}× realtime`);
console.log(`  → processStereo avg latency: ${callAvgUs.toFixed(2)} µs/call (${BLOCK} samples)`);
console.log(`  → CPU load if realtime: ${((callAvgUs / 1000) / (BLOCK * 1000 / SAMPLE_RATE) * 100).toFixed(2)}%`);
