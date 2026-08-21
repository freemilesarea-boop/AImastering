// daw-stream.worklet.js - a clip that plays off disk.
//
// The node outputs one clip: silence until its start frame, then whatever the
// reader Worker has put in the ring, then silence again once the clip's
// duration is used up.  Placement is sample-accurate because the worklet
// counts frames from `currentFrame`, the same clock `AudioBufferSourceNode`
// schedules against - so a streamed clip lands on exactly the sample a
// resident one would have.
//
// The audio thread never allocates, never waits and never talks to disk.  Its
// whole job is to copy from the ring; if the ring is short it emits silence
// and counts the shortfall, because a late read must cost one quiet block, not
// a stalled render quantum.
//
// Kept in plain JS: AudioWorklet modules are fetched and compiled by the audio
// thread itself, so they are not part of the bundle.  The ring protocol here
// mirrors ring-buffer.ts, which is where it is explained and tested.

const READ_FRAME = 0;
const WRITE_FRAME = 1;
const UNDERRUNS = 3;

class StreamClipProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};

    this.control = new Int32Array(opts.control);
    this.data = new Float32Array(opts.data);
    this.capacityFrames = opts.capacityFrames | 0;
    this.channels = opts.channels | 0;

    // When to start, in the same frame clock `currentFrame` counts.
    this.startFrame = Math.round(opts.startFrame);
    // How many frames of this clip to play before going quiet for good.
    this.durationFrames = Math.round(opts.durationFrames);

    this.played = 0;
    this.done = false;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === 'stop') this.done = true;
    };
  }

  /** Copy `count` frames of the ring into the planar outputs at `offset`. */
  pull(output, offset, count) {
    const control = this.control;
    const read = Atomics.load(control, READ_FRAME);
    const ready = Math.min(count, Atomics.load(control, WRITE_FRAME) - read);
    const channels = this.channels;
    const capacity = this.capacityFrames;
    const data = this.data;

    if (ready > 0) {
      let slot = ((read % capacity) + capacity) % capacity;
      for (let f = 0; f < ready; f++) {
        const base = slot * channels;
        for (let c = 0; c < output.length; c++) {
          const source = c < channels ? c : channels - 1;
          output[c][offset + f] = data[base + source];
        }
        slot += 1;
        if (slot === capacity) slot = 0;
      }
      Atomics.store(control, READ_FRAME, read + ready);
    }

    const short = count - ready;
    if (short > 0) {
      // Silence, not a stall.  The reader is behind; the mix keeps its timing.
      for (let c = 0; c < output.length; c++) {
        output[c].fill(0, offset + ready, offset + count);
      }
      Atomics.add(control, UNDERRUNS, short);
    }
    return ready;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return !this.done;

    const blockFrames = output[0].length;
    for (let c = 0; c < output.length; c++) output[c].fill(0);

    if (this.done) return false;

    // Where this block sits relative to the clip's start.
    const blockStart = currentFrame;
    const offsetIntoClip = blockStart - this.startFrame;

    // Not yet: the clip begins later than this block ends.
    if (offsetIntoClip + blockFrames <= 0) return true;

    // Already finished: hold the node one more block so a fade tail on the
    // gain node downstream is not cut off, then retire.
    if (this.played >= this.durationFrames) {
      this.done = true;
      this.port.postMessage({ type: 'ended' });
      return false;
    }

    // A clip starting mid-block starts at the exact sample it should.
    const startInBlock = offsetIntoClip < 0 ? -offsetIntoClip : 0;
    const room = blockFrames - startInBlock;
    const remaining = this.durationFrames - this.played;
    const wanted = remaining < room ? remaining : room;
    if (wanted <= 0) return true;

    this.pull(output, startInBlock, wanted);
    this.played += wanted;
    return true;
  }
}

registerProcessor('daw-stream-clip', StreamClipProcessor);
