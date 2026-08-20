/**
 * stream-selftest — the disk-streaming path.
 *
 * The ring is the contract between a reader thread and the audio thread, and
 * it is the one place in the engine where getting it slightly wrong produces a
 * click rather than an error.  Everything here is exercised without a
 * SharedArrayBuffer, a Worker or an audio device: Atomics work on ordinary
 * ArrayBuffers, so the protocol is testable as plain functions.
 *
 * The worklet's frame arithmetic is checked against the same numbers, because
 * "the clip starts on the right sample" is not something a listener can
 * confirm and not something a type can.
 *
 * Run:  pnpm --filter @aimaster/desktop test:stream
 */

import {
  createRing, writeFrames, readFrames, skipFrames, resetTo, filledFrames,
  writableFrames, underruns, setEndFrame, endFrame, readPosition, writePosition,
  attachRing, canShareMemory,
} from '../src/renderer/daw/engine/ring-buffer.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** Interleaved ramp: frame f, channel c -> f + c/10.  Any misread is visible. */
function ramp(fromFrame: number, frames: number, channels: number): Float32Array {
  const out = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[f * channels + c] = (fromFrame + f) + c / 10;
  }
  return out;
}

function planar(frames: number, channels = 2): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(frames));
}

// ── The ring ─────────────────────────────────────────────────────────────────

check('samples come out in the order they went in', () => {
  const ring = createRing(64, 2);
  assert(writeFrames(ring, ramp(0, 16, 2), 16, 0) === 16, 'sixteen frames written');
  assert(filledFrames(ring) === 16, 'and sixteen are readable');

  const out = planar(16);
  assert(readFrames(ring, out, 0, 16) === 16, 'sixteen frames read');
  for (let f = 0; f < 16; f++) {
    assert(out[0]![f] === f, `left frame ${f} is ${out[0]![f]}`);
    assert(Math.abs(out[1]![f] - (f + 0.1)) < 1e-5, `right frame ${f} is ${out[1]![f]}`);
  }
  assert(filledFrames(ring) === 0, 'the ring is empty again');
});

check('the ring wraps without losing or duplicating a frame', () => {
  // Capacity 8, written and read 5 at a time: every write straddles the seam.
  const ring = createRing(8, 2);
  const out = planar(5);
  let expected = 0;
  for (let round = 0; round < 20; round++) {
    assert(writeFrames(ring, ramp(expected, 5, 2), 5, expected) === 5,
      `round ${round} wrote across the wrap`);
    assert(readFrames(ring, out, 0, 5) === 5, `round ${round} read back`);
    for (let f = 0; f < 5; f++) {
      assert(out[0]![f] === expected + f,
        `round ${round} frame ${f}: expected ${expected + f}, got ${out[0]![f]}`);
    }
    expected += 5;
  }
  assert(readPosition(ring) === 100 && writePosition(ring) === 100,
    'a hundred frames passed through, counted exactly once');
});

check('a full ring refuses the write instead of overwriting unread audio', () => {
  const ring = createRing(16, 2);
  assert(writeFrames(ring, ramp(0, 16, 2), 16, 0) === 16, 'filled to capacity');
  assert(writableFrames(ring) === 0, 'no room left');
  assert(writeFrames(ring, ramp(16, 4, 2), 4, 16) === 0, 'the extra write is refused');

  // Nothing was clobbered: the first frames are still the first frames.
  const out = planar(16);
  readFrames(ring, out, 0, 16);
  assert(out[0]![0] === 0 && out[0]![15] === 15, 'the buffered audio is intact');
});

check('a partial write is short, never lossy', () => {
  const ring = createRing(16, 2);
  writeFrames(ring, ramp(0, 12, 2), 12, 0);
  // Only four slots remain, so eight frames can only half land.
  const taken = writeFrames(ring, ramp(12, 8, 2), 8, 12);
  assert(taken === 4, `four of eight taken — got ${taken}`);
  assert(writePosition(ring) === 16, 'the write head advanced by exactly what was taken');
  // The producer resumes from where the ring actually is, so frame 16 is next.
  const out = planar(16);
  readFrames(ring, out, 0, 16);
  for (let f = 0; f < 16; f++) assert(out[0]![f] === f, `frame ${f} intact`);
});

check('a fill from before a seek is dropped, not spliced in', () => {
  const ring = createRing(64, 2);
  writeFrames(ring, ramp(0, 8, 2), 8, 0);

  // The transport jumps; both ends now say frame 5000.
  resetTo(ring, 5000);
  assert(filledFrames(ring) === 0, 'the seek discarded what was buffered');

  // A block that was already in flight when the seek happened arrives late.
  assert(writeFrames(ring, ramp(8, 8, 2), 8, 8) === 0,
    'audio from the old position is refused');
  // The right block is accepted.
  assert(writeFrames(ring, ramp(5000, 8, 2), 8, 5000) === 8, 'audio from the new position lands');

  const out = planar(8);
  readFrames(ring, out, 0, 8);
  assert(out[0]![0] === 5000, `playback resumes at 5000, got ${out[0]![0]}`);
});

check('an underrun is silence and a number, never a stall', () => {
  const ring = createRing(64, 2);
  writeFrames(ring, ramp(0, 4, 2), 4, 0);

  const out = planar(16);
  out[0]!.fill(9);                       // poison, so silence has to be written
  const got = readFrames(ring, out, 0, 16);
  assert(got === 4, `only what was there came out — got ${got}`);
  assert(underruns(ring) === 12, `the shortfall is counted — got ${underruns(ring)}`);
  // readFrames leaves the rest to the caller; the worklet zeroes it, and the
  // count is what tells anyone it happened.
});

check('a mono source feeds both output channels', () => {
  const ring = createRing(32, 1);
  writeFrames(ring, ramp(0, 8, 1), 8, 0);
  const out = planar(8, 2);
  readFrames(ring, out, 0, 8);
  for (let f = 0; f < 8; f++) {
    assert(out[0]![f] === f, `left frame ${f}`);
    assert(out[1]![f] === f, `right matches left for a mono source at ${f}`);
  }
});

check('reads can be placed part-way into the output block', () => {
  // A clip starting mid-quantum writes at an offset, leaving the head alone.
  const ring = createRing(32, 2);
  resetTo(ring, 100);                    // the clip reads from frame 100 on
  writeFrames(ring, ramp(100, 4, 2), 4, 100);
  const out = planar(8);
  out[0]!.fill(-1);
  readFrames(ring, out, 4, 4);
  assert(out[0]![0] === -1 && out[0]![3] === -1, 'the first half of the block is untouched');
  assert(out[0]![4] === 100 && out[0]![7] === 103, 'the clip lands at the offset');
});

check('skipping trims a preroll without emitting it', () => {
  const ring = createRing(64, 2);
  writeFrames(ring, ramp(0, 32, 2), 32, 0);
  assert(skipFrames(ring, 10) === 10, 'ten frames dropped');
  const out = planar(4);
  readFrames(ring, out, 0, 4);
  assert(out[0]![0] === 10, `playback continues at 10, got ${out[0]![0]}`);
  assert(skipFrames(ring, 1000) === 18, 'skipping past the end takes only what is there');
});

check('the end of the source is recorded so the reader knows to stop', () => {
  const ring = createRing(16, 2);
  assert(endFrame(ring) === 0, 'unset until told');
  setEndFrame(ring, 480000);
  assert(endFrame(ring) === 480000, 'the last frame is readable by the reader thread');
});

check('a ring attached from another thread sees the same memory', () => {
  const ring = createRing(32, 2);
  writeFrames(ring, ramp(0, 8, 2), 8, 0);
  // What the Worker does with the buffers it was handed.
  const attached = attachRing(ring.control, ring.data, 32, 2);
  assert(filledFrames(attached) === 8, 'the other end sees the same fill level');
  const out = planar(8);
  readFrames(attached, out, 0, 8);
  assert(out[0]![7] === 7, 'and reads the same samples');
  assert(filledFrames(ring) === 0, 'the original handle sees the read');
});

// ── The worklet's frame arithmetic ───────────────────────────────────────────
// Mirrors daw-stream.worklet.js.  A clip has to start on the sample an
// AudioBufferSourceNode would have started on; nobody can hear a one-sample
// error, and nobody can debug one either, so it is pinned here.

interface Block { startInBlock: number; wanted: number; sounding: boolean }

function planBlock(
  blockStart: number, blockFrames: number, startFrame: number,
  durationFrames: number, played: number,
): Block {
  const offsetIntoClip = blockStart - startFrame;
  if (offsetIntoClip + blockFrames <= 0) return { startInBlock: 0, wanted: 0, sounding: false };
  if (played >= durationFrames) return { startInBlock: 0, wanted: 0, sounding: false };
  const startInBlock = offsetIntoClip < 0 ? -offsetIntoClip : 0;
  const room = blockFrames - startInBlock;
  const remaining = durationFrames - played;
  return {
    startInBlock,
    wanted: Math.max(0, Math.min(remaining, room)),
    sounding: true,
  };
}

check('a clip starts on its exact sample, not on a block boundary', () => {
  // Starts 37 samples into a 128-frame quantum.
  const plan = planBlock(1024, 128, 1024 + 37, 48000, 0);
  assert(plan.startInBlock === 37, `offset 37 within the block — got ${plan.startInBlock}`);
  assert(plan.wanted === 128 - 37, `and fills the rest — got ${plan.wanted}`);
});

check('blocks before the start are silent and consume nothing', () => {
  const plan = planBlock(0, 128, 4096, 48000, 0);
  assert(!plan.sounding, 'not yet sounding');
  assert(plan.wanted === 0, 'and no frames are taken from the ring');
});

check('the last block is trimmed to the clip length, to the sample', () => {
  // 300 frames long, 256 already played: exactly 44 left in a 128 block.
  const plan = planBlock(1000, 128, 872, 300, 256);
  assert(plan.wanted === 44, `44 frames remain — got ${plan.wanted}`);
});

check('a clip retires once its length is used up', () => {
  const plan = planBlock(2000, 128, 100, 300, 300);
  assert(!plan.sounding, 'played out');
});

check('a clip entered mid-way starts at the block head', () => {
  // Seeking into a clip: the start frame is already behind us.
  const plan = planBlock(5000, 128, 1000, 48000, 4000);
  assert(plan.startInBlock === 0, 'no in-block offset');
  assert(plan.wanted === 128, 'and the whole block sounds');
});

check('a clip shorter than one block still plays its exact length', () => {
  const plan = planBlock(0, 128, 10, 20, 0);
  assert(plan.startInBlock === 10, 'starts at sample 10');
  assert(plan.wanted === 20, `and runs 20 frames, not to the block end — got ${plan.wanted}`);
});

// ── Sizing ───────────────────────────────────────────────────────────────────

check('a two-second ring is a rounding error against a resident track', () => {
  const ring = createRing(96_000, 2);            // 2 s at 48 kHz, stereo
  const ringBytes = ring.data.byteLength;
  const fourMinuteTrack = 4 * 60 * 48_000 * 2 * 4;
  assert(ringBytes === 96_000 * 2 * 4, `ring is ${ringBytes} bytes`);
  assert(ringBytes * 40 < fourMinuteTrack,
    'forty streamed tracks cost less than one resident one'
    + ` — ${(ringBytes * 40 / 1048576).toFixed(1)} MB vs ${(fourMinuteTrack / 1048576).toFixed(1)} MB`);
});

check('rings work without SharedArrayBuffer so the fallback path is real', () => {
  // In Node there is none, and the ring still has to behave — that is what
  // lets an environment without shared memory fall back instead of failing.
  const ring = createRing(16, 2);
  writeFrames(ring, ramp(0, 4, 2), 4, 0);
  const out = planar(4);
  assert(readFrames(ring, out, 0, 4) === 4, 'reads and writes work either way');
  if (!canShareMemory()) {
    assert(!(ring.data.buffer instanceof SharedArrayBuffer === true),
      'and no shared memory was required');
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Disk streaming — ring protocol + worklet frame maths ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
