// A single-producer / single-consumer ring of audio frames.
//
// One reader Worker writes; one AudioWorklet reads.  They never share a lock,
// because the audio thread cannot wait for one: a blocked render quantum is a
// click, every time.  Two atomic counters are enough for exactly one writer
// and exactly one reader, which is what this is.
//
// The counters are ABSOLUTE source-frame positions, not offsets into the
// storage.  That matters more than it looks: the consumer always knows which
// frame of the file it is about to play, so a seek is "both counters now say
// N" rather than a negotiation, and a late fill can be checked for gaps
// instead of being assumed contiguous.
//
// Everything here is a plain function over typed arrays.  Atomics work on
// ordinary ArrayBuffers too, so the whole protocol is testable in Node with no
// SharedArrayBuffer, no Worker and no audio device.

/** Control words, in order. */
export const READ_FRAME = 0;
export const WRITE_FRAME = 1;
/** Source frame after the last one that exists, or -1 while unknown. */
export const END_FRAME = 2;
/** How many frames the consumer wanted and did not have. */
export const UNDERRUNS = 3;
/** Bumped by the consumer whenever it needs the producer to refill. */
export const CONTROL_WORDS = 4;

export interface Ring {
  control: Int32Array;
  /** Interleaved frames, `capacityFrames * channels` samples. */
  data: Float32Array;
  capacityFrames: number;
  channels: number;
}

/** True when this build can hand a ring to another thread. */
export function canShareMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

/**
 * Allocate a ring.  Shared when the runtime allows it, plain otherwise —
 * a plain ring still works for tests and for a single-threaded fallback.
 */
export function createRing(capacityFrames: number, channels: number): Ring {
  const controlBytes = CONTROL_WORDS * 4;
  const dataBytes = capacityFrames * channels * 4;
  const Store = canShareMemory()
    ? SharedArrayBuffer
    : ArrayBuffer as unknown as typeof SharedArrayBuffer;

  const ring: Ring = {
    control: new Int32Array(new Store(controlBytes)),
    data: new Float32Array(new Store(dataBytes)),
    capacityFrames,
    channels,
  };
  resetTo(ring, 0);
  return ring;
}

/** Rebuild the handle around memory that arrived from another thread. */
export function attachRing(
  control: Int32Array, data: Float32Array, capacityFrames: number, channels: number,
): Ring {
  return { control, data, capacityFrames, channels };
}

/** Point both ends at `frame`, discarding whatever was buffered. */
export function resetTo(ring: Ring, frame: number): void {
  Atomics.store(ring.control, READ_FRAME, frame);
  Atomics.store(ring.control, WRITE_FRAME, frame);
}

export function readPosition(ring: Ring): number {
  return Atomics.load(ring.control, READ_FRAME);
}

export function writePosition(ring: Ring): number {
  return Atomics.load(ring.control, WRITE_FRAME);
}

/** Frames the consumer can take right now. */
export function filledFrames(ring: Ring): number {
  return Atomics.load(ring.control, WRITE_FRAME) - Atomics.load(ring.control, READ_FRAME);
}

/** Frames the producer may add right now. */
export function writableFrames(ring: Ring): number {
  return ring.capacityFrames - filledFrames(ring);
}

export function setEndFrame(ring: Ring, frame: number): void {
  Atomics.store(ring.control, END_FRAME, frame);
}

export function endFrame(ring: Ring): number {
  return Atomics.load(ring.control, END_FRAME);
}

export function underruns(ring: Ring): number {
  return Atomics.load(ring.control, UNDERRUNS);
}

/**
 * Append interleaved frames.  Returns how many were taken — a short write
 * means the ring is full and the producer should come back later, never that
 * samples were dropped.
 *
 * `atFrame` is the absolute source position of `samples[0]`.  A producer that
 * has fallen behind a seek passes a position that no longer matches the write
 * head, and the write is refused rather than silently splicing the wrong audio
 * into the stream.
 */
export function writeFrames(
  ring: Ring, samples: Float32Array, frameCount: number, atFrame: number,
): number {
  const write = Atomics.load(ring.control, WRITE_FRAME);
  if (atFrame !== write) return 0;                 // stale fill, from before a seek

  const room = Math.min(frameCount, writableFrames(ring));
  if (room <= 0) return 0;

  const { channels, capacityFrames, data } = ring;
  const start = ((write % capacityFrames) + capacityFrames) % capacityFrames;
  const firstRun = Math.min(room, capacityFrames - start);

  data.set(samples.subarray(0, firstRun * channels), start * channels);
  if (room > firstRun) {
    data.set(samples.subarray(firstRun * channels, room * channels), 0);
  }

  Atomics.store(ring.control, WRITE_FRAME, write + room);
  return room;
}

/**
 * Take up to `frameCount` frames into planar channel outputs.
 *
 * Returns how many frames were delivered.  Anything short is an underrun: the
 * caller fills the rest with silence and the shortfall is counted, so a
 * dropout is a number someone can look at rather than a noise someone has to
 * describe.
 */
export function readFrames(
  ring: Ring, out: Float32Array[], outOffset: number, frameCount: number,
): number {
  const read = Atomics.load(ring.control, READ_FRAME);
  const ready = Math.min(frameCount, Atomics.load(ring.control, WRITE_FRAME) - read);

  const { channels, capacityFrames, data } = ring;
  if (ready > 0) {
    const start = ((read % capacityFrames) + capacityFrames) % capacityFrames;
    for (let f = 0; f < ready; f++) {
      const slot = start + f;
      const base = (slot < capacityFrames ? slot : slot - capacityFrames) * channels;
      for (let c = 0; c < out.length; c++) {
        // A mono source feeds every output channel; a stereo source maps 1:1.
        const source = c < channels ? c : channels - 1;
        out[c]![outOffset + f] = data[base + source]!;
      }
    }
    Atomics.store(ring.control, READ_FRAME, read + ready);
  }

  const short = frameCount - ready;
  if (short > 0) {
    Atomics.add(ring.control, UNDERRUNS, short);
  }
  return ready;
}

/** Advance the read head without producing output — used to trim a preroll. */
export function skipFrames(ring: Ring, frameCount: number): number {
  const read = Atomics.load(ring.control, READ_FRAME);
  const ready = Math.min(frameCount, Atomics.load(ring.control, WRITE_FRAME) - read);
  if (ready > 0) Atomics.store(ring.control, READ_FRAME, read + ready);
  return ready;
}
