// daw-reader.worker.js - the thread that keeps the audio thread fed.
//
// One worker serves every streaming voice.  It reads blocks of a decoded PCM
// store over the `aimaster-local://` protocol, which answers HTTP range
// requests: a 512 KB block - about 1.4 seconds of stereo audio - lands in
// roughly 6 ms, so a two-second ring has a couple of hundred times the margin
// it needs.
//
// It runs off the main thread on purpose.  React rendering, a layout pass or a
// long import would all stall a main-thread reader, and a stalled reader is a
// dropout.  Nothing here touches the DOM or the audio graph; it only moves
// bytes into rings.

const READ_FRAME = 0;
const WRITE_FRAME = 1;

/** One range request. 512 KB of stereo float32 is ~1.4 s of audio. */
const BLOCK_FRAMES = 65536;
/** Poll interval when a ring is full and there is nothing to do. */
const IDLE_MS = 25;

/** @type {Map<number, object>} */
const voices = new Map();
let timer = null;

function filled(v) {
  return Atomics.load(v.control, WRITE_FRAME) - Atomics.load(v.control, READ_FRAME);
}

function writable(v) {
  return v.capacityFrames - filled(v);
}

/** Append interleaved frames at `atFrame`; refuse a fill from before a seek. */
function writeFrames(v, samples, frameCount, atFrame) {
  const write = Atomics.load(v.control, WRITE_FRAME);
  if (atFrame !== write) return 0;

  const room = Math.min(frameCount, writable(v));
  if (room <= 0) return 0;

  const start = ((write % v.capacityFrames) + v.capacityFrames) % v.capacityFrames;
  const firstRun = Math.min(room, v.capacityFrames - start);
  v.data.set(samples.subarray(0, firstRun * v.channels), start * v.channels);
  if (room > firstRun) {
    v.data.set(samples.subarray(firstRun * v.channels, room * v.channels), 0);
  }
  Atomics.store(v.control, WRITE_FRAME, write + room);
  return room;
}

async function fillOne(v) {
  if (v.busy || v.closed) return;
  const write = Atomics.load(v.control, WRITE_FRAME);
  if (write >= v.endFrame) return;               // the source is exhausted
  if (writable(v) < BLOCK_FRAMES / 2) return;    // plenty buffered already

  const wanted = Math.min(BLOCK_FRAMES, v.endFrame - write, writable(v));
  if (wanted <= 0) return;

  const from = write * v.bytesPerFrame;
  const to = from + wanted * v.bytesPerFrame - 1;
  const generation = v.generation;
  v.busy = true;
  try {
    const resp = await fetch(v.url, { headers: { Range: `bytes=${from}-${to}` } });
    if (!resp.ok) throw new Error(`range read failed (${resp.status})`);
    const bytes = await resp.arrayBuffer();
    // A seek landed while this block was in flight: it is the wrong audio now.
    if (v.closed || generation !== v.generation) return;

    const frames = Math.floor(bytes.byteLength / v.bytesPerFrame);
    if (frames > 0) {
      writeFrames(v, new Float32Array(bytes, 0, frames * v.channels), frames, write);
    }
  } catch (err) {
    // Report once per voice; a store that cannot be read will not start
    // being readable if we ask fifty times a second.
    if (!v.reportedError) {
      v.reportedError = true;
      self.postMessage({ type: 'error', id: v.id, message: String(err) });
    }
  } finally {
    v.busy = false;
  }
}

function pump() {
  for (const v of voices.values()) void fillOne(v);
  timer = voices.size > 0 ? setTimeout(pump, IDLE_MS) : null;
}

function ensurePumping() {
  if (timer === null && voices.size > 0) timer = setTimeout(pump, 0);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'open') {
    const channels = msg.channels;
    const v = {
      id: msg.id,
      url: msg.url,
      control: new Int32Array(msg.control),
      data: new Float32Array(msg.data),
      capacityFrames: msg.capacityFrames,
      channels,
      bytesPerFrame: channels * 4,
      endFrame: msg.endFrame,
      generation: 0,
      busy: false,
      closed: false,
      reportedError: false,
    };
    Atomics.store(v.control, READ_FRAME, msg.startFrame);
    Atomics.store(v.control, WRITE_FRAME, msg.startFrame);
    voices.set(msg.id, v);
    ensurePumping();
    // Fill the first block immediately - the voice may be about to start.
    void fillOne(v);
    return;
  }

  if (msg.type === 'seek') {
    const v = voices.get(msg.id);
    if (!v) return;
    v.generation += 1;
    Atomics.store(v.control, READ_FRAME, msg.frame);
    Atomics.store(v.control, WRITE_FRAME, msg.frame);
    void fillOne(v);
    return;
  }

  if (msg.type === 'close') {
    const v = voices.get(msg.id);
    if (v) v.closed = true;
    voices.delete(msg.id);
    if (voices.size === 0 && timer !== null) { clearTimeout(timer); timer = null; }
  }
};
